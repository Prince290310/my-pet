'use strict';
/* Iron Man HUD page: boots up, shows what main sends (hud.js in main), fades out. */

const $ = (id) => document.getElementById(id);
const api = window.hud;
const body = document.body;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GB = 1024 ** 3;

let head = { title: 'STARK HUD', sub: 'MARK 85 · ONLINE', theme: 'stark', name: 'Prince', tutor: '', sound: true };
let on = false;
let interactive = false;
let clockTimer = null;
let leaveTimer = null;
let test = false;
const state = { system: null, slow: null, missions: null, music: undefined, weather: null, cpuHistory: [] };

/** <tag class="cls">text</tag> - all text goes in as text, never as HTML. */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = String(text);
  return e;
}
const gb = (b) => `${(b / GB).toFixed(b >= 100 * GB ? 0 : 1)} GB`;
const pad = (n) => String(n).padStart(2, '0');

// ------------------------------------------------------------------ reticle ticks (drawn once)
(function ticks() {
  const g = $('ticks');
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const major = i % 5 === 0;
    const r1 = major ? 146 : 151;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', 200 + Math.sin(a) * r1);
    line.setAttribute('y1', 200 - Math.cos(a) * r1);
    line.setAttribute('x2', 200 + Math.sin(a) * 157);
    line.setAttribute('y2', 200 - Math.cos(a) * 157);
    if (major) line.setAttribute('class', 'major');
    g.appendChild(line);
  }
})();

