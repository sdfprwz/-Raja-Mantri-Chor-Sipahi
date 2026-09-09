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
  raja:   { emoji: '👑', name: 'RAJA',   pts: '1000 pts (fixed)', img: 'assets/raja.jpg' },
  mantri: { emoji: '🎩', name: 'MANTRI', pts: '800 pts (fixed)', img: 'assets/mantari.jpg' },
  chor:   { emoji: '🥷', name: 'CHOR',   pts: '500 if hidden · 0 if caught', img: 'assets/chor.jpg' },
  sipahi: { emoji: '🕵️', name: 'SIPAHI', pts: '500 if catch · 0 if wrong', img: 'assets/sipahi.jpg' },
};
function setChitImg(role) {
  const img = document.getElementById('chitImg');
  if (!img) return;
  const src = (ROLE_META[role] || {}).img;
  if (!src) { img.classList.add('hidden'); img.removeAttribute('src'); return; }
  img.onerror = () => img.classList.add('hidden');
  img.onload = () => img.classList.remove('hidden');
  img.src = src;
  img.alt = role;
}

let myId = null, myRoom = null, myRole = null, isHost = false;
let revealLeft = 0, revealInt = null, peekTimeout = null, guessInt = null, guessLeft = 0;
let selectedSuspect = null, currentSuspects = [];
let curTotalRounds = 5, curRound = 0;

// ---------------- Sound alerts (Web Audio, no files needed) ----------------
const Sound = {
  ctx: null,
  enabled: localStorage.getItem('rmcs_sound') !== 'off',
  ensure() {
    if (!this.enabled) return null;
    try {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    } catch { return null; }
  },
  tone(freq, t0, dur, type = 'sine', vol = 0.18, slideTo = null) {
    const ctx = this.ensure();
    if (!ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, ctx.currentTime + t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, ctx.currentTime + t0 + dur);
    g.gain.setValueAtTime(0.0001, ctx.currentTime + t0);
    g.gain.exponentialRampToValueAtTime(vol, ctx.currentTime + t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t0 + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(ctx.currentTime + t0); o.stop(ctx.currentTime + t0 + dur + 0.05);
  },
  play(name) {
    if (!this.enabled) return;
    switch (name) {
      case 'click': this.tone(600, 0, 0.08, 'square', 0.06); break;
      case 'join': this.tone(520, 0, 0.12, 'sine', 0.15); this.tone(780, 0.1, 0.15, 'sine', 0.15); break;
      case 'leave': this.tone(400, 0, 0.15, 'sine', 0.12, 250); break;
      case 'roundStart': [523, 659, 784].forEach((f, i) => this.tone(f, i * 0.12, 0.22, 'triangle', 0.2)); break;
      case 'chitHide': this.tone(800, 0, 0.15, 'sine', 0.12, 300); break;
      case 'tick': this.tone(880, 0, 0.07, 'square', 0.07); break;
      case 'urgent': this.tone(1100, 0, 0.12, 'square', 0.1); break;
      case 'yourTurn': [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, i * 0.1, 0.18, 'triangle', 0.2)); break;
      case 'waiting': this.tone(440, 0, 0.2, 'sine', 0.12); this.tone(550, 0.18, 0.25, 'sine', 0.12); break;
      case 'correct': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i * 0.11, 0.25, 'triangle', 0.22)); break;
      case 'wrong': this.tone(220, 0, 0.3, 'sawtooth', 0.15, 110); this.tone(165, 0.25, 0.35, 'sawtooth', 0.12, 90); break;
      case 'win': [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone(f, i * 0.14, 0.3, 'triangle', 0.22)); break;
      case 'chat': this.tone(700, 0, 0.09, 'sine', 0.1); break;
      case 'next': this.tone(600, 0, 0.1, 'triangle', 0.14, 900); break;
    }
  },
  refreshBtn() {
    const b = $('btnSound');
    if (b) { b.textContent = this.enabled ? '🔊' : '🔇'; b.classList.toggle('muted', !this.enabled); }
  }
};
// unlock audio on first user gesture (autoplay policy)
['click', 'touchstart', 'keydown'].forEach(ev =>
  window.addEventListener(ev, () => Sound.ensure(), { once: true }));
