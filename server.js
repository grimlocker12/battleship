// Battleship LAN server
// Run with: node server.js
// Then have 2-4 players open a browser to: http://<this-PC's-LAN-IP>:3000
//
// Configurable via environment variables (useful when running as a permanent
// service, e.g. in a TrueNAS jail): PORT, BATTLESHIP_SCORES_FILE

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 3000;
// How long a disconnected seat is held open for a reconnect before it's
// actually treated as gone (placement roster-shrink / battle elimination).
const GRACE_MS = parseInt(process.env.BATTLESHIP_GRACE_MS, 10) || 60000;
// How often we ping every client to detect dead connections that never sent
// a clean close frame (e.g. a Kubernetes NodePort's conntrack silently
// dropping an idle WebSocket after a few minutes of no traffic). Both
// constants are env-overridable so tests can shrink them.
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.BATTLESHIP_HEARTBEAT_MS, 10) || 30000;
const SHIP_DEFS = [
  { name: 'Carrier', size: 5 },
  { name: 'Battleship', size: 4 },
  { name: 'Cruiser', size: 3 },
  { name: 'Submarine', size: 3 },
  { name: 'Destroyer', size: 2 },
];
const BOARD_SIZE = 10;
const MAX_SEATS = 4;
const MIN_TO_START = 2;
const SCORES_FILE = process.env.BATTLESHIP_SCORES_FILE || path.join(__dirname, 'scores.json');

// ---- Never let this process die silently or take the whole service down ----
// When running as a permanently-installed service (e.g. a TrueNAS jail with
// daemon(8) -r), a crash means everyone loses their connection and has to
// reload. These handlers make sure that only ever happens for truly fatal
// problems, and logs everything else instead of dying.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server keeps running):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (server keeps running):', err);
});
function shutdown(signal) {
  console.log(`Received ${signal}, shutting down cleanly...`);
  clearInterval(heartbeatInterval);
  server.close(() => process.exit(0));
  // Force-exit if close() hangs for some reason.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---- Persistent scoreboard (survives server restarts / new sessions) ----
const MAX_HISTORY = 10;
function loadScores() {
  try {
    const raw = JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && raw.scores) {
      return { scores: raw.scores, history: Array.isArray(raw.history) ? raw.history : [] };
    }
    // Old file format was a flat { name: count } map, pre-dating match
    // history. Treat it as the scores half of the new shape.
    return { scores: (raw && typeof raw === 'object') ? raw : {}, history: [] };
  } catch {
    return { scores: {}, history: [] };
  }
}
function saveScores(data) {
  try {
    fs.writeFileSync(SCORES_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Could not save scores.json:', e.message);
  }
}
// { scores: { "Alice": 3, "Bob": 1 }, history: [{winner, players, endedAt}, ...] }
let scoreData = loadScores();

// ---- Simple static file server for the client page ----
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  let urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try {
    urlPath = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  // path.join() collapses any "../" segments, but the result can still land
  // outside PUBLIC_DIR (e.g. a request for "/../server.js") — reject those
  // instead of serving whatever file it resolved to.
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/plain';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// ---- Game state ----
// One "room" for the whole server (matches the original 2-player design's
// scope — this is a LAN party-game server, not a matchmaking service).
//
// game.seats: up to MAX_SEATS entries, each either null (empty) or
//   { ws, name, board, ships, ready, alive, token, graceTimer }. Seat index
//   is stable for the life of one game. `token` is a persistent per-seat id
//   (survives placement -> battle -> rematch) that lets a reconnecting
//   browser prove which seat is theirs. `graceTimer` is non-null only while
//   a seat is disconnected-but-still-within-its-reconnect-window (see
//   GRACE_MS) -- the seat isn't actually torn down until that timer fires.
// game.roster: seat indices dealt into the current/most-recent game, fixed
//   once placement begins (used for ready-checks and history/score records
//   even if a seat's ws later goes null on a battle-phase disconnect).
// game.turnOrder: seat indices still "in" the battle (not eliminated),
//   in current turn-rotation order. game.turnPtr indexes into it.
function freshGame() {
  return {
    phase: 'lobby', // 'lobby' | 'placement' | 'battle' | 'over'
    seats: Array(MAX_SEATS).fill(null),
    roster: [],
    turnOrder: [],
    turnPtr: 0,
    round: 0,
    shuffleEachRound: false, // true only when the game started with exactly 3 players
  };
}

let game = freshGame();

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg, exceptIdx = -1) {
  game.seats.forEach((seat, idx) => {
    if (seat && idx !== exceptIdx) send(seat.ws, msg);
  });
}

function makeToken() {
  return crypto.randomUUID();
}

// The only place a seat's grace timer is ever cleared -- keeping every clear
// site funneled through one helper means it can't drift/leak.
function clearGrace(seat) {
  if (seat && seat.graceTimer) {
    clearTimeout(seat.graceTimer);
    seat.graceTimer = null;
  }
}

function hasAnyLiveConnection() {
  return game.seats.some((s) => s && s.ws && s.ws.readyState === s.ws.OPEN);
}

function hasAnyPendingGrace() {
  return game.seats.some((s) => s && s.graceTimer);
}

// Safety net: if the room is ever stuck outside the lobby with nobody
// actually connected and nobody who might still reconnect, just start a
// fresh lobby instead of staying wedged forever (which used to require a
// manual restart -- see HANDOFF.md).
function maybeAutoResetToLobby() {
  if (game.phase !== 'lobby' && !hasAnyLiveConnection() && !hasAnyPendingGrace()) {
    game = freshGame();
  }
}

function safeParseToken(url) {
  try {
    return new URL(url, 'http://internal').searchParams.get('token');
  } catch {
    return null;
  }
}

// Wires up the message/close/pong handlers a socket needs, whether it's a
// brand-new connection or one that just reclaimed an existing seat.
function attachSocketHandlers(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      handleMessage(ws, raw);
    } catch (err) {
      // Never let one bad message crash the whole server and disconnect everyone.
      console.error('Error handling message:', err);
      send(ws, { type: 'sessionExpired' });
    }
  });

  ws.on('close', () => {
    const seat = game.seats[ws.seatIdx];
    if (!seat || seat.ws !== ws) return; // stale socket, already replaced/cleared

    if (game.phase === 'lobby') {
      game.seats[ws.seatIdx] = null;
      broadcastLobby();
    } else if (game.phase === 'placement' || game.phase === 'battle') {
      // Don't tear the seat down immediately -- hold it for GRACE_MS in case
      // this was a brief WiFi blip / refresh / backgrounded tab, and let a
      // reconnect with the same token slot right back in.
      seat.ws = null;
      broadcast({ type: 'opponentConnectionLost', seatIdx: ws.seatIdx, name: seat.name, graceMs: GRACE_MS });
      const seatIdx = ws.seatIdx;
      seat.graceTimer = setTimeout(() => onGraceExpired(seatIdx), GRACE_MS);
    }
    // phase === 'over': nothing to do here; rematch recomputes who's still
    // connected by checking each seat's live socket state.
    maybeAutoResetToLobby();
  });
}