// ------------------------------------------------------------------ clock
function tick() {
  const d = new Date();
  const h = d.getHours();
  $('hm').textContent = `${h % 12 || 12}:${pad(d.getMinutes())}`;
  $('ampm').textContent = h < 12 ? 'AM' : 'PM';
  $('date').textContent = `${DAYS[d.getDay()]} · ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const hello = h < 5 ? 'Burning the midnight oil' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 21 ? 'Good evening' : 'Good night';
  $('greet').textContent = `${hello}, ${head.name}`;
  const C = 1030.4; // 2πr, r = 164
  $('sec').style.strokeDashoffset = String(C * (1 - (d.getSeconds() + 1) / 60));
}

/** Title letters "decode" from noise, like a suit booting. */
function decode(node, text, ms = 520) {
  const glyphs = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789#%&';
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const fixed = Math.floor(text.length * k);
    node.textContent = text
      .split('')
      .map((ch, i) => (i < fixed || ch === ' ' ? ch : glyphs[Math.floor(Math.random() * glyphs.length)]))
      .join('');
    if (k < 1 && on) requestAnimationFrame(step);
    else node.textContent = text;
  };
  requestAnimationFrame(step);
}

/** A short "power up" chirp (Web Audio, no sound files). */
function chirp() {
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.05, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(240, t);
    o.frequency.exponentialRampToValueAtTime(980, t + 0.28);
    o.connect(gain);
    o.start(t);
    o.stop(t + 0.45);
    const b = ctx.createOscillator();
    const bg = ctx.createGain();
    b.type = 'triangle';
    b.frequency.setValueAtTime(1760, t + 0.3);
    bg.gain.setValueAtTime(0.0001, t + 0.3);
    bg.gain.exponentialRampToValueAtTime(0.025, t + 0.32);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    b.connect(bg).connect(ctx.destination);
    b.start(t + 0.3);
    b.stop(t + 0.52);
    setTimeout(() => ctx.close().catch(() => {}), 900);
  } catch {
    /* no audio device - fine */
  }
}

// ------------------------------------------------------------------ show / hide
api.onShow((d) => {
  head = { ...head, ...(d.head || {}) };
  test = !!d.test;
  clearTimeout(leaveTimer);
  body.className = ''; // restart the boot animations
  void body.offsetWidth;
  body.classList.add('on', head.theme === 'shadow' ? 'shadow' : 'stark');
  if (interactive) body.classList.add('held');
  on = true;
  $('c-name').textContent = head.consoleName || 'J.A.R.V.I.S.';
  setMode(d.mode || 'hud', d.report, d.speak);
  $('sub').textContent = head.sub;
  decode($('title'), head.title);
  setStatus('BOOTING…', '');
  tick();
  clearInterval(clockTimer);
  clockTimer = setInterval(tick, 1000);
  if (head.sound && !test) chirp();
});

api.onHide(() => {
  stopSpeech();
  if (!on) return api.hidden();
  on = false;
  clearInterval(clockTimer);
  body.classList.remove('on');
  body.classList.add('leaving');
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    body.className = 'off';
    api.hidden();
  }, 420);
});

api.onTimer(({ ms }) => {
  const t = $('timer');
  t.classList.remove('run');
  t.classList.toggle('pinned', !ms);
  if (!ms) return;
  t.style.setProperty('--ms', `${ms}ms`);
  void t.offsetWidth;
  t.classList.add('run');
});

// panels take the mouse only while the cursor is on them (see HudDisplay.poll in main)
api.onCursor((c) => {
  let want = false;
  if (c.inside && on) {
    const at = document.elementFromPoint(c.x, c.y);
    want = !!(at && at.closest('.hit'));
  }
  if (c.interactive !== want) interactive = !want;
  if (want !== interactive) {
    interactive = want;
    api.interactive(want);
  }
  body.classList.toggle('held', want);
});

$('close').addEventListener('click', () => api.close());
$('open-console').addEventListener('click', () => api.openConsole());
$('r-ok').addEventListener('click', () => api.close());
$('r-mute').addEventListener('click', () => stopSpeech());
$('c-mute').addEventListener('click', () => stopSpeech());
api.onMute(() => stopSpeech());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.close();
});

// ------------------------------------------------------------------ modes: hud · jarvis · brief · debrief
let mode = 'hud';
function setMode(m, report, speakIt) {
  mode = m;
  body.classList.remove('mode-hud', 'mode-jarvis', 'mode-brief', 'mode-debrief', 'mode-news');
  body.classList.add(`mode-${m}`);
  if (m !== 'jarvis') lockOff();
  if (report) renderReport(report);
  if (report && speakIt) speak(report.speech || [], 'report');
  else if (m !== 'jarvis') stopSpeech();
  if (m === 'jarvis') focusInput();
}
api.onMode(({ mode: m, report, speak: speakIt }) => setMode(m, report, speakIt));
api.onFocus(() => focusInput());
function focusInput() {
  if (mode !== 'jarvis') return;
  requestAnimationFrame(() => $('q').focus());
}

// ------------------------------------------------------------------ J.A.R.V.I.S. console
let thinking = null;
$('ask').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('q').value.trim();
  if (!q || thinking) return;
  $('q').value = '';
  const log = $('log');
  log.append(el('div', 'ex-q', q));
  thinking = el('div', 'thinking', 'PROCESSING');
  log.append(thinking);
  $('c-state').textContent = 'WORKING';
  log.scrollTop = log.scrollHeight;
  lockOff();
  api.ask(q);
});

/** Text appears letter by letter, the way a HUD would print it. */
function typeOut(node, text, done) {
  const total = String(text);
  const ms = Math.min(1400, Math.max(250, total.length * 9));
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    node.textContent = total.slice(0, Math.ceil(total.length * k));
    const log = $('log');
    log.scrollTop = log.scrollHeight;
    if (k < 1 && on) requestAnimationFrame(step);
    else {
      node.textContent = total;
      if (done) done();
    }
  };
  if (test) {
    node.textContent = total; // the self-test reads it straight away
    if (done) done();
    return;
  }
  requestAnimationFrame(step);
}

api.onAnswer((r) => {
  if (thinking) thinking.remove();
  thinking = null;
  $('c-state').textContent = '';
  body.classList.remove('scanning', 'capturing');
  const log = $('log');
  const a = el('div', `ex-a${r.error ? ' err' : ''}${r.screen ? ' screen' : ''}`);
  log.append(a);
  typeOut(a, r.text || '…');
  if (Array.isArray(r.sources) && r.sources.length) {
    const src = el('div', 'ex-src');
    for (const x of r.sources.slice(0, 3)) {
      const b = el('button', 'hit', x.title || x.url);
      b.title = x.url;
      b.addEventListener('click', () => api.openLink(x.url));
      src.append(b);
    }
    log.append(src);
  }
  while (log.children.length > 24) log.firstChild.remove(); // keep the last few exchanges
  if (r.rect) lockOn(r.rect, r.label);
  focusInput();
  // she says it too (sentence by sentence, so it can be stopped in between)
  const sentences = String(r.text || '')
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((text) => ({ section: 'answer', text, el: a }));
  speak(sentences, 'answer');
});

api.onScan(({ phase }) => {
  if (phase === 'capture') {
    body.classList.add('capturing'); // see-through for the screenshot
    if (thinking) thinking.textContent = 'SCANNING SCREEN';
    $('c-state').textContent = 'SCANNING';
    requestAnimationFrame(() => requestAnimationFrame(() => api.scanReady()));
  } else if (phase === 'analyze') {
    body.classList.remove('capturing');
    body.classList.add('scanning');
    if (thinking) thinking.textContent = 'ANALYZING';
    $('c-state').textContent = 'ANALYZING';
  } else {
    body.classList.remove('capturing', 'scanning');
  }
});

function lockOn(r, label) {
  const box = $('lock');
  box.style.left = `${r.x}px`;
  box.style.top = `${r.y}px`;
  box.style.width = `${r.w}px`;
  box.style.height = `${r.h}px`;
  box.querySelector('span').textContent = label || 'TARGET';
  box.classList.remove('on');
  void box.offsetWidth;
  box.classList.add('on');
}
function lockOff() {
  $('lock').classList.remove('on');
}

// ------------------------------------------------------------------ her voice
// The page speaks with the Windows voices (a female English one; Indian English first). If it can't,
// main's backup voice (voice.js) reads the same lines and tells us which one it's on.
const FEMALE = /heera|neerja|kajal|swara|ananya|zira|hazel|susan|libby|sonia|maisie|aria|jenny|michelle|ana\b|emma|ava|catherine|natasha|linda|heather|eva\b|samantha|karen|moira|tessa|veena|serena|victoria|fiona|female|woman/i;
const MALE = /david|mark|ravi|prabhat|george|james|guy|ryan|daniel|alex\b|fred|rishi|thomas|william|brian|christopher|eric|roger|steffan|male\b/i;
const talk = { id: 0, items: [], fallback: false };
const synth = () => (typeof speechSynthesis === 'undefined' ? null : speechSynthesis);
function voiceList() {
  try {
    return synth() ? synth().getVoices() : [];
  } catch {
    return [];
  }
}
function pickVoice() {
  const all = voiceList();
  if (head.voiceName) {
    const v = all.find((x) => x.name === head.voiceName);
    if (v) return v;
  }
  const score = (v) => (FEMALE.test(v.name) ? 6 : 0) - (MALE.test(v.name) ? 6 : 0) + (/en[-_]IN/i.test(v.lang) ? 3 : /en[-_]GB/i.test(v.lang) ? 1 : 0) + (v.localService ? 1 : 0);
  return all.filter((v) => /^en/i.test(v.lang)).sort((a, b) => score(b) - score(a))[0] || null;
}
function voicesReady() {
  if (voiceList().length || !synth()) return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(r, 1500);
    synth().addEventListener('voiceschanged', () => (clearTimeout(t), r()), { once: true });
  });
}
function lit(item) {
  document.querySelectorAll('.lit').forEach((x) => x.classList.remove('lit'));
  if (!item) return;
  let node = null;
  if (item.el) node = item.el;
  else if (item.section === -1) node = $('r-summary');
  else if (Number.isInteger(item.section)) node = document.querySelector(`#r-sections .sec[data-i="${item.section}"]`);
  if (!node) return;
  node.classList.add('lit');
  if (node.closest('#r-sections')) node.scrollIntoView({ block: 'nearest', behavior: test ? 'auto' : 'smooth' });
}
/** Read the items aloud, one after another. A new speak() or stopSpeech() cuts it off. */
async function speak(items, what) {
  stopSpeech();
  if (!head.voice || !items.length) return;
  const id = ++talk.id;
  talk.items = items;
  body.classList.add('speaking');
  api.speech('start');
  if (test) {
    // the self-test can't hear: note what would be said, step through it quickly
    window.__spoken = (window.__spoken || []).concat(items.map((x) => x.text));
    for (const item of items) {
      if (id !== talk.id) return;
      lit(item);
      await new Promise((r) => setTimeout(r, window.__slowSpeech || 60));
    }
    return finishSpeech(id);
  }
  await voicesReady();
  if (id !== talk.id) return;
  const v = pickVoice();
  if (!v) return backupVoice(items, id);
  for (let i = 0; i < items.length; i++) {
    if (id !== talk.id) return;
    lit(items[i]);
    const r = await sayOne(items[i].text, v);
    if (r === 'stop' || id !== talk.id) return;
    if (r === 'fail') return backupVoice(items.slice(i), id); // this PC's browser speech doesn't work: Windows reads it
  }
  finishSpeech(id);
}
function sayOne(text, v) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = v;
    u.lang = v.lang;
    u.rate = head.voiceRate || 1;
    u.pitch = 1.05;
    let started = false;
    u.onstart = () => (started = true);
    u.onend = () => resolve('ok');
    u.onerror = (e) => resolve(e.error === 'interrupted' || e.error === 'canceled' ? 'stop' : 'fail');
    synth().speak(u);
    // some PCs never start (no audio device / blocked): don't hang
    setTimeout(() => !started && (synth().cancel(), resolve('fail')), 4000);
  });
}
function backupVoice(items, id) {
  talk.fallback = true;
  talk.items = items;
  api.speakFallback(items.map((x) => x.text));
  talk.fallbackId = id;
}
api.onSpeechLine(({ i }) => talk.fallback && lit(talk.items[i]));
api.onSpeechEnd(() => talk.fallback && finishSpeech(talk.fallbackId));
function finishSpeech(id) {
  if (id !== talk.id) return;
  talk.fallback = false;
  body.classList.remove('speaking');
  lit(null);
  api.speech('done');
}
function stopSpeech() {
  const was = body.classList.contains('speaking');
  talk.id++;
  try {
    if (synth()) synth().cancel();
  } catch {
    /* nothing to stop */
  }
  if (talk.fallback) api.stopFallback();
  talk.fallback = false;
  body.classList.remove('speaking');
  lit(null);
  if (was) api.speech('done');
}