Sound.refreshBtn();
$('btnSound').onclick = () => {
  Sound.enabled = !Sound.enabled;
  localStorage.setItem('rmcs_sound', Sound.enabled ? 'on' : 'off');
  Sound.refreshBtn();
  Sound.play('click');
  toast(Sound.enabled ? '🔊 Sound on' : '🔇 Sound off');
};

// ---------------- Rounds: free choice 1..500 + ♾️ endless (0) ----------------
const MAX_ROUNDS = 500;
function fmtRounds(t) { return (!t || t === 0) ? '♾️ endless' : `${t} round${t === 1 ? '' : 's'}`; }
function fmtRoundLabel(round, total) { return (!total || total === 0) ? `Round ${round} / ♾️` : `Round ${round}/${total}`; }
function readRounds(numEl, endEl, fallback) {
  if (endEl && endEl.checked) return 0;
  let n = parseInt(numEl && numEl.value, 10);
  if (!Number.isFinite(n)) return fallback;
  n = Math.round(n);
  if (n < 1) n = 1;
  if (n > MAX_ROUNDS) n = MAX_ROUNDS;
  return n;
}
function setRoundsUI(numEl, endEl, total) {
  const endless = !total || total === 0;
  if (endEl) endEl.checked = endless;
  if (numEl) {
    numEl.disabled = endless;
    if (!endless) numEl.value = total;
  }
}
const lbRounds = $('lbRounds'), lbEndless = $('lbEndless');
const inRounds = $('inRounds'), inEndless = $('inEndless');
const midRounds = $('midRounds'), midEndless = $('midEndless');
setRoundsUI(lbRounds, lbEndless, 5);
setRoundsUI(inRounds, inEndless, 5);
setRoundsUI(midRounds, midEndless, 5);
[[inRounds, inEndless], [lbRounds, lbEndless], [midRounds, midEndless]].forEach(([n, e]) => {
  if (e) e.onchange = () => { if (n) n.disabled = e.checked; Sound.play('click'); };
});

