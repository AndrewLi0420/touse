const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { networkInterfaces } = require('os');

const BID_STEP = 25;
const SINGLE_INIT = 1613.80;
const DOUBLE_INIT = 2151.70;

const ROOMS = [
  { id: 'double', name: 'Downstairs Double',      slots: 1, init: DOUBLE_INIT, pool: 'double' },
  { id: 'first',  name: 'First Floor Single',      slots: 1, init: SINGLE_INIT, pool: 'single' },
  { id: 'sf1',    name: 'Second Floor Single 1',   slots: 1, init: SINGLE_INIT, pool: 'single' },
  { id: 'sf2',    name: 'Second Floor Single 2',   slots: 1, init: SINGLE_INIT, pool: 'single' },
  { id: 'sf3',    name: 'Second Floor Piano Room', slots: 1, init: SINGLE_INIT, pool: 'single' },
  { id: 'sf4',    name: 'First Floor Double',      slots: 1, init: DOUBLE_INIT, pool: 'double' },
  { id: 'sfb',    name: 'Second Floor Balcony',    slots: 1, init: SINGLE_INIT, pool: 'single' },
  { id: 'adu1',   name: 'ADU Room 1',              slots: 1, init: SINGLE_INIT, pool: 'single' },
  { id: 'adu2',   name: 'ADU Room 2',              slots: 1, init: SINGLE_INIT, pool: 'single' },
];

const COLORS = [
  '#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c',
  '#3498db','#9b59b6','#e91e63','#ff5722','#00bcd4',
];

let colorIdx = 0;

function initState() {
  return {
    prices: Object.fromEntries(ROOMS.map(r => [r.id, r.init])),
    claims: Object.fromEntries(ROOMS.map(r => [r.id, []])),
    history: [],
    users: {},
  };
}

let state = initState();
let resetLog = [];

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/rooms/')) {
    const safe = path.basename(req.url.slice(7));
    fs.readFile(path.join(__dirname, 'rooms', safe), (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(data);
    });
    return;
  }
  fs.readFile(__dirname + '/index.html', (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

function broadcastAll(msg) {
  const s = JSON.stringify(msg);
  wss.clients.forEach(c => c.readyState === 1 && c.send(s));
}

function publicState() {
  const combined = [...state.history, ...resetLog].sort((a, b) => b.ts - a.ts);
  return {
    prices: state.prices,
    claims: state.claims,
    history: combined.slice(0, 60),
    users: Object.fromEntries(
      Object.entries(state.users).map(([id, u]) => [id, { id, name: u.name, color: u.color }])
    ),
  };
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, userId, name, roomId } = msg;
    if (!userId) return;

    if (type === 'join') {
      if (!state.users[userId]) {
        state.users[userId] = { id: userId, name, color: COLORS[colorIdx++ % COLORS.length] };
      } else {
        const oldName = state.users[userId].name;
        state.users[userId].name = name;
        if (oldName !== name) {
          ROOMS.forEach(r => {
            state.claims[r.id] = state.claims[r.id].map(c =>
              c.userId === userId ? { ...c, name } : c
            );
          });
          state.history = state.history.map(h => h.userId === userId ? { ...h, name } : h);
        }
      }
      ws.userId = userId;
      ws.send(JSON.stringify({ type: 'welcome', color: state.users[userId].color, state: publicState() }));
      broadcastAll({ type: 'state', state: publicState() });
      return;
    }

    const user = state.users[userId];
    if (!user) return;

    if (type === 'claim') {
      const room = ROOMS.find(r => r.id === roomId);
      if (!room) return;
      if (state.claims[roomId].some(c => c.userId === userId)) return;
      if (state.claims[roomId].length >= room.slots) return;
      // Block if user is locked in elsewhere via a bid
      const lockedRoom = ROOMS.find(r => r.id !== roomId && state.claims[r.id].some(c => c.userId === userId && c.via === 'bid'));
      if (lockedRoom) return;
      ROOMS.forEach(r => { state.claims[r.id] = state.claims[r.id].filter(c => c.userId !== userId); });
      state.claims[roomId].push({ userId, name: user.name, color: user.color, via: 'claim' });
      state.history.unshift({ userId, name: user.name, roomId, action: 'claim', ts: Date.now() });
      broadcastAll({ type: 'state', state: publicState() });
      return;
    }

    if (type === 'release') {
      const entry = (state.claims[roomId] || []).find(c => c.userId === userId);
      if (!entry || entry.via === 'bid') return; // can't release a bid
      state.claims[roomId] = state.claims[roomId].filter(c => c.userId !== userId);
      state.history.unshift({ userId, name: user.name, roomId, action: 'release', ts: Date.now() });
      broadcastAll({ type: 'state', state: publicState() });
      return;
    }

    if (type === 'bid') {
      const room = ROOMS.find(r => r.id === roomId);
      if (!room) return;
      if (state.claims[roomId].some(c => c.userId === userId)) return;
      // Block if user is locked in elsewhere via a bid
      const lockedRoom = ROOMS.find(r => r.id !== roomId && state.claims[r.id].some(c => c.userId === userId && c.via === 'bid'));
      if (lockedRoom) return;

      // Fixed rooms (ADUs) never change; doubles and singles each bid within their own pool
      if (!room.fixed) {
        const poolRooms = ROOMS.filter(r => r.pool === room.pool);
        const dec = BID_STEP / (poolRooms.length - 1);
        poolRooms.forEach(r => { state.prices[r.id] += r.id === roomId ? BID_STEP : -dec; });
      }

      // Move bidder into this room, evicting the earliest claimer if full
      ROOMS.forEach(r => { state.claims[r.id] = state.claims[r.id].filter(c => c.userId !== userId); });
      if (state.claims[roomId].length >= room.slots) state.claims[roomId].shift();
      state.claims[roomId].push({ userId, name: user.name, color: user.color, via: 'bid' });

      state.history.unshift({ userId, name: user.name, roomId, action: 'bid', ts: Date.now() });
      broadcastAll({ type: 'state', state: publicState() });
      return;
    }

    if (type === 'reset') {
      resetLog.push({ userId, name: user.name, action: 'reset', ts: Date.now() });
      state = initState();
      colorIdx = 0;
      broadcastAll({ type: 'state', state: publicState() });
    }
  });
});

server.listen(3000, '0.0.0.0', () => {
  let ip = 'localhost';
  outer: for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) { ip = iface.address; break outer; }
    }
  }
  console.log('\nRent Bidder running');
  console.log('  Local:   http://localhost:3000');
  console.log(`  Network: http://${ip}:3000`);
  console.log('\nShare the Network URL with roommates on the same WiFi.\n');
});