// ------------------------------------------------------------------ briefing / debrief card
function renderReport(r) {
  $('r-title').textContent = r.title;
  $('r-sub').textContent = r.sub;
  typeOut($('r-summary'), r.summary);
  const tiles = $('r-tiles');
  tiles.replaceChildren(
    ...r.tiles.map((t) => {
      const d = el('div', `tile ${t.tone || ''}${String(t.value).length > 4 ? ' long' : ''}`);
      d.append(el('i', '', t.icon), el('b', '', t.value), el('small', '', t.label));
      return d;
    })
  );
  const secs = $('r-sections');
  secs.scrollTop = 0;
  secs.replaceChildren(
    ...r.sections.map((sec, i) => {
      const box = el('div', `sec${sec.wide ? ' wide' : ''}`);
      box.dataset.i = String(i);
      const ul = el('ul');
      for (const it of sec.items) {
        const li = el('li', `${it.tone || ''}${it.url ? ' link' : ''}`);
        li.append(el('i', '', it.icon), el('span', '', it.text));
        if (it.when) li.append(el('em', '', it.when));
        if (it.url) {
          li.title = 'Open in the browser';
          li.addEventListener('click', () => api.openLink(it.url));
        }
        ul.append(li);
      }
      box.append(el('h3', '', sec.title), ul);
      return box;
    })
  );
}
api.onReport((patch) => {
  if (patch.summary) typeOut($('r-summary'), patch.summary);
});
document.querySelectorAll('.ctl button').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.disabled) return;
    if (b.dataset.a === 'toggle' && state.music && !state.music.none) {
      state.music.playing = !state.music.playing; // feels instant; main sends the real state back
      renderMusic(state.music);
    }
    api.media(b.dataset.a);
  })
);

