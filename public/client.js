const socket = io();

const $ = (id) => document.getElementById(id);
const screens = ['screen-home', 'screen-lobby', 'screen-game'];
function show(name) {
  screens.forEach(s => $(s).classList.add('hidden'));
  $(name).classList.remove('hidden');
  window.scrollTo(0, 0);
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2500);
}

const ROLE_META = {
  raja:   { emoji: '👑', name: 'RAJA',   pts: '1000 pts (fixed)' },
  mantri: { emoji: '🎩', name: 'MANTRI', pts: '800 pts (fixed)' },
  chor:   { emoji: '🥷', name: 'CHOR',   pts: '500 if hidden · 0 if caught' },
  sipahi: { emoji: '🕵️', name: 'SIPAHI', pts: '500 if catch · 0 if wrong' },
};

let myId = null, myRoom = null, myRole = null, isHost = false;
let revealLeft = 0, revealInt = null, peekTimeout = null, guessInt = null, guessLeft = 0;
let selectedSuspect = null, currentSuspects = [];

// fill rounds selects 1..10
['inRounds'].forEach(() => {});
const lbRounds = $('lbRounds');
for (let i = 1; i <= 10; i++) {
  const o = document.createElement('option');
  o.value = i; o.textContent = i + (i === 1 ? ' round' : ' rounds');
  if (i === 5) o.selected = true;
  lbRounds.appendChild(o);
}

// ---------- home ----------
$('btnCreate').onclick = () => {
  const name = $('inName').value.trim() || 'Player';
  socket.emit('createRoom', { name, totalRounds: $('inRounds').value });
};
$('btnJoin').onclick = () => {
  const name = $('inName').value.trim() || 'Player';
  const code = $('inCode').value.trim().toUpperCase();
  if (!code) return toast('Enter a room code first');
  socket.emit('joinRoom', { name, roomCode: code });
};
$('btnRefresh').onclick = () => socket.emit('getRooms');
$('inCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnJoin').click(); });

socket.on('publicRooms', (list) => {
  const el = $('roomList');
  if (!list.length) { el.innerHTML = '<div class="muted">No open rooms — create one!</div>'; return; }
  el.innerHTML = '';
  list.forEach(r => {
    const d = document.createElement('div');
    d.className = 'roomitem';
    d.innerHTML = `<span><b>${r.code}</b> · ${r.humans}👤 + ${r.bots}🤖 · ${r.totalRounds} rounds · host ${escapeHtml(r.host)}</span>`;
    const b = document.createElement('button');
    b.className = 'btn small'; b.textContent = 'Join';
    b.onclick = () => {
      const name = $('inName').value.trim() || 'Player';
      socket.emit('joinRoom', { name, roomCode: r.code });
    };
    d.appendChild(b);
    el.appendChild(d);
  });
});

// ---------- lobby ----------
socket.on('joined', (d) => {
  myId = d.playerId; myRoom = d.code;
  $('gCode').textContent = d.code;
  $('chatMsgs').innerHTML = '';
  unread = 0; updateBadge();
  (d.chat || []).forEach(addChatMsg);
  $('chatFab').classList.remove('hidden');
  show('screen-lobby');
});
socket.on('roomUpdate', (room) => {
  if (room.code !== myRoom) return;
  myRoom = room.code;
  isHost = room.hostId === myId;
  $('lbCode').textContent = room.code;
  $('gCode').textContent = room.code;
  lbRounds.value = String(room.totalRounds);

  const box = $('lbPlayers');
  box.innerHTML = '';
  room.players.forEach(p => {
    const div = document.createElement('div');
    div.className = 'player';
    div.innerHTML = `<span>${escapeHtml(p.name)}
      ${p.id === room.hostId ? '<span class="badge host">HOST</span>' : ''}
      ${p.isBot ? '<span class="badge bot">BOT</span>' : ''}
      ${p.id === myId ? '<span class="badge">YOU</span>' : ''}</span>
      <span>⭐ <b>${p.score}</b></span>`;
    if (isHost && p.isBot && room.status === 'lobby') {
      const x = document.createElement('button');
      x.className = 'btn small danger'; x.textContent = '✕';
      x.title = 'Remove bot';
      x.onclick = () => socket.emit('removeBot', { botId: p.id });
      div.appendChild(x);
    }
    box.appendChild(div);
  });

  $('hostControls').style.display = isHost ? 'flex' : 'none';
  $('lbWait').style.display = isHost ? 'none' : 'block';
  $('btnStart').disabled = room.players.length < 2 && false; // allow solo+ bots
  $('btnAddBot').disabled = room.players.length >= 4;
  if (room.status === 'lobby' && $('screen-lobby').classList.contains('hidden') === false) {
    // stay in lobby
  }
  // if game started, screen switches via roundStarted
  if (room.status === 'gameover') { /* handled by gameOver */ }
});