// Runs the actual disconnect fallout -- exactly what used to happen
// immediately on close -- once a seat's reconnect grace window expires with
// nobody having claimed it back.
function onGraceExpired(seatIdx) {
  const seat = game.seats[seatIdx];
  if (!seat || !seat.graceTimer) return; // already reconnected or otherwise cleared
  clearGrace(seat);

  if (game.phase === 'placement') {
    const name = seat.name;
    game.seats[seatIdx] = null;
    game.roster = game.roster.filter((i) => i !== seatIdx);
    broadcast({ type: 'opponentDisconnected', seatIdx, name });
    if (game.roster.length < MIN_TO_START) {
      // Not a viable game anymore -- bounce whoever's left back to the
      // lobby (same Start-game screen, not a hard reload).
      game.roster.forEach((i) => {
        const s = game.seats[i];
        if (s) { s.board = null; s.ships = []; s.ready = false; }
      });
      game.phase = 'lobby';
      game.roster = [];
      broadcast({ type: 'placementAborted', reason: 'Not enough players left' });
      broadcastLobby();
    } else if (game.roster.every((i) => game.seats[i] && game.seats[i].ready)) {
      // Everyone who's left had already readied up.
      beginBattle();
    }
  } else if (game.phase === 'battle') {
    // Keep the seat object (name/board) around instead of nulling it, so
    // history/winner lookups and the eventual gameOver broadcast can still
    // read their name -- only the dead socket reference goes away.
    const ended = eliminateSeat(seatIdx, 'disconnected');
    if (!ended) announceTurn();
  }

  maybeAutoResetToLobby();
}

function emptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function namedSeatIndices() {
  const result = [];
  game.seats.forEach((s, i) => { if (s && s.name) result.push(i); });
  return result;
}

function broadcastLobby() {
  const seatsInfo = game.seats.map((s, i) => (s ? { seatIdx: i, name: s.name } : null));
  broadcast({
    type: 'lobbyUpdate',
    seats: seatsInfo,
    canStart: namedSeatIndices().length >= MIN_TO_START,
    maxSeats: MAX_SEATS,
  });
}

function broadcastScoreboard() {
  const players = game.seats
    .map((s, i) => (s && s.name) ? { seatIdx: i, name: s.name, score: scoreData.scores[s.name] || 0 } : null)
    .filter(Boolean);
  broadcast({ type: 'scoreboard', players, history: scoreData.history });
}

function validPlacement(board, row, col, size, horizontal) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    const r = horizontal ? row : row + i;
    const c = horizontal ? col + i : col;
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return null;
    if (board[r][c] !== null) return null;
    cells.push([r, c]);
  }
  return cells;
}

// Sends startPlacement to exactly the given seats and locks them in as
// game.roster. Used both for the initial lobby -> placement transition and
// for a rematch (which skips the lobby and reuses whoever's still connected).
function beginPlacement(seatIdxs) {
  seatIdxs.forEach((i) => {
    const seat = game.seats[i];
    clearGrace(seat); // defensive; shouldn't be pending here, cheap insurance
    seat.board = emptyBoard();
    seat.ships = [];
    seat.ready = false;
    seat.alive = true;
  });
  game.roster = seatIdxs;
  game.phase = 'placement';
  const players = seatIdxs.map((i) => ({ seatIdx: i, name: game.seats[i].name }));
  seatIdxs.forEach((i) => {
    send(game.seats[i].ws, { type: 'startPlacement', shipDefs: SHIP_DEFS, boardSize: BOARD_SIZE, players });
  });
}

function tryAutoStart() {
  if (game.phase !== 'lobby') return;
  const named = namedSeatIndices();
  if (named.length === MAX_SEATS) beginPlacement(named);
}

function startNewRound() {
  game.round += 1;
  if (game.shuffleEachRound) game.turnOrder = shuffle(game.turnOrder);
}

function activeSeatIdx() {
  return game.turnOrder[game.turnPtr];
}

function announceTurn() {
  const activeIdx = activeSeatIdx();
  const activeSeat = game.seats[activeIdx];
  const targets = game.turnOrder
    .filter((i) => i !== activeIdx)
    .map((i) => ({ seatIdx: i, name: game.seats[i].name }));
  send(activeSeat.ws, { type: 'yourTurn', targets });
  game.roster.forEach((i) => {
    if (i !== activeIdx && game.seats[i]) {
      send(game.seats[i].ws, { type: 'opponentTurn', activeSeat: activeIdx, activeName: activeSeat.name });
    }
  });
}

function beginBattle() {
  game.phase = 'battle';
  game.round = 0;
  game.turnOrder = game.roster.slice();
  game.shuffleEachRound = (game.roster.length === 3);
  if (game.shuffleEachRound) game.turnOrder = shuffle(game.turnOrder);
  game.turnPtr = 0;
  const players = game.roster.map((i) => ({ seatIdx: i, name: game.seats[i].name }));
  broadcast({ type: 'gameStart', players });
  announceTurn();
}

function advanceTurn() {
  game.turnPtr = (game.turnPtr + 1) % game.turnOrder.length;
  if (game.turnPtr === 0) startNewRound();
}

function recordWin(winnerSeatIdx) {
  const winnerName = game.seats[winnerSeatIdx].name;
  const players = game.roster.map((i) => game.seats[i] && game.seats[i].name).filter(Boolean);
  scoreData.scores[winnerName] = (scoreData.scores[winnerName] || 0) + 1;
  scoreData.history.unshift({ winner: winnerName, players, endedAt: new Date().toISOString() });
  scoreData.history = scoreData.history.slice(0, MAX_HISTORY);
  saveScores(scoreData);
}