// ---------- home ----------
$('btnCreate').onclick = () => {
  Sound.play('click');
  const name = $('inName').value.trim() || 'Player';
  socket.emit('createRoom', { name, totalRounds: readRounds(inRounds, inEndless, 5) });
};
$('btnJoin').onclick = () => {
  Sound.play('click');
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
    d.innerHTML = `<span><b>${r.code}</b> · ${r.humans}👤 + ${r.bots}🤖 · ${fmtRounds(r.totalRounds)} · host ${escapeHtml(r.host)}</span>`;
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
  curRound = 0; prevPlayerCount = (d.players || []).length;
  if (d.totalRounds !== undefined) {
    curTotalRounds = d.totalRounds;
    setRoundsUI(lbRounds, lbEndless, d.totalRounds);
    setRoundsUI(midRounds, midEndless, d.totalRounds);
  }
  $('gCode').textContent = d.code;
  renderInvite(d.code);
  // clean invite ?room= from URL once joined (keeps address bar tidy)
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.get('room')) { u.searchParams.delete('room'); window.history.replaceState({}, '', u.pathname); }
  } catch {}
  $('chatMsgs').innerHTML = '';
  unread = 0; updateBadge();
  (d.chat || []).forEach(addChatMsg);
  $('chatFab').classList.remove('hidden');
  Sound.play('join');
  show('screen-lobby');
});
let prevPlayerCount = 0;
// ---- QR invite: link + scannable code (no manual code sharing needed) ----
function getInviteLink(code) {
  return `${window.location.origin}/?room=${encodeURIComponent(code)}`;
}
function renderInvite(code) {
  if (!code) return;
  const link = getInviteLink(code);
  const inp = $('inviteLink');
  if (inp) inp.value = link;
  const box = $('qrBox');
  if (!box) return;
  box.innerHTML = '';
  try {
    if (typeof QRCode !== 'undefined') {
      // eslint-disable-next-line no-new
      new QRCode(box, { text: link, width: 116, height: 116, correctLevel: QRCode.CorrectLevel.M });
    } else {
      throw new Error('no QR lib');
    }
  } catch {
    box.innerHTML = `<div class="qr-fallback">Scan N/A<br>${escapeHtml(code)}</div>`;
  }
}
$('btnCopyLink').onclick = async () => {
  const link = ($('inviteLink') && $('inviteLink').value) || getInviteLink(myRoom || '');
  try { await navigator.clipboard.writeText(link); toast('🔗 Invite link copied!'); }
  catch { $('inviteLink').select(); document.execCommand && document.execCommand('copy'); toast('🔗 Copy this link: ' + link); }
  Sound.play('click');
};
$('btnShare').onclick = async () => {
  const link = ($('inviteLink') && $('inviteLink').value) || getInviteLink(myRoom || '');
  const data = { title: 'Join my Raja-Mantri game!', text: `Join room ${myRoom} 👑`, url: link };
  if (navigator.share) {
    try { await navigator.share(data); } catch {}
  } else {
    try { await navigator.clipboard.writeText(`${data.text} ${link}`); toast('🔗 Invite copied — send it to friends!'); }
    catch { toast(link); }
  }
  Sound.play('click');
};
$('btnRegenQR').onclick = () => { Sound.play('click'); renderInvite(myRoom); toast('↻ QR refreshed'); };
// Deep-link: ?room=ABCD pre-fills join box so scanned players join in 1 tap
(function handleInviteParam() {
  try {
    const code = (new URLSearchParams(window.location.search).get('room') || '').trim().toUpperCase().slice(0, 4);
    if (!code) return;
    $('inCode').value = code;
    const b = $('inviteBanner');
    b.classList.remove('hidden');
    b.innerHTML = `🎉 Invited to room <b>${escapeHtml(code)}</b>? Enter your name & hit <b>🚪 Join Room</b>!`;
    toast(`🎉 Invite for room ${code} — hit Join!`);
    setTimeout(() => $('inName').focus(), 300);
  } catch {}
})();
socket.on('playerEvent', (e) => {
  if (!e || !e.text) return;
  toast(e.text);
  if (e.type === 'join' || e.type === 'botJoin') Sound.play('join');
  else if (e.type === 'leave' || e.type === 'botRemove') Sound.play('leave');
  else Sound.play('chat');
});
socket.on('roomUpdate', (room) => {
  if (room.code !== myRoom) return;
  myRoom = room.code;
  isHost = room.hostId === myId;
  $('lbCode').textContent = room.code;
  $('gCode').textContent = room.code;
  renderInvite(room.code);
  curTotalRounds = room.totalRounds;
  setRoundsUI(lbRounds, lbEndless, room.totalRounds);
  setRoundsUI(midRounds, midEndless, room.totalRounds);
  if (curRound > 0) $('gRound').textContent = fmtRoundLabel(curRound, curTotalRounds);
  // join/leave sounds come from playerEvent (with toast) — avoid double jingle here
  prevPlayerCount = room.players.length;

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
  // keep host mid-game bar in sync (visible only to host during active game)
  if (room.status === 'lobby' || room.status === 'gameover') {
    $('midGameControls').classList.add('hidden');
    if (room.status === 'lobby') curRound = 0;
  } else if ($('screen-game').classList.contains('hidden') === false) {
    refreshMidGame();
  }
});

$('btnCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(myRoom); toast('Room code copied: ' + myRoom); }
  catch { toast('Room code: ' + myRoom); }
};
$('btnAddBot').onclick = () => { Sound.play('click'); socket.emit('addBot'); };
function pushLobbyRounds() {
  const t = readRounds(lbRounds, lbEndless, curTotalRounds || 5);
  socket.emit('updateSettings', { totalRounds: t });
}
lbRounds.onchange = pushLobbyRounds;
if (lbEndless) lbEndless.onchange = pushLobbyRounds;
$('btnStart').onclick = () => { Sound.play('click'); socket.emit('startGame'); };
$('btnLeave1').onclick = () => { socket.emit('leaveRoom'); location.reload(); };
$('btnLeave2').onclick = () => { socket.emit('leaveRoom'); location.reload(); };