$('btnCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(myRoom); toast('Room code copied: ' + myRoom); }
  catch { toast('Room code: ' + myRoom); }
};
$('btnAddBot').onclick = () => socket.emit('addBot');
lbRounds.onchange = () => socket.emit('updateSettings', { totalRounds: lbRounds.value });
$('btnStart').onclick = () => socket.emit('startGame');
$('btnLeave1').onclick = () => { socket.emit('leaveRoom'); location.reload(); };
$('btnLeave2').onclick = () => { socket.emit('leaveRoom'); location.reload(); };

// ---------- rounds ----------
socket.on('roundAnnounce', ({ round, totalRounds }) => {
  show('screen-game');
  $('overZone').classList.add('hidden');
  $('resultZone').classList.add('hidden');
  $('guessZone').classList.add('hidden');
  $('chitZone').classList.remove('hidden');
  $('gRound').textContent = `Round ${round}/${totalRounds}`;
});

socket.on('roundStarted', (d) => {
  show('screen-game');
  $('overZone').classList.add('hidden');
  $('resultZone').classList.add('hidden');
  $('guessZone').classList.add('hidden');
  $('chitZone').classList.remove('hidden');
  $('gRound').textContent = `Round ${d.round}/${d.totalRounds}`;
  myRole = d.myRole;
  renderScores(d.players);
  showChit(myRole, d.revealSeconds);
});

function renderScores(players) {
  const bar = $('scorebar');
  bar.innerHTML = '';
  [...players].sort((a, b) => b.score - a.score).forEach(p => {
    const d = document.createElement('div');
    d.className = 'score';
    d.innerHTML = `${escapeHtml(p.name)}${p.id === myId ? ' (you)' : ''}<b>⭐ ${p.score}</b>`;
    bar.appendChild(d);
  });
}

function showChit(role, secs) {
  const meta = ROLE_META[role];
  const card = $('chitCard');
  card.classList.remove('hidden-chit');
  $('chitEmoji').textContent = meta.emoji;
  $('chitName').textContent = meta.name;
  $('chitPts').textContent = meta.pts;
  $('chitMsg').textContent = role === 'sipahi'
    ? 'You are SIPAHI! Memorise it — you must catch the CHOR next! 🕵️'
    : 'Memorise your chit — it hides soon! 👀 Don\'t let others peek!';
  $('btnPeek').style.display = 'none';

  clearInterval(revealInt);
  revealLeft = secs;
  $('chitTimer').textContent = revealLeft;
  revealInt = setInterval(() => {
    revealLeft--;
    $('chitTimer').textContent = Math.max(0, revealLeft);
    if (revealLeft <= 0) { clearInterval(revealInt); hideChit(); }
  }, 1000);
}

function hideChit(auto = true) {
  const card = $('chitCard');
  card.classList.add('hidden-chit');
  $('chitEmoji').textContent = '🂠';
  $('chitName').textContent = 'HIDDEN';
  $('chitPts').textContent = myRole ? `You are: ${ROLE_META[myRole].emoji} ${ROLE_META[myRole].name}` : '';
  $('chitTimer').textContent = '🔒';
  $('chitMsg').textContent = 'Chit hidden — no sneaking! Use Peek for a quick glance.';
  if (auto) $('btnPeek').style.display = 'inline-block';
}