// ------------------------------------------------------------------ data
api.onData((d) => {
  if (d.system) renderSystem(d.system);
  if (d.slow) renderSlow(d.slow);
  if (d.missions) renderMissions(d.missions);
  if (d.music !== undefined) renderMusic(d.music);
  if (d.weather) renderWeather(d.weather);
  updateStatus();
});

// gold / red from these levels (% used)
const LIMITS = { 'g-cpu': [70, 90], 'g-ram': [80, 92], 'g-disk': [85, 95] };
function gauge(id, pctValue, text) {
  const g = $(id);
  const p = Number.isFinite(pctValue) ? Math.max(0, Math.min(100, pctValue)) : 0;
  const [warn, bad] = LIMITS[id];
  g.querySelector('.fill').style.strokeDashoffset = String(263.9 * (1 - p / 100));
  g.querySelector('.val span').textContent = text;
  g.classList.toggle('warn', p >= warn && p < bad);
  g.classList.toggle('bad', p >= bad);
}

function renderSystem(s) {
  state.system = s;
  if (Number.isFinite(s.cpu)) {
    gauge('g-cpu', s.cpu, `${s.cpu}%`);
    state.cpuHistory.push(s.cpu);
    if (state.cpuHistory.length > 40) state.cpuHistory.shift();
    const n = state.cpuHistory.length;
    const pts = state.cpuHistory.map((v, i) => `${n === 1 ? 200 : (i / (n - 1)) * 200},${(34 - (v / 100) * 32).toFixed(1)}`);
    $('spark-line').setAttribute('points', pts.join(' '));
    $('spark-area').setAttribute('points', n > 1 ? `0,36 ${pts.join(' ')} 200,36` : '');
  }
  if (s.ram) {
    gauge('g-ram', s.ram.pct, `${s.ram.pct}%`);
    $('mem').textContent = `${gb(s.ram.used)} / ${gb(s.ram.total)}`;
  }
  if (s.disk) {
    gauge('g-disk', s.disk.pct, `${s.disk.pct}%`);
    $('store').textContent = `${gb(s.disk.free)} free`;
    $('store').className = s.disk.free < 10 * GB ? 'bad' : s.disk.free < 25 * GB ? 'warn' : '';
  } else {
    $('store').textContent = '–';
  }
  if (Number.isFinite(s.uptimeH)) $('uptime').textContent = s.uptimeH >= 48 ? `${Math.floor(s.uptimeH / 24)} days` : `${s.uptimeH} h`;
  renderSlow({ battery: s.battery, online: s.online }); // the last battery / internet readings, if any
}

