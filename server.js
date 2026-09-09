const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));
// SPA fallback for any non-socket route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------- Game state ----------------
const rooms = new Map(); // code -> room

const ROLE_POINTS = { raja: 1000, mantri: 800, sipahi: 500, chor: 0 };
const REVEAL_SECONDS = 7;
const GUESS_SECONDS = 30;
const CHAT_MAXLEN = 300;
const CHAT_HISTORY = 50;
const BOT_NAMES = ['Chintu 🤖', 'Bunty 🤖', 'Guddu 🤖', 'Pinki 🤖', 'Monty 🤖'];
// No hard round cap anymore — host picks any 1..MAX_ROUNDS, or 0 = ♾️ endless.
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 500;

// totalRounds: positive int = fixed length, 0 = endless (host ends manually)
function parseTotalRounds(v, fallback = 5) {
  if (v === 0 || v === '0') return 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['endless', 'inf', 'infinity', '∞', 'unlimited'].includes(s)) return 0;
  }
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0; // treat 0/negative as endless request via UI checkbox; plain negatives fall back
  return Math.min(MAX_ROUNDS, Math.max(MIN_ROUNDS, n));
}

function formatRounds(totalRounds) {
  return totalRounds === 0 ? '♾️ endless' : `${totalRounds} round${totalRounds === 1 ? '' : 's'}`;
}

function isLastRound(room) {
  return room.totalRounds > 0 && room.currentRound >= room.totalRounds;
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[randInt(chars.length)];
  if (rooms.has(code)) return genCode();
  return code;
}

// Cryptographically-strong random int in [0, max)
function randInt(max) {
  return crypto.randomInt(max);
}

