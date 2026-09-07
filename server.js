const express = require('express');
const http = require('http');
const path = require('path');
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
const BOT_NAMES = ['Chintu 🤖', 'Bunty 🤖', 'Guddu 🤖', 'Pinki 🤖', 'Monty 🤖'];

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  if (rooms.has(code)) return genCode();
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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

function clearTimers(room) {
  if (room.revealTimer) { clearTimeout(room.revealTimer); room.revealTimer = null; }
  if (room.guessTimer) { clearTimeout(room.guessTimer); room.guessTimer = null; }
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
}

function startRound(room) {
  clearTimers(room);
  room.status = 'reveal';
  room.currentRound += 1;

  // assign roles randomly to the 4 seats
  const roles = shuffle(['raja', 'mantri', 'chor', 'sipahi']);
  room.roles = {};
  room.players.forEach((p, i) => { room.roles[p.id] = roles[i]; });
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
      const pick = suspects[Math.floor(Math.random() * suspects.length)];
      resolveGuess(room, sipahi.id, pick.id, true);
    }, 3000 + Math.random() * 2000);
  } else {
    // human timeout -> random auto guess
    room.guessTimer = setTimeout(() => {
      const pick = suspects[Math.floor(Math.random() * suspects.length)];
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

  io.to(room.code).emit('roundResult', {
    ...room.result,
    players: publicPlayers(room),
    isLastRound: room.currentRound >= room.totalRounds
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
    totalRounds = Math.min(10, Math.max(1, parseInt(totalRounds) || 5));
    const code = genCode();
    const playerId = 'p_' + Math.random().toString(36).slice(2, 9);
    const room = {
      code, hostId: playerId, status: 'lobby',
      totalRounds, currentRound: 0,
      players: [{ id: playerId, socketId: socket.id, name, isBot: false, score: 0, connected: true }],
      roles: {}, guess: null, result: null,
      revealTimer: null, guessTimer: null, botTimer: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;
    socket.emit('joined', { code, playerId, players: publicPlayers(room), hostId: playerId, totalRounds });
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
    socket.emit('joined', { code: roomCode, playerId, players: publicPlayers(room), hostId: room.hostId, totalRounds: room.totalRounds });
    broadcastLobby(room);
    broadcastPublicRooms();
  });

  socket.on('updateSettings', ({ totalRounds }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    room.totalRounds = Math.min(10, Math.max(1, parseInt(totalRounds) || 5));
    broadcastLobby(room);
    broadcastPublicRooms();
  });

  socket.on('addBot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.players.length >= 4) return socket.emit('errorMsg', 'Room already has 4 players.');
    const used = new Set(room.players.map(p => p.name));
    const botName = BOT_NAMES.find(n => !used.has(n)) || ('Bot ' + Math.floor(Math.random() * 900 + 100) + ' 🤖');
    const botId = 'p_' + Math.random().toString(36).slice(2, 9);
    room.players.push({ id: botId, socketId: null, name: botName, isBot: true, score: 0, connected: true });
    broadcastLobby(room);
    broadcastPublicRooms();
  });

  socket.on('removeBot', ({ botId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    room.players = room.players.filter(p => !(p.id === botId && p.isBot));
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
      const botName = BOT_NAMES.find(n => !used.has(n)) || ('Bot ' + Math.floor(Math.random() * 900 + 100) + ' 🤖');
      room.players.push({ id: 'p_' + Math.random().toString(36).slice(2, 9), socketId: null, name: botName, isBot: true, score: 0, connected: true });
    }
    room.players.forEach(p => { p.score = 0; });
    room.currentRound = 0;
    broadcastPublicRooms();
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

  socket.on('nextRound', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'result') return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.currentRound >= room.totalRounds) {
      room.status = 'gameover';
      const sorted = [...room.players].sort((a, b) => b.score - a.score);
      io.to(room.code).emit('gameOver', {
        players: publicPlayers(room),
        winner: { id: sorted[0].id, name: sorted[0].name, score: sorted[0].score, isBot: sorted[0].isBot }
      });
      broadcastLobby(room);
      broadcastPublicRooms();
    } else {
      startRound(room);
    }
  });

  socket.on('restartGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId !== room.hostId) return;
    room.players.forEach(p => { p.score = 0; });
    room.currentRound = 0;
    room.status = 'lobby';
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
        broadcastLobby(room);
      }
    } else {
      // mid-game: convert leaver to bot so round can finish
      room.players[idx].isBot = true;
      room.players[idx].connected = false;
      room.players[idx].socketId = null;
      room.players[idx].name += ' (left)';
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
            const pick = suspects[Math.floor(Math.random() * suspects.length)];
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