// Removes a seat from the active turn rotation, whether they were sunk or
// they disconnected. Shared by both callers so the turn-pointer bookkeeping
// can't drift between the two paths. Returns true if this ended the game.
function eliminateSeat(seatIdx, reason) {
  const seat = game.seats[seatIdx];
  const name = seat ? seat.name : null;
  if (seat) seat.alive = false;
  // A seat can be eliminated by being sunk while it's separately mid-grace
  // from an unrelated disconnect -- clear that timer so it can't later fire
  // against this (possibly already-reused) seat slot.
  if (seat) clearGrace(seat);

  const pos = game.turnOrder.indexOf(seatIdx);
  if (pos !== -1) {
    game.turnOrder.splice(pos, 1);
    // If the removed seat was earlier in the order than the current pointer,
    // shift the pointer left to keep pointing at the same logical player.
    // If it *was* the current pointer (only possible when the active player
    // disconnects on their own turn), leave the pointer alone — after the
    // splice it already lands on the correct next player.
    if (pos < game.turnPtr) game.turnPtr -= 1;
  }

  broadcast({ type: 'playerEliminated', seatIdx, name, reason });

  if (game.turnOrder.length <= 1) {
    game.phase = 'over';
    const winnerIdx = game.turnOrder[0];
    if (winnerIdx !== undefined && game.seats[winnerIdx]) {
      recordWin(winnerIdx);
      broadcast({ type: 'gameOver', winnerSeat: winnerIdx, winnerName: game.seats[winnerIdx].name });
      broadcastScoreboard();
    }
    return true;
  }

  // The active-player-disconnected-while-last-in-order case can leave the
  // pointer pointing past the end of the (now shorter) array.
  if (game.turnPtr >= game.turnOrder.length) {
    game.turnPtr = 0;
    startNewRound();
  }

  if (reason === 'sunk' && seat && seat.ws) {
    send(seat.ws, { type: 'spectating', message: 'Your fleet has been sunk! Watch the rest of the battle.' });
  }

  return false;
}

// Builds the state a reconnecting client needs to rebuild its UI without a
// reload. Board contents are redacted for every seat except the reconnecting
// player's own -- server stays authoritative, never leaks unsunk ship
// positions (matches the same principle the live fireResult broadcasts
// already follow).
function buildReconnectedPayload(seatIdx) {
  const seat = game.seats[seatIdx];
  const players = game.roster.map((i) => ({ seatIdx: i, name: game.seats[i] && game.seats[i].name }));
  const base = { type: 'reconnected', seatIdx, token: seat.token, name: seat.name, phase: game.phase, players };

  if (game.phase === 'placement') {
    const opponentProgress = game.roster
      .filter((i) => i !== seatIdx)
      .map((i) => ({ seatIdx: i, placed: game.seats[i].ships.length, total: SHIP_DEFS.length }));
    return {
      ...base,
      shipDefs: SHIP_DEFS,
      boardSize: BOARD_SIZE,
      placedShips: seat.ships.map((s) => ({ name: s.name, cells: s.cells })),
      ready: seat.ready,
      opponentProgress,
    };
  }

  if (game.phase === 'battle') {
    const boards = {};
    game.roster.forEach((i) => {
      const s = game.seats[i];
      if (!s) return;
      const cells = s.board.map((row) => row.map((v) => (v === 'hit' || v === 'miss' ? v : null)));
      const sunkShips = s.ships.filter((sh) => sh.hits >= sh.size).map((sh) => ({ name: sh.name, cells: sh.cells }));
      boards[i] = { cells, sunkShips };
    });
    const activeIdx = activeSeatIdx();
    const isMyTurn = activeIdx === seatIdx && seat.alive;
    return {
      ...base,
      placedShips: seat.ships.map((s) => ({ name: s.name, cells: s.cells })),
      boards,
      eliminatedSeats: game.roster.filter((i) => game.seats[i] && !game.seats[i].alive),
      myTurnState: {
        activeSeatIdx: activeIdx,
        isYourTurn: isMyTurn,
        targets: game.turnOrder
          .filter((i) => i !== activeIdx)
          .map((i) => ({ seatIdx: i, name: game.seats[i].name })),
      },
      spectator: !seat.alive,
    };
  }

  return base;
}