function pickRandom(arr) {
  return arr[randInt(arr.length)];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Deal chits so nobody gets the same role two rounds in a row (whenever
// possible). Pure Math.random() streaks made repeats feel rigged, so we
// re-shuffle until the deal differs from last round for every seated player.
function dealRoles(room) {
  const base = ['raja', 'mantri', 'chor', 'sipahi'];
  let best = shuffle(base);
  let bestRepeats = countRepeats(room, best);
  for (let t = 1; t < 60 && bestRepeats > 0; t++) {
    const s = shuffle(base);
    const r = countRepeats(room, s);
    if (r < bestRepeats) { best = s; bestRepeats = r; }
  }
  const roles = {};
  room.players.forEach((p, i) => { roles[p.id] = best[i]; });
  room.lastRoles = roles;
  return roles;
}

function countRepeats(room, deal) {
  if (!room.lastRoles) return 0;
  let n = 0;
  room.players.forEach((p, i) => {
    if (room.lastRoles[p.id] === deal[i]) n++;
  });
  return n;
}

function publicPlayers(room) {
  return room.players.map(p => ({
    id: p.id, name: p.name, isBot: p.isBot,
    score: p.score, connected: p.connected !== false,
    isHost: p.id === room.hostId
  }));
}

function broadcastLobby(room) {
  io.to(room.code).emit('roomUpdate', {
    code: room.code,
    players: publicPlayers(room),
    hostId: room.hostId,
    status: room.status,
    totalRounds: room.totalRounds,
    currentRound: room.currentRound
  });
}

function broadcastPublicRooms() {
  const list = [...rooms.values()]
    .filter(r => r.status === 'lobby' && r.players.filter(p => !p.isBot).length < 4)
    .map(r => ({
      code: r.code,
      humans: r.players.filter(p => !p.isBot).length,
      bots: r.players.filter(p => p.isBot).length,
      totalRounds: r.totalRounds,
      host: (r.players.find(p => p.id === r.hostId) || {}).name || '—'
    }));
  io.emit('publicRooms', list);
}

// ---- Room chat (in-memory, last CHAT_HISTORY messages per room) ----
function pushChat(room, msg) {
  room.messages.push(msg);
  if (room.messages.length > CHAT_HISTORY) room.messages.splice(0, room.messages.length - CHAT_HISTORY);
  io.to(room.code).emit('chatMsg', msg);
}

function sysMsg(room, text) {
  pushChat(room, { id: 'm_' + Date.now().toString(36) + randInt(1296).toString(36), sys: true, text, ts: Date.now() });
}

// Room-wide alert: chat sys message + loud playerEvent (toast + sound on clients).
// Used for joins / leaves / bot join-remove so nobody misses them even with chat closed.
function announce(room, type, text) {
  sysMsg(room, text);
  io.to(room.code).emit('playerEvent', { type, text, ts: Date.now() });
}

function clearTimers(room) {
  if (room.revealTimer) { clearTimeout(room.revealTimer); room.revealTimer = null; }
  if (room.guessTimer) { clearTimeout(room.guessTimer); room.guessTimer = null; }
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
}

function startRound(room) {
  clearTimers(room);
  room.status = 'reveal';
  room.currentRound += 1;

  // deal chits fairly: crypto-shuffled, nobody repeats last round's role
  room.roles = dealRoles(room);
  room.guess = null;
  room.result = null;

  const sipahi = room.players.find(p => room.roles[p.id] === 'sipahi');

  // send each human their private role
  room.players.forEach(p => {
    if (p.isBot) return;
    const sock = io.sockets.sockets.get(p.socketId);
    if (!sock) return;
    sock.emit('roundStarted', {
      round: room.currentRound,
      totalRounds: room.totalRounds,
      myRole: room.roles[p.id],
      players: publicPlayers(room),
      revealSeconds: REVEAL_SECONDS,
      guessSeconds: GUESS_SECONDS,
      sipahiId: sipahi.id,
      sipahiName: sipahi.name,
      iAmSipahi: sipahi.id === p.id
    });
  });

  io.to(room.code).emit('roundAnnounce', {
    round: room.currentRound, totalRounds: room.totalRounds
  });
  broadcastLobby(room);

  // after reveal window, hide chits & open guessing
  room.revealTimer = setTimeout(() => openGuessPhase(room), REVEAL_SECONDS * 1000);
}

function openGuessPhase(room) {
  if (room.status !== 'reveal') return;
  room.status = 'guess';
  const sipahi = room.players.find(p => room.roles[p.id] === 'sipahi');
  const suspects = room.players
    .filter(p => p.id !== sipahi.id)
    .map(p => ({ id: p.id, name: p.name, isBot: p.isBot }));

  io.to(room.code).emit('guessPhase', {
    sipahiId: sipahi.id,
    sipahiName: sipahi.name,
    suspects,
    guessSeconds: GUESS_SECONDS
  });
  broadcastLobby(room);

  // bot sipahi auto-guesses
  if (sipahi.isBot) {
    room.botTimer = setTimeout(() => {
      const pick = pickRandom(suspects);
      resolveGuess(room, sipahi.id, pick.id, true);
    }, 3000 + randInt(2000));
  } else {
    // human timeout -> random auto guess
    room.guessTimer = setTimeout(() => {
      const pick = pickRandom(suspects);
      resolveGuess(room, sipahi.id, pick.id, true);
    }, GUESS_SECONDS * 1000);
  }
}

function resolveGuess(room, sipahiId, suspectId, auto = false) {
  if (room.status !== 'guess') return;
  clearTimers(room);
  room.status = 'result';

  const actualChor = room.players.find(p => room.roles[p.id] === 'chor');
  const correct = suspectId === actualChor.id;

  // scoring
  const roundPoints = {};
  room.players.forEach(p => {
    const role = room.roles[p.id];
    let pts = 0;
    if (role === 'raja') pts = 1000;
    else if (role === 'mantri') pts = 800;
    else if (role === 'sipahi') pts = correct ? 500 : 0;
    else if (role === 'chor') pts = correct ? 0 : 500;
    p.score += pts;
    roundPoints[p.id] = pts;
  });

  const rolesOut = {};
  room.players.forEach(p => {
    rolesOut[p.id] = { name: p.name, role: room.roles[p.id], points: roundPoints[p.id], isBot: p.isBot };
  });

  room.result = { correct, sipahiId, suspectId, auto, roles: rolesOut, round: room.currentRound };
  room.guess = { sipahiId, suspectId, correct, auto };

  const sipahiName = (room.players.find(p => p.id === sipahiId) || {}).name || 'Sipahi';
  const suspectName = (room.players.find(p => p.id === suspectId) || {}).name || '?';
  const chorName = actualChor.name;
  sysMsg(room, correct
    ? `✅ ${sipahiName} caught ${chorName} (Chor)! Sipahi +500 🎉`
    : `❌ ${sipahiName} accused ${suspectName} — real Chor was ${chorName}! Chor +500 😱`);

  io.to(room.code).emit('roundResult', {
    ...room.result,
    players: publicPlayers(room),
    isLastRound: isLastRound(room)
  });
  broadcastLobby(room);
}

// ---------------- Socket handlers ----------------
io.on('connection', (socket) => {
  socket.emit('publicRooms', [...rooms.values()]
    .filter(r => r.status === 'lobby')
    .map(r => ({
      code: r.code,
      humans: r.players.filter(p => !p.isBot).length,
      bots: r.players.filter(p => p.isBot).length,
      totalRounds: r.totalRounds,
      host: (r.players.find(p => p.id === r.hostId) || {}).name || '—'
    })));

  socket.on('getRooms', () => {
    socket.emit('publicRooms', [...rooms.values()]
      .filter(r => r.status === 'lobby')
      .map(r => ({
        code: r.code,
        humans: r.players.filter(p => !p.isBot).length,
        bots: r.players.filter(p => p.isBot).length,
        totalRounds: r.totalRounds,
        host: (r.players.find(p => p.id === r.hostId) || {}).name || '—'
      })));
  });

  socket.on('createRoom', ({ name, totalRounds }) => {
    name = String(name || '').trim().slice(0, 15) || 'Player';
    totalRounds = parseTotalRounds(totalRounds, 5);
    const code = genCode();
    const playerId = 'p_' + Math.random().toString(36).slice(2, 9);
    const room = {
      code, hostId: playerId, status: 'lobby',
      totalRounds, currentRound: 0,
      players: [{ id: playerId, socketId: socket.id, name, isBot: false, score: 0, connected: true }],
      roles: {}, lastRoles: null, guess: null, result: null, messages: [],
      revealTimer: null, guessTimer: null, botTimer: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;
    socket.emit('joined', { code, playerId, players: publicPlayers(room), hostId: playerId, totalRounds, chat: room.messages });
    sysMsg(room, `👑 ${name} created the room — share the code to invite friends!`);
    broadcastLobby(room);
    broadcastPublicRooms();
  });

  socket.on('joinRoom', ({ name, roomCode }) => {
    roomCode = String(roomCode || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('errorMsg', 'Room not found. Check the code.');
    if (room.status !== 'lobby') return socket.emit('errorMsg', 'Game already started in this room.');
    const humans = room.players.filter(p => !p.isBot).length;
    if (humans >= 4 || room.players.length >= 4) return socket.emit('errorMsg', 'Room is full (4/4).');
    name = String(name || '').trim().slice(0, 15) || 'Player';
    const playerId = 'p_' + Math.random().toString(36).slice(2, 9);
    room.players.push({ id: playerId, socketId: socket.id, name, isBot: false, score: 0, connected: true });
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;
    socket.emit('joined', { code: roomCode, playerId, players: publicPlayers(room), hostId: room.hostId, totalRounds: room.totalRounds, chat: room.messages });
    announce(room, 'join', `👋 ${name} joined the room (${room.players.length}/4)`);
    broadcastLobby(room);
    broadcastPublicRooms();
  });

  socket.on('sendChat', ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const me = room.players.find(p => p.id === socket.data.playerId && !p.isBot);
    if (!me) return;
    text = String(text || '').trim().slice(0, CHAT_MAXLEN);
    if (!text) return;
    pushChat(room, {
      id: 'm_' + Date.now().toString(36) + randInt(1296).toString(36),
      sys: false, playerId: me.id, name: me.name, text, ts: Date.now()
    });
  });

  socket.on('updateSettings', ({ totalRounds }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId !== room.hostId) return;
    // Host can set/change rounds in lobby AND mid-game (to extend/shorten/endless).
    // In lobby any value allowed; mid-game only allow increasing or switching to
    // endless / a value still ahead of currentRound to avoid retroactive game-over.
    if (room.status === 'gameover') return;
    const next = parseTotalRounds(totalRounds, room.totalRounds);
    if (room.status !== 'lobby') {
      if (next !== 0 && next < Math.max(room.currentRound, 1)) {
        return socket.emit('errorMsg', `Can't drop to ${next} — already on round ${room.currentRound}.`);
      }
    }
    room.totalRounds = next;
    sysMsg(room, `⚙️ Host set rounds to ${formatRounds(next)}`);
    io.to(room.code).emit('roundsUpdated', { totalRounds: next, currentRound: room.currentRound });
    broadcastLobby(room);
    broadcastPublicRooms();
  });

  socket.on('addBot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.players.length >= 4) return socket.emit('errorMsg', 'Room already has 4 players.');
    const used = new Set(room.players.map(p => p.name));
    const botName = BOT_NAMES.find(n => !used.has(n)) || ('Bot ' + (100 + randInt(900)) + ' 🤖');
    const botId = 'p_' + Math.random().toString(36).slice(2, 9);
    room.players.push({ id: botId, socketId: null, name: botName, isBot: true, score: 0, connected: true });
    announce(room, 'botJoin', `🤖 ${botName} joined the room (bot) — ${room.players.length}/4 seats filled`);
    broadcastLobby(room);
    broadcastPublicRooms();
  });

  socket.on('removeBot', ({ botId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    const gone = room.players.find(p => p.id === botId && p.isBot);
    room.players = room.players.filter(p => !(p.id === botId && p.isBot));
    if (gone) announce(room, 'botRemove', `🤖 ${gone.name} was removed (${room.players.length}/4)`);
    broadcastLobby(room);
    broadcastPublicRooms();
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return socket.emit('errorMsg', 'Only host can start.');
    // auto-fill with bots if fewer than 4
    while (room.players.length < 4) {
      const used = new Set(room.players.map(p => p.name));
      const botName = BOT_NAMES.find(n => !used.has(n)) || ('Bot ' + (100 + randInt(900)) + ' 🤖');
      room.players.push({ id: 'p_' + Math.random().toString(36).slice(2, 9), socketId: null, name: botName, isBot: true, score: 0, connected: true });
    }
    room.players.forEach(p => { p.score = 0; });
    room.currentRound = 0;
    room.lastRoles = null;
    broadcastPublicRooms();
    sysMsg(room, room.totalRounds === 0
      ? `🎮 Game started — ♾️ endless mode! Host ends it with 🏁 End game. Good luck!`
      : `🎮 Game started — ${room.totalRounds} round(s). Good luck!`);
    startRound(room);
  });

  socket.on('makeGuess', ({ suspectId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'guess') return;
    const sipahi = room.players.find(p => room.roles[p.id] === 'sipahi');
    if (!sipahi || sipahi.id !== socket.data.playerId) return socket.emit('errorMsg', 'Only Sipahi can guess.');
    if (!room.players.some(p => p.id === suspectId && p.id !== sipahi.id)) return;
    resolveGuess(room, sipahi.id, suspectId, false);
  });

  function finishGame(room) {
    room.status = 'gameover';
    const sorted = [...room.players].sort((a, b) => b.score - a.score);
    io.to(room.code).emit('gameOver', {
      players: publicPlayers(room),
      winner: { id: sorted[0].id, name: sorted[0].name, score: sorted[0].score, isBot: sorted[0].isBot }
    });
    sysMsg(room, `🏆 ${sorted[0].name} wins with ${sorted[0].score} pts after ${room.currentRound} round(s)! GG everyone 🎉`);
    broadcastLobby(room);
    broadcastPublicRooms();
  }

  socket.on('nextRound', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'result') return;
    if (socket.data.playerId !== room.hostId) return;
    if (isLastRound(room)) {
      finishGame(room);
    } else {
      startRound(room);
    }
  });

  // Host can end the game at any point mid-game (needed for ♾️ endless mode,
  // but also works as an early-finish for fixed-length games).
  socket.on('endGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId !== room.hostId) return socket.emit('errorMsg', 'Only host can end the game.');
    if (room.status === 'lobby' || room.status === 'gameover') return;
    clearTimers(room);
    finishGame(room);
  });

  socket.on('restartGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId !== room.hostId) return;
    room.players.forEach(p => { p.score = 0; });
    room.currentRound = 0;
    room.lastRoles = null;
    room.status = 'lobby';
    sysMsg(room, '🔁 Back to lobby — host can start a new game');
    broadcastLobby(room);
    broadcastPublicRooms();
  });

  socket.on('leaveRoom', () => {
    leaveRoom(socket);
  });

  socket.on('disconnect', () => {
    leaveRoom(socket);
  });

  function leaveRoom(sock) {
    const code = sock.data.roomCode;
    const pid = sock.data.playerId;
    if (!code || !rooms.has(code)) return;
    const room = rooms.get(code);
    const idx = room.players.findIndex(p => p.id === pid && !p.isBot);
    if (idx === -1) return;
    const leaverName = room.players[idx].name;
    if (room.status === 'lobby') {
      room.players.splice(idx, 1);
      // host migration
      if (room.hostId === pid) {
        const nextHuman = room.players.find(p => !p.isBot);
        room.hostId = nextHuman ? nextHuman.id : (room.players[0] ? room.players[0].id : null);
      }
      if (room.players.length === 0) {
        clearTimers(room);
        rooms.delete(code);
      } else {
        announce(room, 'leave', `👋 ${leaverName} left the room (${room.players.length}/4)`);
        broadcastLobby(room);
      }
    } else {
      // mid-game: convert leaver to bot so round can finish
      room.players[idx].isBot = true;
      room.players[idx].connected = false;
      room.players[idx].socketId = null;
      room.players[idx].name += ' (left)';
      announce(room, 'leave', `⚠️ ${leaverName} left — bot takes over 🤖`);
      if (room.hostId === pid) {
        const nextHuman = room.players.find(p => !p.isBot && p.connected !== false);
        if (nextHuman) room.hostId = nextHuman.id;
      }
      // if sipahi left mid-guess and became bot, auto guess
      if (room.status === 'guess') {
        const sipahi = room.players.find(p => room.roles[p.id] === 'sipahi');
        if (sipahi && sipahi.id === pid) {
          clearTimers(room);
          room.botTimer = setTimeout(() => {
            const suspects = room.players.filter(p => p.id !== sipahi.id);
            const pick = pickRandom(suspects);
            resolveGuess(room, sipahi.id, pick.id, true);
          }, 2500);
        }
      }
      broadcastLobby(room);
    }
    try { sock.leave(code); } catch (e) {}
    sock.data.roomCode = null;
    broadcastPublicRooms();
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`🎮 Raja-Mantri-Chor-Sipahi live on :${PORT}`));