function renderSlow(s) {
  const now = { ...(state.slow || {}) };
  if (s.battery !== undefined) now.battery = s.battery;
  if (s.online === true || s.online === false) now.online = s.online;
  state.slow = now;
  const p = $('power');
  if (!('battery' in now)) {
    /* still reading */
  } else if (!now.battery) {
    p.textContent = 'AC POWER';
    p.className = '';
  } else {
    const n = Math.round(now.battery.percent);
    p.textContent = `${n}%${now.battery.charging ? ' · CHARGING' : ''}`;
    p.className = now.battery.charging ? 'good' : n <= 15 ? 'bad' : n <= 30 ? 'warn' : '';
  }
  const net = $('net');
  if (now.online === true) {
    net.textContent = 'ONLINE';
    net.className = 'good';
  } else if (now.online === false) {
    net.textContent = 'OFFLINE';
    net.className = 'bad';
  }
}

function renderMissions(m) {
  state.missions = m;
  const exam = $('exam');
  exam.replaceChildren();
  if (m.exam) {
    const e = m.exam;
    const box = el('div', `exam${e.days <= 0 ? ' now' : ''}`);
    const count = el('div', 'count');
    count.append(el('b', '', e.days <= 0 ? '!!' : pad(e.days)), el('small', '', e.days <= 0 ? 'TODAY' : e.days === 1 ? 'DAY' : 'DAYS'));
    const info = el('div', 'info');
    const bar = el('div', 'bar');
    const fill = el('i');
    bar.append(fill);
    info.append(el('div', 'subj', `${e.subject} exam`), el('div', 'when', `${e.dateText} · ${e.countdown}`), bar, el('div', 'prog', `STUDY PLAN ${e.progress.done}/${e.progress.total}`));
    box.append(count, info);
    exam.append(box);
    requestAnimationFrame(() => (fill.style.width = `${e.progress.total ? Math.round((100 * e.progress.done) / e.progress.total) : 0}%`));
    if (e.today.length) {
      exam.append(el('h3', '', "TODAY'S TRAINING"));
      const ul = el('ul', 'train');
      for (const t of e.today.slice(0, 3)) {
        const li = el('li', t.done ? 'done' : '');
        li.append(el('i', '', t.done ? '✅' : t.icon), el('span', '', t.text), el('em', '', t.subject));
        ul.append(li);
      }
      exam.append(ul);
    }
    const later = (m.nextExams || []).slice(1);
    if (later.length) exam.append(el('div', 'then', `THEN: ${later.map((x) => `${x.subject} (${x.days}d)`).join(' · ')}`));
  } else {
    exam.append(el('div', 'muted', `No exams on the radar. Say "my exams: maths 20 nov ch 1-8" and ${head.tutor || 'your tutor'} plans it.`));
  }

  const ev = $('event');
  ev.replaceChildren();
  ev.className = m.event && m.event.soon ? 'soon' : '';
  if (m.event) ev.append(el('span', '', `📅 ${m.event.title}`), el('small', '', m.event.when));

  $('todo-count').textContent = m.todoCount ? `· ${m.todoCount}` : '';
  const todos = $('todos');
  todos.replaceChildren();
  if (!m.todos.length) todos.append(el('li', 'muted', 'All objectives clear ✓'));
  m.todos.forEach((t, i) => {
    const li = el('li', i >= 3 ? 'extra' : '');
    const btn = el('button', 'check hit');
    btn.title = 'Mark done';
    btn.setAttribute('aria-label', `Mark "${t.text}" done`);
    btn.innerHTML = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5l2.5 2.5L10 3"/></svg>'; // fixed markup, no data
    btn.addEventListener('click', () => {
      if (li.classList.contains('done')) return;
      li.classList.add('done');
      api.todoDone(t.id);
    });
    const label = el('span', '', t.text);
    if (t.repeat) {
      const tag = el('b', 'rep', '🔁'); // comes back by itself (tasks.js)
      tag.title = 'Repeats - comes back by itself';
      label.prepend(tag);
    }
    li.append(btn, label);
    todos.append(li);
  });

  const rems = $('rems');
  rems.replaceChildren();
  $('rems-head').style.display = m.reminders.length ? '' : 'none';
  m.reminders.forEach((r, i) => {
    const li = el('li', i >= 1 ? 'extra' : '');
    li.append(el('i', '', '⏰'), el('span', '', r.text), el('em', '', r.when));
    rems.append(li);
  });
  fitMission();
}

