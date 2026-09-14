/**
 * 👑 Raja Mantri Chor Sipahi — multiplayer game server.
 *
 * Stack: Express (static hosting for `public/`) + Socket.IO (rooms, rounds, chat).
 * Storage: in-memory only — `rooms` Map, no database. All rooms reset on restart.
 *
 * Game modes:
 *  - classic (4P): Raja 1000, Mantri 800, Sipahi 500/0, Chor 0/500. Sipahi picks any other player.
 *  - variant "Darbar" (5-7P): adds Senapati 600, Kotwal 400, Praja 200.
 *    Raja/Mantri/Sipahi are publicly revealed each round; Sipahi picks only from hidden suspects.
 *
 * Round flow per room: lobby -> reveal (7s, private chits) -> guess (timed) -> result -> next/lobby/gameover.
 * Bots fill empty seats, auto-guess as Sipahi, and take over when humans disconnect mid-game.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public'), {
  dotfiles: 'allow',
  setHeaders: (res, filePath) => {
    // Service worker must not be cached or updates get stuck.
    if (filePath.endsWith('sw.js')) res.set('Cache-Control', 'no-cache');
  }
}));
app.get('/health', (req, res) => res.json({ ok: true }));
// Play Store (TWA) domain verification — fill public/.well-known/assetlinks.json at publish time.
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', '.well-known', 'assetlinks.json'), (err) => {
    if (err) res.json([]);
  });
});
// Missing game art should 404 (so <img onerror> fallback works) — not serve index.html
app.get('/assets/*', (req, res) => res.status(404).send('not found'));
// SPA fallback for any non-socket route (deep-link ?room= support)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------- Game state ----------------
// In-memory store: room code (e.g. "AB12") -> room object.
// Room = { code, hostId, status, mode, maxPlayers, totalRounds (0 = endless),
//          currentRound, players[], roles{}, lastRoles, guess, result, messages[], timers }.
const rooms = new Map(); // code -> room

// Fixed points per role. Sipahi/Chor are conditional (see resolveGuess); the rest always score face value.
const ROLE_POINTS = { raja: 1000, mantri: 800, senapati: 600, sipahi: 500, kotwal: 400, praja: 200, chor: 0 };
const REVEAL_SECONDS = 7; // private chit visible window before auto-hide (anti-sneak)
const GUESS_SECONDS = 30; // base Sipahi guess timer (variant adds +5s per extra suspect beyond 3)
const CHAT_MAXLEN = 300; // max chars per chat message
const CHAT_HISTORY = 50; // last N messages kept per room (in-memory)
const BOT_NAMES = ['Chintu 🤖', 'Bunty 🤖', 'Guddu 🤖', 'Pinki 🤖', 'Monty 🤖', 'Chhotu 🤖', 'Raju 🤖'];
const CLASSIC_PLAYERS = 4; // Classic mode is frozen at 4 seats
const MIN_VARIANT_PLAYERS = 5; // Darbar variant seat range…
const MAX_PLAYERS = 7; // …5 to 7 players
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

// ---- Classic vs Variant (Darbar) ----
// Normalises any client value to 'variant' or 'classic' (default). Unknown values fall back to classic.
/** Parse the requested game mode; anything but "variant" becomes "classic". */
function parseMode(v) {
  return String(v || '').toLowerCase() === 'variant' ? 'variant' : 'classic';
}

// Classic always seats 4; variant clamps the requested seats into the 5..7 range.
/** Parse seat count for variant rooms (classic is always 4). */
function parseMaxPlayers(v, mode, fallback) {
  if (mode !== 'variant') return CLASSIC_PLAYERS;
  const fb = fallback || 6;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return Math.min(MAX_PLAYERS, Math.max(MIN_VARIANT_PLAYERS, fb));
  return Math.min(MAX_PLAYERS, Math.max(MIN_VARIANT_PLAYERS, n));
}

/** Short display label for a room, e.g. "Classic" or "Darbar 6P". */
function modeLabel(room) {
  if (!room || room.mode !== 'variant') return 'Classic';
  return `Darbar ${room.maxPlayers}P`;
}

