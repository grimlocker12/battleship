// Battleship LAN server
// Run with: node server.js
// Then have both kids open a browser to: http://<this-PC's-LAN-IP>:3000
//
// Configurable via environment variables (useful when running as a permanent
// service, e.g. in a TrueNAS jail): PORT, BATTLESHIP_SCORES_FILE

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const SHIP_DEFS = [
  { name: 'Carrier', size: 5 },
  { name: 'Battleship', size: 4 },
  { name: 'Cruiser', size: 3 },
  { name: 'Submarine', size: 3 },
  { name: 'Destroyer', size: 2 },
];
const BOARD_SIZE = 10;
const SCORES_FILE = process.env.BATTLESHIP_SCORES_FILE || path.join(__dirname, 'scores.json');

// ---- Never let this process die silently or take the whole service down ----
// When running as a permanently-installed service (e.g. a TrueNAS jail with
// daemon(8) -r), a crash means both kids lose their connection and have to
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
let scoreData = loadScores(); // { scores: { "Alice": 3, "Bob": 1 }, history: [{winner, loser, endedAt}, ...] }

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
function freshGame() {
  return {
    players: [null, null],
    names: [null, null],
    boards: [null, null],
    ships: [null, null],
    ready: [false, false],
    turn: 0,
    started: false,
    over: false,
    placementStarted: false,
  };
}

let game = freshGame();

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg, exceptIdx = -1) {
  game.players.forEach((ws, idx) => {
    if (idx !== exceptIdx) send(ws, msg);
  });
}

function emptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

function broadcastScoreboard() {
  const [n1, n2] = game.names;
  broadcast({
    type: 'scoreboard',
    names: game.names,
    scores: {
      p1: n1 ? (scoreData.scores[n1] || 0) : 0,
      p2: n2 ? (scoreData.scores[n2] || 0) : 0,
    },
    history: scoreData.history,
  });
}

function tryStartPlacement() {
  const bothConnected = game.players[0] && game.players[0].readyState === game.players[0].OPEN &&
                         game.players[1] && game.players[1].readyState === game.players[1].OPEN;
  const bothNamed = !!game.names[0] && !!game.names[1];
  if (bothConnected && bothNamed && !game.placementStarted) {
    game.placementStarted = true;
    game.boards = [emptyBoard(), emptyBoard()];
    game.ships = [[], []];
    broadcast({ type: 'startPlacement', shipDefs: SHIP_DEFS, boardSize: BOARD_SIZE, names: game.names });
  }
}