wss.on('connection', (ws, req) => {
  const token = safeParseToken(req.url);

  if (token && (game.phase === 'placement' || game.phase === 'battle')) {
    // Reconnect is only meaningful during these two phases -- 'lobby' seats
    // are freed immediately on close (nothing to reclaim), and 'over' is
    // handled entirely by the existing rematch/readyState logic below, not
    // by token matching (its stale seat.ws is deliberately left untouched,
    // see the close handler, so it must never be treated as reclaimable).
    const idx = game.seats.findIndex((s) => s && s.token === token &&
      (s.graceTimer || !s.ws || s.ws.readyState !== s.ws.OPEN));
    if (idx !== -1) {
      const seat = game.seats[idx];
      if (seat.ws && seat.ws !== ws) {
        try { seat.ws.terminate(); } catch { /* already dead */ }
      }
      clearGrace(seat); // synchronous, no await before this -- can't race the timer
      seat.ws = ws;
      ws.seatIdx = idx;
      attachSocketHandlers(ws);
      send(ws, buildReconnectedPayload(idx));
      broadcast({ type: 'opponentReconnected', seatIdx: idx, name: seat.name }, idx);
      broadcastScoreboard();
      return;
    }
    // Token present but nothing reclaimable (already expired, game moved on,
    // or unknown) -- fall through to the normal new-connection flow below.
  }

  if (game.phase !== 'lobby') {
    send(ws, { type: 'gameInProgress' });
    ws.close();
    return;
  }

  const idx = game.seats.findIndex((s) => s === null);
  if (idx === -1) {
    send(ws, { type: 'full' });
    ws.close();
    return;
  }

  game.seats[idx] = { ws, name: null, board: null, ships: [], ready: false, alive: true, token: makeToken(), graceTimer: null };
  ws.seatIdx = idx;
  attachSocketHandlers(ws);

  send(ws, { type: 'welcome', seatIdx: idx, token: game.seats[idx].token });
  broadcastLobby();
});