// Role chits per mode / seats. Classic is frozen (4). Variant adds court roles.
// Full court order guarantees core roles (Raja/Mantri/Sipahi/Chor) are dealt first,
// then Senapati/Kotwal/Praja as seats grow; sliced to the actual seat count.
/** Ordered role chits for a room, sliced to its seat count. */
function roleSetFor(room) {
  if (!room || room.mode !== 'variant') return ['raja', 'mantri', 'chor', 'sipahi'];
  const n = room.players ? Math.max(room.players.length, room.maxPlayers || 0) : (room.maxPlayers || 6);
  // Base order ensures core roles present even if short-seated; slice to seats.
  const full = ['raja', 'mantri', 'sipahi', 'chor', 'senapati', 'kotwal', 'praja'];
  return full.slice(0, Math.min(MAX_PLAYERS, Math.max(MIN_VARIANT_PLAYERS, n || 6)));
}

// Who the Sipahi may accuse this round.
// Classic: everyone except Sipahi. Variant: only hidden players (Raja/Mantri/Sipahi are public).
/** Players the Sipahi is allowed to guess, as { id, name, isBot } list. */
function suspectsFor(room) {
  const sipahi = room.players.find(p => room.roles[p.id] === 'sipahi');
  if (room.mode === 'variant') {
    const known = new Set();
    room.players.forEach(p => {
      const r = room.roles[p.id];
      if (r === 'raja' || r === 'mantri' || r === 'sipahi') known.add(p.id);
    });
    return room.players.filter(p => !known.has(p.id)).map(p => ({ id: p.id, name: p.name, isBot: p.isBot }));
  }
  return room.players.filter(p => p.id !== sipahi.id).map(p => ({ id: p.id, name: p.name, isBot: p.isBot }));
}

// Variant only: court roles shown publicly after the peek (Raja/Mantri/Sipahi).
/** Publicly revealed players for Darbar variant (empty list in classic). */
function revealedFor(room) {
  if (room.mode !== 'variant') return [];
  return room.players
    .filter(p => ['raja', 'mantri', 'sipahi'].includes(room.roles[p.id]))
    .map(p => ({ id: p.id, name: p.name, role: room.roles[p.id], isBot: p.isBot }));
}

// Larger Darbar courts get a little more thinking time: 30s + 5s per suspect beyond 3.
/** Guess timer seconds for a room (scales with variant court size). */
function guessSecondsFor(room) {
  if (room.mode !== 'variant') return GUESS_SECONDS;
  const nSus = Math.max(2, (room.players.length || 0) - 3);
  return GUESS_SECONDS + Math.max(0, nSus - 3) * 5;
}

// 4-char room code from unambiguous alphabet (no 0/O, 1/I). Retries on collision.
/** Generate a unique 4-letter room code. */
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[randInt(chars.length)];
  if (rooms.has(code)) return genCode();
  return code;
}

// Cryptographically-strong random int in [0, max)
/** Crypto-secure random int in [0, max) — used for shuffles, codes, bot picks. */
function randInt(max) {
  return crypto.randomInt(max);
}

/** Random element from a non-empty array. */
function pickRandom(arr) {
  return arr[randInt(arr.length)];
}