// host mid-game controls
function refreshMidGame() {
  $('midGameControls').classList.toggle('hidden', !isHost);
}
$('btnSetRounds').onclick = () => {
  Sound.play('click');
  const t = readRounds(midRounds, midEndless, curTotalRounds || 5);
  socket.emit('updateSettings', { totalRounds: t });
};
$('btnEndGame').onclick = () => {
  Sound.play('click');
  if (confirm('End the game now and show the winner?')) socket.emit('endGame');
};
socket.on('roundsUpdated', ({ totalRounds, currentRound }) => {
  curTotalRounds = totalRounds;
  if (currentRound) curRound = currentRound;
  setRoundsUI(lbRounds, lbEndless, totalRounds);
  setRoundsUI(midRounds, midEndless, totalRounds);
  if (curRound > 0) $('gRound').textContent = fmtRoundLabel(curRound, curTotalRounds);
  toast(`⚙️ Rounds set to ${fmtRounds(totalRounds)}`);
  Sound.play('next');
});

// ---------- rounds ----------
socket.on('roundAnnounce', ({ round, totalRounds }) => {
  show('screen-game');
  curRound = round; curTotalRounds = totalRounds;
  setRoundsUI(midRounds, midEndless, totalRounds);
  refreshMidGame();
  Sound.play('roundStart');
  $('overZone').classList.add('hidden');
  $('resultZone').classList.add('hidden');
  $('guessZone').classList.add('hidden');
  $('chitZone').classList.remove('hidden');
  $('gRound').textContent = fmtRoundLabel(round, totalRounds);
});

socket.on('roundStarted', (d) => {
  show('screen-game');
  curRound = d.round; curTotalRounds = d.totalRounds;
  setRoundsUI(midRounds, midEndless, d.totalRounds);
  refreshMidGame();
  Sound.play('roundStart');
  $('overZone').classList.add('hidden');
  $('resultZone').classList.add('hidden');
  $('guessZone').classList.add('hidden');
  $('chitZone').classList.remove('hidden');
  $('gRound').textContent = fmtRoundLabel(d.round, d.totalRounds);
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
  card.classList.add('chit-reveal');
  setTimeout(() => card.classList.remove('chit-reveal'), 600);
  $('chitEmoji').textContent = meta.emoji;
  $('chitName').textContent = meta.name;
  $('chitPts').textContent = meta.pts;
  setChitImg(role);
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
    if (revealLeft <= 3 && revealLeft > 0) Sound.play('tick');
    if (revealLeft <= 0) { clearInterval(revealInt); hideChit(); }
  }, 1000);
}

function hideChit(auto = true) {
  const card = $('chitCard');
  card.classList.add('hidden-chit');
  const img = $('chitImg');
  if (img) img.classList.add('hidden');
  $('chitEmoji').textContent = '🂠';
  $('chitName').textContent = 'HIDDEN';
  $('chitPts').textContent = myRole ? `You are: ${ROLE_META[myRole].name}` : '';
  $('chitTimer').textContent = '🔒';
  $('chitMsg').textContent = 'Chit hidden — no sneaking! Use Peek for a quick glance.';
  if (auto) {
    $('btnPeek').style.display = 'inline-block';
    Sound.play('chitHide');
  }
}

$('btnPeek').onclick = () => {
  Sound.play('click');
  // reveal for 2s only
  const meta = ROLE_META[myRole];
  const card = $('chitCard');
  card.classList.remove('hidden-chit');
  card.classList.add('chit-reveal');
  setTimeout(() => card.classList.remove('chit-reveal'), 600);
  $('chitEmoji').textContent = meta.emoji;
  $('chitName').textContent = meta.name;
  $('chitPts').textContent = meta.pts;
  setChitImg(myRole);
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
  Sound.play(iAm ? 'yourTurn' : 'waiting');
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
        Sound.play('click');
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
      Sound.play('click');
      socket.emit('makeGuess', { suspectId: selectedSuspect });
      btn.disabled = true;
    };
  }
  btn.style.display = iAm ? 'block' : 'none';
  btn.disabled = true;

  // countdown display + warning ticks in last 5s to alert players
  clearInterval(guessInt);
  guessLeft = d.guessSeconds;
  $('guessTimer').textContent = guessLeft;
  guessInt = setInterval(() => {
    guessLeft--;
    $('guessTimer').textContent = Math.max(0, guessLeft);
    if (guessLeft <= 5 && guessLeft > 0) Sound.play(guessLeft <= 2 ? 'urgent' : 'tick');
    if (guessLeft <= 0) clearInterval(guessInt);
  }, 1000);
});