$('btnPeek').onclick = () => {
  // reveal for 2s only
  const meta = ROLE_META[myRole];
  const card = $('chitCard');
  card.classList.remove('hidden-chit');
  $('chitEmoji').textContent = meta.emoji;
  $('chitName').textContent = meta.name;
  $('chitPts').textContent = meta.pts;
  $('btnPeek').disabled = true;
  clearTimeout(peekTimeout);
  peekTimeout = setTimeout(() => { hideChit(false); $('btnPeek').disabled = false; }, 2000);
};

// ---------- guess ----------
socket.on('guessPhase', (d) => {
  $('chitZone').classList.remove('hidden');
  $('btnPeek').style.display = 'inline-block';
  const gz = $('guessZone');
  gz.classList.remove('hidden');
  currentSuspects = d.suspects;
  selectedSuspect = null;

  const iAm = d.sipahiId === myId;
  $('guessTitle').textContent = iAm
    ? '🕵️ You are the SIPAHI — catch the CHOR!'
    : `🕵️ ${d.sipahiName} (Sipahi) is choosing…`;
  $('guessSub').textContent = iAm
    ? 'Tap a suspect below, then Confirm. Wrong guess = points swapped!'
    : 'Wait… the Sipahi is interrogating suspects. 🤫';

  const box = $('suspects');
  box.innerHTML = '';
  d.suspects.forEach(s => {
    const div = document.createElement('div');
    div.className = 'suspect';
    div.innerHTML = `<span>🕵️ ${escapeHtml(s.name)} ${s.isBot ? '🤖' : ''}</span><span>${iAm ? '👉' : '…'}</span>`;
    if (iAm) {
      div.onclick = () => {
        selectedSuspect = s.id;
        [...box.children].forEach(c => c.classList.remove('sel'));
        div.classList.add('sel');
        $('btnConfirmGuess').disabled = false;
      };
    } else {
      div.style.opacity = '.7'; div.style.cursor = 'default';
    }
    box.appendChild(div);
  });

  // confirm button for sipahi
  let btn = $('btnConfirmGuess');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'btnConfirmGuess';
    btn.className = 'btn primary';
    btn.textContent = '✅ Confirm arrest';
    btn.style.marginTop = '8px';
    gz.appendChild(btn);
    btn.onclick = () => {
      if (!selectedSuspect) return toast('Pick a suspect first!');
      socket.emit('makeGuess', { suspectId: selectedSuspect });
      btn.disabled = true;
    };
  }
  btn.style.display = iAm ? 'block' : 'none';
  btn.disabled = true;

  // countdown display
  clearInterval(guessInt);
  guessLeft = d.guessSeconds;
  $('guessTimer').textContent = guessLeft;
  guessInt = setInterval(() => {
    guessLeft--;
    $('guessTimer').textContent = Math.max(0, guessLeft);
    if (guessLeft <= 0) clearInterval(guessInt);
  }, 1000);
});