/** Fisher–Yates shuffle (crypto-backed) — returns a new array. */
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
/** Shuffle and assign one role per seated player, minimising repeats of last round. */
function dealRoles(room) {
  const base = roleSetFor(room).slice(0, room.players.length);
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

/** Count how many seated players would repeat last round's role under `deal`. */
function countRepeats(room, deal) {
  if (!room.lastRoles) return 0;
  let n = 0;
  room.players.forEach((p, i) => {
    if (room.lastRoles[p.id] === deal[i]) n++;
  });
  return n;
}

/** Safe public snapshot of players for clients (never leaks socket internals or roles). */
function publicPlayers(room) {
  return room.players.map(p => ({
    id: p.id, name: p.name, isBot: p.isBot,
    score: p.score, connected: p.connected !== false,
    isHost: p.id === room.hostId
  }));
}

/** Push the lobby roster/settings to everyone in the room. */
function broadcastLobby(room) {
  io.to(room.code).emit('roomUpdate', {
    code: room.code,
    players: publicPlayers(room),
    hostId: room.hostId,
    status: room.status,
    totalRounds: room.totalRounds,
    currentRound: room.currentRound,
    mode: room.mode || 'classic',
    maxPlayers: room.maxPlayers || CLASSIC_PLAYERS
  });
}

/** Compact card for the open-room browser (no roles/scores leaked). */
function roomCard(r) {
  return {
    code: r.code,
    humans: r.players.filter(p => !p.isBot).length,
    bots: r.players.filter(p => p.isBot).length,
    totalRounds: r.totalRounds,
    host: (r.players.find(p => p.id === r.hostId) || {}).name || '—',
    mode: r.mode || 'classic',
    maxPlayers: r.maxPlayers || CLASSIC_PLAYERS
  };
}

/** Broadcast joinable lobby rooms (with a free human seat) to every connected client. */
function broadcastPublicRooms() {
  const list = [...rooms.values()]
    .filter(r => r.status === 'lobby' && r.players.filter(p => !p.isBot).length < (r.maxPlayers || CLASSIC_PLAYERS))
    .map(roomCard);
  io.emit('publicRooms', list);
}

// ---- Room chat (in-memory, last CHAT_HISTORY messages per room) ----
/** Append a chat message (trimmed to CHAT_HISTORY) and emit it to the room. */
function pushChat(room, msg) {
  room.messages.push(msg);
  if (room.messages.length > CHAT_HISTORY) room.messages.splice(0, room.messages.length - CHAT_HISTORY);
  io.to(room.code).emit('chatMsg', msg);
}

/** Game-event feed line (joins, catches, winners) shown inside room chat. */
function sysMsg(room, text) {
  pushChat(room, { id: 'm_' + Date.now().toString(36) + randInt(1296).toString(36), sys: true, text, ts: Date.now() });
}

// Room-wide alert: chat sys message + loud playerEvent (toast + sound on clients).
// Used for joins / leaves / bot join-remove so nobody misses them even with chat closed.
function announce(room, type, text) {
  sysMsg(room, text);
  io.to(room.code).emit('playerEvent', { type, text, ts: Date.now() });
}

/** Clear any pending reveal/guess/bot timers so phases never overlap or leak. */
function clearTimers(room) {
  if (room.revealTimer) { clearTimeout(room.revealTimer); room.revealTimer = null; }
  if (room.guessTimer) { clearTimeout(room.guessTimer); room.guessTimer = null; }
  if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = null; }
}

/**
 * Begin a round: deal private chits, notify each human of their own role,
 * announce the round to the room, and arm the 7s reveal -> guess transition.
 */
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
      mode: room.mode || 'classic',
      maxPlayers: room.maxPlayers || CLASSIC_PLAYERS,
      myRole: room.roles[p.id],
      players: publicPlayers(room),
      revealSeconds: REVEAL_SECONDS,
      guessSeconds: guessSecondsFor(room),
      sipahiId: sipahi.id,
      sipahiName: sipahi.name,
      iAmSipahi: sipahi.id === p.id
    });
  });

  io.to(room.code).emit('roundAnnounce', {
    round: room.currentRound, totalRounds: room.totalRounds,
    mode: room.mode || 'classic', maxPlayers: room.maxPlayers || CLASSIC_PLAYERS
  });
  broadcastLobby(room);

  // after reveal window, hide chits & open guessing
  room.revealTimer = setTimeout(() => openGuessPhase(room), REVEAL_SECONDS * 1000);
}

/**
 * Hide chits and open the guessing phase: emits suspects (+ public reveals in
 * variant), then arms either a bot auto-guess or the human Sipahi timeout.
 */
function openGuessPhase(room) {
  if (room.status !== 'reveal') return;
  room.status = 'guess';
  const sipahi = room.players.find(p => room.roles[p.id] === 'sipahi');
  const suspects = suspectsFor(room);
  const revealed = revealedFor(room);
  const guessSeconds = guessSecondsFor(room);

  io.to(room.code).emit('guessPhase', {
    sipahiId: sipahi.id,
    sipahiName: sipahi.name,
    suspects,
    revealed,
    mode: room.mode || 'classic',
    guessSeconds
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
    }, guessSeconds * 1000);
  }
}

/**
 * Score a Sipahi accusation and reveal all chits.
 * Correct: Sipahi +500, Chor +0. Wrong: swapped (Chor +500, Sipahi +0).
 * Fixed court roles (Raja/Mantri/Senapati/Kotwal/Praja) always score face value.
 */