// ---- Heartbeat: catch connections that die without a clean close frame ----
// (e.g. a Kubernetes NodePort's conntrack silently dropping an idle
// WebSocket). ws.terminate() fires the same 'close' event a clean disconnect
// would, so it flows through the normal grace-period logic above with no
// special-casing.
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const myIdx = ws.seatIdx;

  // If this socket's seat has been cleared or reassigned since it last held
  // it (room reset, kicked back to lobby, etc.), tell the client to reload
  // rather than let a stale message touch state it's no longer part of.
  if (!game.seats[myIdx] || game.seats[myIdx].ws !== ws) {
    send(ws, { type: 'sessionExpired' });
    return;
  }
  const seat = game.seats[myIdx];

  if (msg.type === 'setName') {
    if (game.phase !== 'lobby') { send(ws, { type: 'sessionExpired' }); return; }
    let name = (msg.name || '').toString().trim().slice(0, 20);
    if (!name) name = 'Player ' + (myIdx + 1);
    seat.name = name;
    send(ws, { type: 'nameAccepted', name });
    broadcastLobby();
    tryAutoStart();
    return;
  }

  if (msg.type === 'startGame') {
    if (game.phase !== 'lobby') {
      send(ws, { type: 'startRejected', reason: 'Game already started' });
      return;
    }
    const named = namedSeatIndices();
    if (named.length < MIN_TO_START) {
      send(ws, { type: 'startRejected', reason: 'Need at least 2 players to start' });
      return;
    }
    beginPlacement(named);
    return;
  }

  if (msg.type === 'place') {
    if (game.phase !== 'placement' || !seat.board) { send(ws, { type: 'sessionExpired' }); return; }
    // Trust SHIP_DEFS, not the client, for which ship/size this placement is
    // for — the client can only ever be placing the next unplaced ship.
    const shipIndex = seat.ships.length;
    const shipDef = SHIP_DEFS[shipIndex];
    if (!shipDef) {
      send(ws, { type: 'placeRejected', reason: 'All ships already placed' });
      return;
    }
    const row = Number(msg.row);
    const col = Number(msg.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) {
      send(ws, { type: 'placeRejected', reason: 'Invalid spot' });
      return;
    }
    const cells = validPlacement(seat.board, row, col, shipDef.size, !!msg.horizontal);
    if (!cells) {
      send(ws, { type: 'placeRejected', reason: 'Invalid spot' });
      return;
    }
    cells.forEach(([r, c]) => { seat.board[r][c] = shipIndex; });
    seat.ships.push({ name: shipDef.name, size: shipDef.size, cells, hits: 0 });
    send(ws, { type: 'placeAccepted', shipName: shipDef.name, cells });
    broadcast({ type: 'opponentProgress', seatIdx: myIdx, placed: seat.ships.length, total: SHIP_DEFS.length }, myIdx);
    return;
  }

  if (msg.type === 'clearPlacement') {
    if (game.phase !== 'placement') return;
    seat.board = emptyBoard();
    seat.ships = [];
    send(ws, { type: 'placementCleared' });
    broadcast({ type: 'opponentProgress', seatIdx: myIdx, placed: 0, total: SHIP_DEFS.length }, myIdx);
    return;
  }

  if (msg.type === 'ready') {
    if (game.phase !== 'placement') return;
    if (!seat.ships || seat.ships.length !== SHIP_DEFS.length) {
      send(ws, { type: 'placeRejected', reason: 'Place all ships first' });
      return;
    }
    seat.ready = true;
    broadcast({ type: 'opponentReady', seatIdx: myIdx }, myIdx);
    // Don't start a battle with a seat that's currently mid-grace (dropped,
    // might still reconnect) -- if it turns out they never come back,
    // onGraceExpired's own beginBattle() check picks this up once they're
    // actually removed.
    if (game.roster.every((i) => game.seats[i] && game.seats[i].ready) &&
        !game.roster.some((i) => game.seats[i] && game.seats[i].graceTimer)) {
      beginBattle();
    }
    return;
  }

  if (msg.type === 'fire') {
    if (game.phase !== 'battle') return;
    if (activeSeatIdx() !== myIdx) return;
    const targetSeatIdx = Number(msg.targetSeat);
    if (!Number.isInteger(targetSeatIdx) || targetSeatIdx === myIdx || !game.turnOrder.includes(targetSeatIdx)) return;
    const targetSeat = game.seats[targetSeatIdx];
    if (!targetSeat || !targetSeat.board) { send(ws, { type: 'sessionExpired' }); return; }
    const row = Number(msg.row);
    const col = Number(msg.col);
    if (!Number.isInteger(row) || !Number.isInteger(col) ||
        row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return;
    const board = targetSeat.board;
    const cellVal = board[row][col];

    let result = 'miss';
    let shipName = null;
    let sunk = false;

    if (cellVal !== null && cellVal !== 'hit' && cellVal !== 'miss') {
      const ship = targetSeat.ships[cellVal];
      ship.hits += 1;
      board[row][col] = 'hit';
      result = 'hit';
      shipName = ship.name;
      if (ship.hits >= ship.size) sunk = true;
    } else if (cellVal === null) {
      board[row][col] = 'miss';
    } else {
      return; // already hit/missed this cell, ignore
    }

    broadcast({ type: 'fireResult', by: myIdx, target: targetSeatIdx, row, col, result, shipName, sunk });

    const allSunk = sunk && targetSeat.ships.every((s) => s.hits >= s.size);
    if (allSunk) {
      const ended = eliminateSeat(targetSeatIdx, 'sunk');
      if (ended) return; // gameOver already broadcast inside eliminateSeat
    }

    advanceTurn();
    announceTurn();
    return;
  }

  if (msg.type === 'rematch') {
    if (game.phase !== 'over') return;
    const survivors = [];
    game.seats.forEach((s, i) => { if (s && s.ws && s.ws.readyState === s.ws.OPEN) survivors.push(i); });
    game.seats.forEach((s, i) => {
      if (s && !survivors.includes(i)) {
        clearGrace(s); // a still-pending grace timer here is stale -- this game is over
        game.seats[i] = null;
      }
    });

    if (survivors.length < MIN_TO_START) {
      game.phase = 'lobby';
      game.roster = [];
      broadcastLobby();
      return;
    }
    survivors.forEach((i) => { game.seats[i].ready = false; game.seats[i].alive = true; });
    beginPlacement(survivors);
    return;
  }
}

server.listen(PORT, () => {
  console.log('');
  console.log('  Battleship server running!');
  console.log('  On THIS machine, open: http://localhost:' + PORT);
  console.log('  On OTHER PCs, open: http://<this-host\'s-LAN-IP>:' + PORT);
  console.log('  Up to ' + MAX_SEATS + ' players per game.');
  console.log('  Scoreboard file: ' + SCORES_FILE + ' (persists across restarts)');
  console.log('');
});