// ---------- result ----------
socket.on('roundResult', (d) => {
  clearInterval(guessInt);
  $('guessZone').classList.add('hidden');
  const rz = $('resultZone');
  rz.classList.remove('hidden');

  const sipahiName = d.roles[d.sipahiId]?.name || 'Sipahi';
  const suspectName = d.roles[d.suspectId]?.name || '?';
  const chorId = Object.keys(d.roles).find(id => d.roles[id].role === 'chor');
  const chorName = d.roles[chorId]?.name || '?';

  $('resTitle').textContent = d.correct
    ? `✅ Caught! ${sipahiName} nabbed ${chorName} (Chor)! +500 Sipahi 🎉`
    : `❌ Wrong! ${sipahiName} accused ${suspectName}, real Chor was ${chorName}! Chor +500 😱`;

  const cards = $('resCards');
  cards.innerHTML = '';
  Object.entries(d.roles).forEach(([id, r]) => {
    const m = ROLE_META[r.role];
    const div = document.createElement('div');
    div.className = 'rescard';
    div.innerHTML = `<div class="e">${m.emoji}</div><b>${m.name}</b><br>${escapeHtml(r.name)}${id === myId ? ' (you)' : ''}<br><small>+${r.points} pts</small>`;
    cards.appendChild(div);
  });

  renderScores(d.players);
  let html = '<table><tr><th>Player</th><th>Total</th></tr>';
  [...d.players].sort((a, b) => b.score - a.score).forEach(p => {
    html += `<tr><td>${escapeHtml(p.name)} ${p.id === myId ? '(you)' : ''}</td><td>⭐ ${p.score}</td></tr>`;
  });
  $('resTable').innerHTML = html + '</table>';

  $('btnNext').textContent = d.isLastRound ? '🏁 See winner' : 'Next round ➜';
  $('btnNext').style.display = isHost ? 'block' : 'none';
  if (!isHost) {
    let w = $('waitHost');
    if (!w) {
      w = document.createElement('p'); w.id = 'waitHost'; w.className = 'muted';
      w.textContent = 'Waiting for host to continue… ⏳';
      rz.appendChild(w);
    }
    w.style.display = 'block';
  } else {
    const w = $('waitHost'); if (w) w.style.display = 'none';
  }
});

$('btnNext').onclick = () => socket.emit('nextRound');

socket.on('gameOver', (d) => {
  $('resultZone').classList.add('hidden');
  $('guessZone').classList.add('hidden');
  $('overZone').classList.remove('hidden');
  renderScores(d.players);
  $('overTitle').textContent = d.winner.id === myId
    ? `🏆 You win, ${d.winner.name}! 🎉`
    : `🏆 ${d.winner.name} wins with ${d.winner.score} pts!`;
  const pod = $('podium');
  pod.innerHTML = '';
  const medals = ['🥇', '🥈', '🥉', '4️⃣'];
  [...d.players].sort((a, b) => b.score - a.score).forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'player';
    div.innerHTML = `<span>${medals[i] || ''} ${escapeHtml(p.name)}${p.id === myId ? ' (you)' : ''}</span><span>⭐ <b>${p.score}</b></span>`;
    pod.appendChild(div);
  });
  $('btnAgain').style.display = isHost ? 'block' : 'none';
});

$('btnAgain').onclick = () => {
  socket.emit('restartGame');
  show('screen-lobby');
};

// ---------- room chat ----------
let chatOpen = false, unread = 0;
function updateBadge() {
  const b = $('chatBadge');
  b.textContent = unread > 9 ? '9+' : unread;
  b.classList.toggle('hidden', unread === 0);
}
function addChatMsg(m) {
  const box = $('chatMsgs');
  const div = document.createElement('div');
  if (m.sys) {
    div.className = 'cmsg sys';
    div.textContent = m.text;
  } else {
    const mine = m.playerId === myId;
    div.className = 'cmsg' + (mine ? ' mine' : '');
    const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `<div class="cname">${escapeHtml(m.name)} · ${time}</div><div class="ctext"></div>`;
    div.querySelector('.ctext').textContent = m.text;
  }
  box.appendChild(div);
  while (box.children.length > 50) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}
socket.on('chatMsg', (m) => {
  addChatMsg(m);
  if (!chatOpen) { unread++; updateBadge(); }
});
function setChat(open) {
  chatOpen = open;
  $('chatPanel').classList.toggle('hidden', !open);
  if (open) { unread = 0; updateBadge(); $('chatText').focus(); }
}
$('chatFab').onclick = () => setChat(!chatOpen);
$('chatClose').onclick = () => setChat(false);
function sendChat() {
  const inp = $('chatText');
  const text = inp.value.trim();
  if (!text) return;
  socket.emit('sendChat', { text });
  inp.value = '';
}
$('chatSend').onclick = sendChat;
$('chatText').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

socket.on('errorMsg', (m) => toast(m));
socket.on('connect', () => { $('connDot').className = 'dot online'; $('connText').textContent = 'connected'; });
socket.on('disconnect', () => { $('connDot').className = 'dot off'; $('connText').textContent = 'disconnected'; });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