function resolveGuess(room, sipahiId, suspectId, auto = false) {
  if (room.status !== 'guess') return;
  clearTimers(room);
  room.status = 'result';

  const actualChor = room.players.find(p => room.roles[p.id] === 'chor');
  const correct = suspectId === actualChor.id;

  // scoring (classic frozen; variant court roles are fixed points)
  const roundPoints = {};
  room.players.forEach(p => {
    const role = room.roles[p.id];
    let pts = 0;
    if (role === 'raja') pts = 1000;
    else if (role === 'mantri') pts = 800;
    else if (role === 'senapati') pts = 600;
    else if (role === 'sipahi') pts = correct ? 500 : 0;
    else if (role === 'kotwal') pts = 400;
    else if (role === 'praja') pts = 200;
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
// Client -> server events: createRoom/joinRoom, sendChat, updateSettings,
// addBot/removeBot, startGame, makeGuess, nextRound, endGame, restartGame, leaveRoom.
// Server -> client events: joined, roomUpdate, publicRooms, roundAnnounce,
// roundStarted, guessPhase, roundResult, gameOver, roundsUpdated, chatMsg, playerEvent, errorMsg.
io.on('connection', (socket) => {
  socket.emit('publicRooms', [...rooms.values()]
    .filter(r => r.status === 'lobby')
    .map(roomCard));

  socket.on('getRooms', () => {
    socket.emit('publicRooms', [...rooms.values()]
      .filter(r => r.status === 'lobby')
      .map(roomCard));
  });

  socket.on('createRoom', ({ name, totalRounds, mode, maxPlayers }) => {
    name = String(name || '').trim().slice(0, 15) || 'Player';
    totalRounds = parseTotalRounds(totalRounds, 5);
    mode = parseMode(mode);
    maxPlayers = parseMaxPlayers(maxPlayers, mode, 6);
    const code = genCode();
    const playerId = 'p_' + Math.random().toString(36).slice(2, 9);
    const room = {
      code, hostId: playerId, status: 'lobby',
      mode, maxPlayers,
      totalRounds, currentRound: 0,
      players: [{ id: playerId, socketId: socket.id, name, isBot: false, score: 0, connected: true }],
      roles: {}, lastRoles: null, guess: null, result: null, messages: [],
      revealTimer: null, guessTimer: null, botTimer: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;
    socket.emit('joined', { code, playerId, players: publicPlayers(room), hostId: playerId, totalRounds, mode, maxPlayers, chat: room.messages });
    sysMsg(room, `👑 ${name} created a ${mode === 'variant' ? `Darbar ${maxPlayers}P` : 'Classic 4P'} room — share the code to invite friends!`);
    broadcastLobby(room);
    broadcastPublicRooms();
  });

  socket.on('joinRoom', ({ name, roomCode }) => {
    roomCode = String(roomCode || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return socket.emit('errorMsg', 'Room not found. Check the code.');
    if (room.status !== 'lobby') return socket.emit('errorMsg', 'Game already started in this room.');
    const humans = room.players.filter(p => !p.isBot).length;
    const cap = room.maxPlayers || CLASSIC_PLAYERS;
    if (humans >= cap || room.players.length >= cap) return socket.emit('errorMsg', `Room is full (${room.players.length}/${cap}).`);
    name = String(name || '').trim().slice(0, 15) || 'Player';
    const playerId = 'p_' + Math.random().toString(36).slice(2, 9);
    room.players.push({ id: playerId, socketId: socket.id, name, isBot: false, score: 0, connected: true });
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerId = playerId;
    socket.emit('joined', { code: roomCode, playerId, players: publicPlayers(room), hostId: room.hostId, totalRounds: room.totalRounds, mode: room.mode || 'classic', maxPlayers: cap, chat: room.messages });
    announce(room, 'join', `👋 ${name} joined the room (${room.players.length}/${cap})`);
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

  socket.on('updateSettings', ({ totalRounds, maxPlayers }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId !== room.hostId) return;
    // Host can set/change rounds in lobby AND mid-game (to extend/shorten/endless).
    // In lobby any value allowed; mid-game only allow increasing or switching to
    // endless / a value still ahead of currentRound to avoid retroactive game-over.
    // Seats (maxPlayers) can only change in lobby for variant rooms.
    if (room.status === 'gameover') return;
    const next = parseTotalRounds(totalRounds, room.totalRounds);
    if (room.status !== 'lobby') {
      if (next !== 0 && next < Math.max(room.currentRound, 1)) {
        return socket.emit('errorMsg', `Can't drop to ${next} — already on round ${room.currentRound}.`);
      }
    }
    room.totalRounds = next;
    let seatsMsg = '';
    if (room.status === 'lobby' && room.mode === 'variant' && maxPlayers !== undefined) {
      const cap = parseMaxPlayers(maxPlayers, room.mode, room.maxPlayers);
      if (cap !== room.maxPlayers) {
        if (cap < room.players.length) {
          socket.emit('errorMsg', `Can't shrink to ${cap} — ${room.players.length} seats taken. Remove bots first.`);
        } else {
          room.maxPlayers = cap;
          seatsMsg = ` · seats ${cap}`;
        }
      }
    }
    sysMsg(room, `⚙️ Host set rounds to ${formatRounds(next)}${seatsMsg}`);
    io.to(room.code).emit('roundsUpdated', { totalRounds: next, currentRound: room.currentRound, maxPlayers: room.maxPlayers, mode: room.mode });
    broadcastLobby(room);
    broadcastPublicRooms();
  });

  socket.on('addBot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    const cap = room.maxPlayers || CLASSIC_PLAYERS;
    if (room.players.length >= cap) return socket.emit('errorMsg', `Room already has ${cap} players.`);
    const used = new Set(room.players.map(p => p.name));
    const botName = BOT_NAMES.find(n => !used.has(n)) || ('Bot ' + (100 + randInt(900)) + ' 🤖');
    const botId = 'p_' + Math.random().toString(36).slice(2, 9);
    room.players.push({ id: botId, socketId: null, name: botName, isBot: true, score: 0, connected: true });
    announce(room, 'botJoin', `🤖 ${botName} joined the room (bot) — ${room.players.length}/${cap} seats filled`);
    broadcastLobby(room);
    broadcastPublicRooms();
  });

  socket.on('removeBot', ({ botId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    const gone = room.players.find(p => p.id === botId && p.isBot);
    room.players = room.players.filter(p => !(p.id === botId && p.isBot));
    if (gone) announce(room, 'botRemove', `🤖 ${gone.name} was removed (${room.players.length}/${room.maxPlayers || CLASSIC_PLAYERS})`);
    broadcastLobby(room);
    broadcastPublicRooms();
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return socket.emit('errorMsg', 'Only host can start.');
    const cap = room.maxPlayers || CLASSIC_PLAYERS;
    // auto-fill with bots if fewer than cap (classic 4 frozen, variant 5-7)
    while (room.players.length < cap) {
      const used = new Set(room.players.map(p => p.name));
      const botName = BOT_NAMES.find(n => !used.has(n)) || ('Bot ' + (100 + randInt(900)) + ' 🤖');
      room.players.push({ id: 'p_' + Math.random().toString(36).slice(2, 9), socketId: null, name: botName, isBot: true, score: 0, connected: true });
    }
    room.players.forEach(p => { p.score = 0; });
    room.currentRound = 0;
    room.lastRoles = null;
    broadcastPublicRooms();
    sysMsg(room, room.totalRounds === 0
      ? `🎮 Game started — ${modeLabel(room)} · ♾️ endless mode! Host ends it with 🏁 End game. Good luck!`
      : `🎮 Game started — ${modeLabel(room)} · ${room.totalRounds} round(s). Good luck!`);
    startRound(room);
  });

  socket.on('makeGuess', ({ suspectId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'guess') return;
    const sipahi = room.players.find(p => room.roles[p.id] === 'sipahi');
    if (!sipahi || sipahi.id !== socket.data.playerId) return socket.emit('errorMsg', 'Only Sipahi can guess.');
    if (room.mode === 'variant') {
      // Raja/Mantri can never be Chor — only hidden suspects are valid targets.
      const ok = suspectsFor(room).some(s => s.id === suspectId);
      if (!ok) return socket.emit('errorMsg', 'Pick a suspect — Raja/Mantri cannot be Chor.');
    } else {
      if (!room.players.some(p => p.id === suspectId && p.id !== sipahi.id)) return;
    }
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

  // Remove a human from a room. Lobby: player leaves (host migrates, empty room deleted).
  // Mid-game: player becomes a bot stand-in so the round can finish; Sipahi leavers auto-guess.
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
        announce(room, 'leave', `👋 ${leaverName} left the room (${room.players.length}/${room.maxPlayers || CLASSIC_PLAYERS})`);
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
            const suspects = suspectsFor(room);
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