/** Short screen: the mission board fades out at the bottom instead of running into the weather. */
function fitMission() {
  const box = $('mission');
  const inner = box.querySelector('.scroll');
  box.classList.toggle('clipped', inner.scrollHeight > inner.clientHeight + 2);
}
window.addEventListener('resize', fitMission);

function renderMusic(m) {
  state.music = m;
  const panel = $('music');
  const buttons = panel.querySelectorAll('.ctl button');
  panel.classList.toggle('playing', !!(m && m.playing));
  buttons.forEach((b) => (b.disabled = !m));
  if (m === null) {
    $('song').textContent = 'Music controls need Windows';
    $('artist').textContent = '';
  } else if (m.none) {
    $('song').textContent = 'No audio signal';
    $('artist').textContent = 'Say "play lofi" to start something';
  } else {
    $('song').textContent = m.title || 'Unknown track';
    $('artist').textContent = [m.artist, m.app].filter(Boolean).join(' · ') + (m.playing ? '' : ' · PAUSED');
  }
}

function renderWeather(w) {
  state.weather = w;
  const box = $('wx');
  box.replaceChildren();
  if (!w.ok) {
    const msg = {
      'no-city': ['SET YOUR CITY', 'Say "set my city to Jaipur" (or Settings → HUD) and the weather shows up here.'],
      'unknown-city': ['CITY NOT FOUND', `Couldn't find "${w.city || ''}". Try the nearest big city.`],
    }[w.reason] || ['SENSORS OFFLINE', "Couldn't reach the weather service right now."];
    const text = el('div', 'wx-text');
    text.append(el('b', 'warn', msg[0]));
    box.append(text, el('div', 'muted', msg[1]));
    return;
  }
  const main = el('div', 'wx-main');
  const temp = el('div', 'wx-temp', w.now.temp);
  temp.append(el('sup', '', '°C'));
  const text = el('div', 'wx-text');
  text.append(el('b', '', w.now.text), el('span', '', [w.place, w.country].filter(Boolean).join(', ')));
  main.append(el('div', 'wx-icon', w.now.icon), temp, text);
  const rows = el('ul', 'rows');
  const row = (k, v, cls = '', extra = false) => {
    const li = el('li', extra ? 'extra' : '');
    li.append(el('span', '', k), el('b', cls, v));
    rows.append(li);
  };
  row('FEELS LIKE', `${w.now.feels}°C`);
  if (w.today.min !== null) row('TODAY', `${w.today.min}° – ${w.today.max}°`);
  if (w.today.rain !== null) row('RAIN', `${w.today.rain}%`, w.today.rain >= 60 ? 'warn' : '');
  row('HUMIDITY · WIND', `${w.now.humidity}% · ${w.now.wind} km/h`, '', true);
  if (w.tomorrow && w.tomorrow.min !== null) row('TOMORROW', `${w.tomorrow.icon} ${w.tomorrow.min}° – ${w.tomorrow.max}°`, '', true);
  box.append(main, rows);
}