function resetGame() {
  const oldPlayers = game.players;
  const oldNames = game.names;
  game = freshGame();
  game.players = oldPlayers;
  game.names = oldNames;
  game.boards = [emptyBoard(), emptyBoard()];
  game.ships = [[], []];
  game.placementStarted = true;
  oldPlayers.forEach((ws) => {
    if (ws) send(ws, { type: 'startPlacement', shipDefs: SHIP_DEFS, boardSize: BOARD_SIZE, names: oldNames });
  });
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

wss.on('connection', (ws) => {
  const bothSlotsFull = game.players[0] && game.players[0].readyState === game.players[0].OPEN &&
                         game.players[1] && game.players[1].readyState === game.players[1].OPEN;
  if (bothSlotsFull) {
    send(ws, { type: 'full' });
    ws.close();
    return;
  }

  // Always 0 or 1: the bothSlotsFull check above already returned if both
  // slots were taken, so at least one is null or a stale/closed socket.
  const idx = game.players.findIndex(p => !p || p.readyState !== p.OPEN);
  game.players[idx] = ws;
  ws.playerIdx = idx;

  if (!game.boards[idx]) game.boards[idx] = emptyBoard();
  if (!game.ships[idx]) game.ships[idx] = [];

  send(ws, { type: 'welcome', player: idx + 1 });

  const otherConnected = game.players[idx === 0 ? 1 : 0] && game.players[idx === 0 ? 1 : 0].readyState === ws.OPEN;
  if (!otherConnected) {
    send(ws, { type: 'waiting' });
  }
  if (game.names[idx]) {
    // already named from a previous connection in this process lifetime (e.g. quick reconnect)
    broadcastScoreboard();
  }

  ws.on('message', (raw) => {
    try {
      handleMessage(ws, raw);
    } catch (err) {
      // Never let one bad message crash the whole server and disconnect both kids.
      console.error('Error handling message:', err);
      send(ws, { type: 'sessionExpired' });
    }
  });

  ws.on('close', () => {
    if (game.players[ws.playerIdx] === ws) {
      game.players[ws.playerIdx] = null;
      broadcast({ type: 'opponentDisconnected' }, ws.playerIdx);
      game = freshGame();
    }
  });
});

function handleMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const myIdx = ws.playerIdx;

    // If a fresh game/reset happened (e.g. the other player disconnected) since this
    // socket last got its player slot, it's no longer part of the active game.
    // Tell the client to reload rather than let a stale message crash anything.
    if (game.players[myIdx] !== ws) {
      send(ws, { type: 'sessionExpired' });
      return;
    }

    if (msg.type === 'setName') {
      let name = (msg.name || '').toString().trim().slice(0, 20);
      if (!name) name = 'Player ' + (myIdx + 1);
      game.names[myIdx] = name;
      send(ws, { type: 'nameAccepted', name });
      broadcastScoreboard();
      tryStartPlacement();
      return;
    }

    if (msg.type === 'place') {
      const board = game.boards[myIdx];
      if (!board) { send(ws, { type: 'sessionExpired' }); return; }
      // Trust SHIP_DEFS, not the client, for which ship/size this placement is
      // for — the client can only ever be placing the next unplaced ship.
      const shipIndex = game.ships[myIdx].length;
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
      const cells = validPlacement(board, row, col, shipDef.size, !!msg.horizontal);
      if (!cells) {
        send(ws, { type: 'placeRejected', reason: 'Invalid spot' });
        return;
      }
      cells.forEach(([r, c]) => { board[r][c] = shipIndex; });
      game.ships[myIdx].push({ name: shipDef.name, size: shipDef.size, cells, hits: 0 });
      send(ws, { type: 'placeAccepted', shipName: shipDef.name, cells });
      const otherIdx = myIdx === 0 ? 1 : 0;
      send(game.players[otherIdx], { type: 'opponentProgress', placed: game.ships[myIdx].length, total: SHIP_DEFS.length });
    }

    if (msg.type === 'clearPlacement') {
      game.boards[myIdx] = emptyBoard();
      game.ships[myIdx] = [];
      send(ws, { type: 'placementCleared' });
      const otherIdx = myIdx === 0 ? 1 : 0;
      send(game.players[otherIdx], { type: 'opponentProgress', placed: 0, total: SHIP_DEFS.length });
    }

    if (msg.type === 'ready') {
      if (!game.ships[myIdx] || game.ships[myIdx].length !== SHIP_DEFS.length) {
        send(ws, { type: 'placeRejected', reason: 'Place all ships first' });
        return;
      }
      game.ready[myIdx] = true;
      const otherIdx = myIdx === 0 ? 1 : 0;
      send(game.players[otherIdx], { type: 'opponentReady' });

      if (game.ready[0] && game.ready[1] && !game.started) {
        game.started = true;
        game.turn = 0;
        broadcast({ type: 'gameStart' });
        send(game.players[0], { type: 'yourTurn' });
        send(game.players[1], { type: 'opponentTurn' });
      }
    }

    if (msg.type === 'fire') {
      if (!game.started || game.over) return;
      if (game.turn !== myIdx) return;
      const otherIdx = myIdx === 0 ? 1 : 0;
      const board = game.boards[otherIdx];
      if (!board) { send(ws, { type: 'sessionExpired' }); return; }
      const row = Number(msg.row);
      const col = Number(msg.col);
      if (!Number.isInteger(row) || !Number.isInteger(col) ||
          row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return;
      const cellVal = board[row][col];

      let result = 'miss';
      let shipName = null;
      let sunk = false;
      let allSunk = false;

      if (cellVal !== null && cellVal !== 'hit' && cellVal !== 'miss') {
        const ship = game.ships[otherIdx][cellVal];
        ship.hits += 1;
        board[row][col] = 'hit';
        result = 'hit';
        shipName = ship.name;
        if (ship.hits >= ship.size) {
          sunk = true;
          allSunk = game.ships[otherIdx].every(s => s.hits >= s.size);
        }
      } else if (cellVal === null) {
        board[row][col] = 'miss';
      } else {
        return;
      }

      const resultMsg = { type: 'fireResult', row, col, result, shipName, sunk, by: myIdx + 1 };
      send(game.players[myIdx], resultMsg);
      send(game.players[otherIdx], resultMsg);

      if (allSunk) {
        game.over = true;
        const winnerName = game.names[myIdx];
        const loserName = game.names[otherIdx];
        scoreData.scores[winnerName] = (scoreData.scores[winnerName] || 0) + 1;
        scoreData.history.unshift({ winner: winnerName, loser: loserName, endedAt: new Date().toISOString() });
        scoreData.history = scoreData.history.slice(0, MAX_HISTORY);
        saveScores(scoreData);
        broadcast({ type: 'gameOver', winner: myIdx + 1, winnerName });
        broadcastScoreboard();
      } else {
        game.turn = otherIdx;
        send(game.players[myIdx], { type: 'opponentTurn' });
        send(game.players[otherIdx], { type: 'yourTurn' });
      }
    }

    if (msg.type === 'rematch') {
      game.ready = [false, false];
      resetGame();
    }
}

server.listen(PORT, () => {
  console.log('');
  console.log('  Battleship server running!');
  console.log('  On THIS machine, open: http://localhost:' + PORT);
  console.log('  On the OTHER PC, open: http://<this-host\'s-LAN-IP>:' + PORT);
  console.log('  Scoreboard file: ' + SCORES_FILE + ' (persists across restarts)');
  console.log('');
});