// ---------- result ----------
socket.on('roundResult', (d) => {
  clearInterval(guessInt);
  Sound.play(d.correct ? 'correct' : 'wrong');
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
    const imgHtml = m.img ? `<img class="res-img" src="${m.img}" alt="${m.name}" loading="lazy" onerror="this.remove()" />` : '';
    div.innerHTML = `${imgHtml}<div class="e">${m.emoji}</div><div class="res-info"><b>${m.name}</b><span>${escapeHtml(r.name)}${id === myId ? ' (you)' : ''}</span><small>+${r.points} pts</small></div>`;
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

$('btnNext').onclick = () => { Sound.play('next'); socket.emit('nextRound'); };

socket.on('gameOver', (d) => {
  clearInterval(guessInt); clearInterval(revealInt);
  Sound.play('win');
  $('midGameControls').classList.add('hidden');
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
  Sound.play('click');
  curRound = 0;
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
  if (!m.sys && m.playerId !== myId) Sound.play('chat');
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

// ---------- landing slider (group -> chars -> play) + swipe/dots ----------
(function landingFX() {
  const slider = $('homeSlider'), track = $('homeSlides');
  if (slider && track) {
    const slides = [...track.querySelectorAll('.slide')];
    const prev = $('slidePrev'), next = $('slideNext'), dots = $('slideDots'), count = $('slideCount');
    let idx = 0;
    slides.forEach((_, i) => {
      const d = document.createElement('button');
      d.setAttribute('aria-label', 'Go to slide ' + (i + 1));
      d.onclick = () => { go(i); Sound.play('click'); };
      dots.appendChild(d);
    });
    function syncHeight() {
      const active = slides[idx];
      if (active) slider.style.height = 'auto';
    }
    function go(i) {
      idx = Math.max(0, Math.min(slides.length - 1, i));
      track.style.transform = `translateX(-${idx * 100}%)`;
      [...dots.children].forEach((d, j) => d.classList.toggle('on', j === idx));
      if (count) count.textContent = `${idx + 1} / ${slides.length}`;
      if (prev) prev.style.visibility = idx === 0 ? 'hidden' : 'visible';
      if (next) next.innerHTML = idx === slides.length - 1 ? '✓' : '›';
      syncHeight();
    }
    if (prev) prev.onclick = () => { go(idx - 1); Sound.play('click'); };
    if (next) next.onclick = () => {
      Sound.play('click');
      if (idx === slides.length - 1) go(0);
      else go(idx + 1);
    };
    // swipe
    let sx = null;
    track.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
    track.addEventListener('touchend', (e) => {
      if (sx === null) return;
      const dx = e.changedTouches[0].clientX - sx;
      if (Math.abs(dx) > 40) go(idx + (dx < 0 ? 1 : -1));
      sx = null;
    }, { passive: true });
    // keyboard
    document.addEventListener('keydown', (e) => {
      if ($('screen-home').classList.contains('hidden')) return;
      if (e.key === 'ArrowRight') go(idx + 1);
      if (e.key === 'ArrowLeft') go(idx - 1);
    });
    // invite deep-link jumps straight to play slide
    try {
      if (new URLSearchParams(window.location.search).get('room')) go(slides.length - 1);
    } catch {}
    window._goPlaySlide = () => go(slides.length - 1);
    const startHero = $('btnStartHero');
    if (startHero) startHero.onclick = () => { Sound.play('roundStart'); go(slides.length - 1); };
    go(0);
  }
})();