/** The line at the bottom: the most important thing right now. */
function updateStatus() {
  const s = state.system || {};
  const slow = state.slow || {};
  const m = state.missions || {};
  const bat = slow.battery;
  if (bat && !bat.charging && bat.percent <= 15) return setStatus(`POWER CRITICAL · ${Math.round(bat.percent)}% · PLUG IN`, 'bad');
  if (slow.online === false) return setStatus('NO UPLINK · YOU ARE OFFLINE', 'bad');
  if (s.disk && s.disk.free < 10 * GB) return setStatus(`STORAGE LOW · ${gb(s.disk.free)} LEFT`, 'bad');
  if (m.exam && m.exam.days <= 0) return setStatus(`EXAM DAY · ${m.exam.subject.toUpperCase()} · YOU GOT THIS`, 'warn');
  if (Number.isFinite(s.cpu) && s.cpu >= 90) return setStatus(`CPU UNDER HEAVY LOAD · ${s.cpu}%`, 'warn');
  if (bat && !bat.charging && bat.percent <= 30) return setStatus(`POWER LOW · ${Math.round(bat.percent)}%`, 'warn');
  if (m.event && m.event.soon) return setStatus(`INCOMING · ${m.event.title.toUpperCase()} · ${m.event.when.toUpperCase()}`, 'warn');
  if (m.exam && m.exam.days === 1) return setStatus(`${m.exam.subject.toUpperCase()} EXAM TOMORROW · FINAL PREP`, 'warn');
  if (state.system) setStatus('ALL SYSTEMS NOMINAL', 'good');
}

function setStatus(text, cls) {
  $('status-text').textContent = text;
  $('status').className = cls;
}

// self-test hook: what's on screen
window.__hudTest = {
  state: () => ({
    on,
    interactive,
    body: body.className,
    title: head.title,
    time: $('hm').textContent,
    status: $('status-text').textContent,
    statusClass: $('status').className,
    timerMs: $('timer').classList.contains('run') ? $('timer').style.getPropertyValue('--ms') : 'off',
    playing: $('music').classList.contains('playing'),
    mode,
    speaking: body.classList.contains('speaking'),
    spoken: window.__spoken || [],
    lit: (() => { const x = document.querySelector('.lit'); return x ? x.dataset.i || x.id || x.className : ''; })(),
    focused: document.activeElement === $('q'),
    log: $('log').innerText,
    thinking: !!thinking,
    lock: $('lock').classList.contains('on') ? { x: parseFloat($('lock').style.left), y: parseFloat($('lock').style.top), w: parseFloat($('lock').style.width), h: parseFloat($('lock').style.height) } : null,
    report: { title: $('r-title').textContent, sub: $('r-sub').textContent, summary: $('r-summary').textContent, text: $('report').innerText },
  }),
  rect: (sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  },
};

api.ready();
