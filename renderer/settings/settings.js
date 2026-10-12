'use strict';

const $ = (id) => document.getElementById(id);
const form = $('form');
const status = $('status');
let statusTimer = null;

// AI brain: one key per provider, kept here while you switch the dropdown around
let providers = [];
let keys = {};
let currentProvider = 'gemini';
const GCAL_SETTINGS_URL = 'https://calendar.google.com/calendar/r/settings';

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.textContent = ''), 3500);
}

function provider(id = currentProvider) {
  return providers.find((p) => p.id === id) || providers[0];
}

function stashKey() {
  const v = $('apiKey').value.trim();
  if (v) keys[currentProvider] = v;
  else delete keys[currentProvider];
}

function showProvider(id) {
  currentProvider = id;
  const p = provider(id);
  $('aiProvider').value = p.id;
  $('providerHelp').textContent = p.help;
  $('apiKey').value = keys[p.id] || '';
  $('keyField').classList.toggle('hidden', !p.needsKey && p.id !== 'custom');
  $('getKey').classList.toggle('hidden', !p.keyUrl);
  $('getKey').textContent = p.id === 'ollama' ? 'DOWNLOAD OLLAMA ↗' : p.free ? 'GET A FREE KEY ↗' : 'GET A KEY ↗';
  $('urlField').classList.toggle('hidden', !p.usesBaseUrl);
  $('aiModel').placeholder = p.model || 'model name';
  $('testResult').textContent = '';
  $('testResult').className = 'test-result';
}

function when(ms, allDay) {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const day =
    d.toDateString() === today.toDateString()
      ? 'today'
      : d.toDateString() === tomorrow.toDateString()
        ? 'tomorrow'
        : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return allDay ? `${day} (all day)` : `${day} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

function showCalendarStatus(c) {
  const el = $('calStatus');
  el.classList.remove('bad');
  if (!c || !c.configured) {
    el.textContent = 'Not connected yet.';
    return;
  }
  if (c.error) {
    el.classList.add('bad');
    el.textContent = `⚠ ${c.error}${c.lastSync ? ` (using events from ${when(c.lastSync)})` : ''}`;
    return;
  }
  if (!c.lastSync) {
    el.textContent = 'Connecting…';
    return;
  }
  const next = c.next ? ` Next: "${c.next.title}" ${when(c.next.start, c.next.allDay)}.` : ' Nothing coming up in the next 2 weeks.';
  el.textContent = `✓ Connected, checked ${when(c.lastSync)}. ${c.count} event${c.count === 1 ? '' : 's'} in the next 2 weeks.${next}`;
}

function updateText(u) {
  if (!u) return '';
  const v = `Version ${u.currentVersion}`;
  switch (u.status) {
    case 'disabled':
      return `${v}. Updates only work in the installed app (not when started with npm start).`;
    case 'checking':
      return `${v}. Checking for updates…`;
    case 'downloading':
      return `${v}. Downloading ${u.version}… ${u.percent}%`;
    case 'ready':
      return `✨ ${u.version} is downloaded. Restart Shadow to finish (or it installs when Shadow quits).`;
    case 'up-to-date':
      return `✓ ${v} is the latest.`;
    case 'error':
      return `${v}. ⚠ ${u.error}`;
    default:
      return `${v}. Shadow checks for updates by itself every few hours.`;
  }
}

let updPoll = null;
function showUpdate(u) {
  $('updStatus').textContent = updateText(u);
  $('installUpd').classList.toggle('hidden', !u || u.status !== 'ready');
  $('checkUpd').disabled = !u || !u.enabled || ['checking', 'downloading'].includes(u.status);
  clearTimeout(updPoll);
  if (u && ['checking', 'downloading'].includes(u.status)) {
    updPoll = setTimeout(async () => showUpdate(await window.settingsApi.updateStatus()), 1000);
  }
}

const MODE_HELP = {
  always: 'They hang around Shadow all the time, and jump in to do their jobs.',
  working: 'A friend only comes out while it is doing its job, then goes home.',
  occasional: 'They come out for their jobs, plus a short playdate with Shadow now and then.',
};
const ICON = { atlas: '🦜', dash: '🐇', bolt: '🐒', sage: '🦉', zen: '🐢', tempo: '🐧' };
function showFriends(list, s) {
  form.querySelectorAll('input[name="friendsMode"]').forEach((r) => (r.checked = r.value === s.friendsMode));
  $('friendsModeHelp').textContent = MODE_HELP[s.friendsMode];
  $('friendList').replaceChildren(
    ...(list || []).map((f) => {
      const label = document.createElement('label');
      label.className = 'check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.friend = f.id;
      box.checked = f.enabled;
      const i = document.createElement('i');
      const text = document.createElement('span');
      text.textContent = `${f.icon || ICON[f.id] || '🐾'} ${f.name}${f.animal === 'Avenger' ? '' : ` the ${f.animal}`} - ${f.job}: ${f.blurb}`;
      label.append(box, i, text);
      return label;
    })
  );
}
const SCOPE_HELP = {
  folders: 'Desktop, Documents, Downloads, Pictures, Videos and Music (and everything inside them).',
  pc: 'Every drive and folder - except Windows/system folders, program folders and app data. Password/key files are never sent. Only your paired Telegram can ask, and this can only be changed here on the PC.',
};
let spotifyInfo = null;
form.addEventListener('change', (e) => {
  if (e.target.name === 'phoneFilesScope') $('scopeHelp').textContent = SCOPE_HELP[e.target.value];
  if (e.target.name === 'friendsMode') $('friendsModeHelp').textContent = MODE_HELP[e.target.value];
  if (e.target.name === 'musicService') showMusic(e.target.value, spotifyInfo);
});

let tgPoll = null;
let tgInfo = null;
function showTelegram(t) {
  tgInfo = t;
  if (!t) return;
  const st = $('tgStatus');
  st.classList.remove('bad');
  const bot = t.bot ? `@${t.bot}` : 'your bot';
  st.textContent = {
    off: 'Off.',
    connecting: 'Connecting to Telegram…',
    'waiting-pair': `Connected to ${bot} ✓ Now pair: click PAIR MY PHONE, or send ${t.pairCode} to ${bot}.`,
    paired: `✓ Paired! Text ${bot} from your phone.`,
    error: `⚠ ${t.error}`,
  }[t.state] || '';
  if (t.state === 'error') st.classList.add('bad');
  $('pairTg').classList.toggle('hidden', t.state !== 'waiting-pair');
  $('unpairTg').classList.toggle('hidden', !t.paired);
  clearTimeout(tgPoll);
  if (['connecting', 'waiting-pair'].includes(t.state)) tgPoll = setTimeout(async () => showTelegram(await window.settingsApi.telegramInfo()), 1500);
}

const MUSIC_HELP = {
  youtube: 'Say "play kesariya" or "play something chill" and the top YouTube video starts playing.',
  ytmusic: 'Songs open in YouTube Music and start playing.',
  spotify: 'Songs play on your Spotify. Connect your account once below.',
};
function showMusic(service, sp) {
  form.querySelectorAll('input[name="musicService"]').forEach((r) => (r.checked = r.value === service));
  $('musicHelp').textContent = MUSIC_HELP[service] || '';
  $('spotifyBox').classList.toggle('hidden', service !== 'spotify' && !(sp && sp.connected));
  if (!sp) return;
  const st = $('spStatus');
  st.classList.remove('bad');
  st.textContent = sp.connected
    ? `✓ Connected${sp.user ? ` as ${sp.user}` : ''} · ${sp.premium ? 'Premium - songs start by themselves 🎧' : "Free - Shadow opens the song, you tap play (Spotify's rule)"}`
    : sp.clientId
      ? 'Not connected (or Spotify logged Shadow out). Click CONNECT SPOTIFY.'
      : 'Not connected yet.';
  $('spRedirect').textContent = sp.redirectUri;
  if (sp.clientId && !$('spotifyClientId').value) $('spotifyClientId').value = sp.clientId;
  $('spSteps').classList.toggle('hidden', sp.connected);
  $('disconnectSp').classList.toggle('hidden', !sp.connected);
  $('connectSp').textContent = sp.connected ? 'RECONNECT' : 'CONNECT SPOTIFY';
}

function li(text, button, onClick) {
  const el = document.createElement('li');
  const span = document.createElement('span');
  span.textContent = text;
  el.append(span);
  if (button) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.textContent = button;
    b.addEventListener('click', onClick);
    el.append(b);
  }
  return el;
}
function emptyLi(text) {
  const el = li(text);
  el.className = 'empty';
  return el;
}

function showStartup(items, loginOn) {
  $('startupList').replaceChildren(
    ...(items.length
      ? items.map((step, i) =>
          li(`${i + 1}. ${step}`, 'REMOVE', async () => {
            const r = await window.settingsApi.startupEdit({ type: 'remove', item: step });
            showStartup(r.items, loginOn);
            $('startupMsg').textContent = r.reply;
          })
        )
      : [emptyLi('Nothing yet - add your usual apps below.')])
  );
  $('startupRun').disabled = !items.length;
  $('startupLoginNote').textContent = loginOn ? '' : '⚠ "Start with Windows" (Behaviour) is off, so this only runs when you say "run my startup routine".';
}

function showExams(list) {
  const nice = (k) => new Date(`${k}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  $('examList').replaceChildren(
    ...(list && list.length
      ? list.map((e) =>
          li(`📅 ${e.subject ? `${e.subject} exam` : 'Exam'} · ${nice(e.date)} · ${e.done}/${e.days} study days done`, 'REMOVE', async () => {
            showExams(await window.settingsApi.removeExam(e.id));
          })
        )
      : [emptyLi('No exams planned.')])
  );
}

function showAppearance(value) {
  const avengers = value === 'avengers';
  $('teamPreview').src = avengers ? '../../assets/themes/avengers/team.png' : '../../assets/icon.png';
  $('teamPreview').alt = avengers ? 'Iron Man, Spider-Man, Captain America, Thor, Doctor Strange, Hulk and Star-Lord pixel sprites' : 'Original Shadow panther';
  $('teamPreview').classList.toggle('original', !avengers);
  $('teamDescription').textContent = avengers ? 'Iron Man leads Spider-Man, Thor, Captain America, Doctor Strange, Hulk and Star-Lord. Every teammate keeps a job.' : 'Your original panther with Atlas, Dash, Bolt, Sage, Zen and Tempo.';
}
$('appearance').addEventListener('change', () => showAppearance($('appearance').value));
$('restoreShadow').addEventListener('click', async () => {
  try {
    fill(await window.settingsApi.save({ appearance: 'shadow' }));
    setStatus('Original Shadow & friends restored ✓');
  } catch (err) { setStatus(`Could not restore: ${err.message}`, true); }
});
function fill({ settings: s, appearance: theme, providers: list, startWithWindows, configDir, calendar, update, friends, telegram, spotify, exams }) {
  $('appearance').value = s.appearance;
  showAppearance(s.appearance);
  document.documentElement.dataset.appearance = s.appearance;
  document.title = `${theme.name} Settings`;
  document.querySelector('.logo').src = `${theme.assetPath}/icon.png`;
  document.querySelector('.sub').textContent = s.appearance === 'avengers' ? 'Your Avengers command center. Changes apply when you hit Save.' : 'Tune your panther. Changes apply instantly when you hit Save.';
  $('friendsDescription').textContent = s.appearance === 'avengers' ? 'Your Avengers team — each hero has a job and shows up to do it.' : "Shadow's gang - each one has a job and shows up to do it.";
  $('callGang').textContent = s.appearance === 'avengers' ? 'AVENGERS, ASSEMBLE! ⚡' : 'CALL THE GANG 🐾';
  $('nameHelp').textContent = s.appearance === 'avengers' ? 'The default name Shadow appears as Iron Man in Avengers mode. Enter a custom name if you prefer.' : '';
  $('pcControlLabel').textContent = `Let ${theme.name} open apps & folders and lock / sleep / screenshot my PC`;
  $('pcCareLabel').textContent = `${s.appearance === 'avengers' ? 'Hulk' : 'Zen'} warns me about low battery, full storage, RAM/CPU and internet`;
  $('petName').value = s.petName;
  form.querySelectorAll('input[name="scale"]').forEach((r) => (r.checked = Number(r.value) === s.scale));
  $('quipMinMinutes').value = s.quipMinMinutes;
  $('quipMaxMinutes').value = s.quipMaxMinutes;
  $('sleepTimeoutMinutes').value = s.sleepTimeoutMinutes;
  $('muteQuips').checked = s.muteQuips;
  $('startWithWindows').checked = startWithWindows;
  $('morningBriefing').checked = s.morningBriefing;
  $('todoNudges').checked = s.todoNudges;
  $('pcControl').checked = s.pcControl;
  $('pcCare').checked = s.pcCare;
  $('webSearch').checked = s.webSearch;
  $('searchKey').value = s.searchKey;
  $('configDir').textContent = configDir;
  $('calendarUrl').value = s.calendarUrl;
  $('calendarLeadMinutes').value = s.calendarLeadMinutes;
  $('calendarAtStart').checked = s.calendarAtStart;
  $('calendarInChat').checked = s.calendarInChat;
  showCalendarStatus(calendar);
  showUpdate(update);
  showFriends(friends, s);
  $('telegramToken').value = s.telegramToken;
  $('telegramEnabled').checked = s.telegramEnabled;
  $('telegramNotify').checked = s.telegramNotify;
  $('phoneFiles').checked = s.phoneFiles;
  form.querySelectorAll('input[name="phoneFilesScope"]').forEach((r) => (r.checked = r.value === s.phoneFilesScope));
  $('scopeHelp').textContent = SCOPE_HELP[s.phoneFilesScope];
  showTelegram(telegram);
  spotifyInfo = spotify;
  showMusic(s.musicService, spotify);
  showStartup(s.startupRoutine, startWithWindows);
  $('startupOnWake').checked = s.startupOnWake;
  $('examStudyTime').value = s.examStudyTime;
  showExams(exams);

  providers = list;
  keys = { ...s.apiKeys };
  const select = $('aiProvider');
  select.replaceChildren(
    ...providers.map((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      return o;
    })
  );
  $('aiModel').value = s.aiModel;
  $('aiBaseUrl').value = s.aiBaseUrl;
  showProvider(s.aiProvider);
}

function brainForm() {
  stashKey();
  return {
    provider: currentProvider,
    model: $('aiModel').value.trim(),
    baseUrl: $('aiBaseUrl').value.trim(),
    apiKey: keys[currentProvider] || '',
  };
}

$('aiProvider').addEventListener('change', (e) => {
  stashKey();
  // a model/base URL typed for one provider rarely fits another
  $('aiModel').value = '';
  $('aiBaseUrl').value = '';
  showProvider(e.target.value);
});

$('getKey').addEventListener('click', () => {
  const p = provider();
  if (p.keyUrl) window.settingsApi.openLink(p.keyUrl);
});

$('testAi').addEventListener('click', async () => {
  const out = $('testResult');
  const btn = $('testAi');
  btn.disabled = true;
  out.className = 'test-result';
  out.textContent = 'Thinking…';
  try {
    const r = await window.settingsApi.testAi(brainForm());
    out.classList.add(r.ok ? 'ok' : 'bad');
    out.textContent = r.ok ? `✓ Works! ${r.model} says: "${r.reply}"` : `✗ ${r.message}`;
    if (!r.ok && r.detail) out.title = r.detail;
  } catch (err) {
    out.classList.add('bad');
    out.textContent = `✗ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const min = Number($('quipMinMinutes').value);
  const max = Number($('quipMaxMinutes').value);
  if (max < min) return setStatus('"to" must be ≥ "every" minutes', true);
  const brain = brainForm();
  const calUrl = $('calendarUrl').value.trim();
  setStatus(calUrl ? 'Saving…' : '');
  try {
    const saved = await window.settingsApi.save({
      appearance: $('appearance').value,
      petName: $('petName').value,
      scale: Number(form.querySelector('input[name="scale"]:checked').value),
      quipMinMinutes: min,
      quipMaxMinutes: max,
      sleepTimeoutMinutes: Number($('sleepTimeoutMinutes').value),
      muteQuips: $('muteQuips').checked,
      startWithWindows: $('startWithWindows').checked,
      morningBriefing: $('morningBriefing').checked,
      todoNudges: $('todoNudges').checked,
      pcControl: $('pcControl').checked,
      pcCare: $('pcCare').checked,
      telegramToken: $('telegramToken').value.trim(),
      telegramEnabled: $('telegramEnabled').checked,
      telegramNotify: $('telegramNotify').checked,
      phoneFiles: $('phoneFiles').checked,
      phoneFilesScope: (form.querySelector('input[name="phoneFilesScope"]:checked') || {}).value,
      musicService: (form.querySelector('input[name="musicService"]:checked') || {}).value,
      startupOnWake: $('startupOnWake').checked,
      examStudyTime: $('examStudyTime').value,
      friendsMode: (form.querySelector('input[name="friendsMode"]:checked') || {}).value,
      friends: Object.fromEntries([...document.querySelectorAll('input[data-friend]')].map((b) => [b.dataset.friend, b.checked])),
      webSearch: $('webSearch').checked,
      searchKey: $('searchKey').value.trim(),
      aiProvider: brain.provider,
      aiModel: brain.model,
      aiBaseUrl: brain.baseUrl,
      apiKeys: keys,
      calendarUrl: calUrl,
      calendarLeadMinutes: Number($('calendarLeadMinutes').value),
      calendarAtStart: $('calendarAtStart').checked,
      calendarInChat: $('calendarInChat').checked,
    });
    fill(saved);
    if (calUrl && !saved.settings.calendarUrl) return setStatus('Saved, but that calendar link is not valid', true);
    setStatus('Saved ✓');
  } catch (err) {
    setStatus(`Could not save: ${err.message}`, true);
  }
});

$('reveal').addEventListener('click', () => {
  const k = $('apiKey');
  const show = k.type === 'password';
  k.type = show ? 'text' : 'password';
  $('reveal').textContent = show ? 'HIDE' : 'SHOW';
});

$('openBotFather').addEventListener('click', () => window.settingsApi.openLink('https://t.me/BotFather'));

// ---- Spotify
$('openSpDev').addEventListener('click', () => window.settingsApi.openLink('https://developer.spotify.com/dashboard'));
$('connectSp').addEventListener('click', async () => {
  const out = $('spResult');
  const btn = $('connectSp');
  btn.disabled = true;
  out.className = 'test-result';
  out.textContent = 'Approve Shadow on the Spotify page that just opened…';
  try {
    const r = await window.settingsApi.connectSpotify($('spotifyClientId').value.trim());
    out.classList.add(r.ok ? 'ok' : 'bad');
    out.textContent = r.ok ? '✓ Connected!' : `✗ ${r.message}`;
    if (r.ok) fill(await window.settingsApi.load());
  } catch (err) {
    out.classList.add('bad');
    out.textContent = `✗ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});
$('disconnectSp').addEventListener('click', async () => {
  spotifyInfo = await window.settingsApi.disconnectSpotify();
  fill(await window.settingsApi.load());
  $('spResult').textContent = 'Disconnected.';
});

// ---- startup routine
async function addStartup() {
  const v = $('startupAdd').value.trim();
  if (!v) return;
  const r = await window.settingsApi.startupEdit({ type: 'add', items: [v] });
  $('startupMsg').textContent = r.reply;
  $('startupAdd').value = '';
  showStartup(r.items, $('startWithWindows').checked);
}
$('startupAddBtn').addEventListener('click', addStartup);
$('startupAdd').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault(); // not a form submit
    addStartup();
  }
});
// ---- exam planner
$('examAddBtn').addEventListener('click', async () => {
  const subject = $('examSubject').value.trim();
  const date = $('examDate').value;
  const topics = $('examTopics').value.trim();
  if (!subject || !date) return ($('examMsg').textContent = 'Type the subject and pick the date.');
  // "1-8" on its own means chapters
  const r = await window.settingsApi.addExam({ subject, date, topics: /^\d/.test(topics) ? `chapters ${topics}` : topics });
  $('examMsg').textContent = r.reply;
  showExams(r.exams);
  if (r.exams.some((e) => e.subject.toLowerCase() === subject.toLowerCase() && e.date === date)) {
    $('examSubject').value = '';
    $('examTopics').value = '';
  }
});

$('startupRun').addEventListener('click', async () => {
  $('startupMsg').textContent = 'Running…';
  $('startupMsg').textContent = await window.settingsApi.startupRun();
});
$('pairTg').addEventListener('click', () => tgInfo && tgInfo.pairLink && window.settingsApi.openLink(tgInfo.pairLink));
$('unpairTg').addEventListener('click', async () => showTelegram(await window.settingsApi.unpairTelegram()));
$('revealTg').addEventListener('click', () => {
  const k = $('telegramToken');
  const show = k.type === 'password';
  k.type = show ? 'text' : 'password';
  $('revealTg').textContent = show ? 'HIDE' : 'SHOW';
});
$('testTg').addEventListener('click', async () => {
  const out = $('tgResult');
  out.className = 'test-result';
  out.textContent = 'Checking…';
  const r = await window.settingsApi.testTelegram($('telegramToken').value.trim());
  out.classList.add(r.ok ? 'ok' : 'bad');
  out.textContent = r.ok ? `✓ Works! Your bot is @${r.bot}. Tick the box and SAVE.` : `✗ ${r.message}`;
});

$('callGang').addEventListener('click', () => window.settingsApi.callGang());

$('getSearchKey').addEventListener('click', () => window.settingsApi.openLink('https://app.tavily.com/home'));
$('revealSearch').addEventListener('click', () => {
  const k = $('searchKey');
  const show = k.type === 'password';
  k.type = show ? 'text' : 'password';
  $('revealSearch').textContent = show ? 'HIDE' : 'SHOW';
});
$('testSearch').addEventListener('click', async () => {
  const out = $('searchResult');
  const btn = $('testSearch');
  btn.disabled = true;
  out.className = 'test-result';
  out.textContent = 'Searching…';
  try {
    const r = await window.settingsApi.testSearch($('searchKey').value.trim());
    out.classList.add(r.ok ? 'ok' : 'bad');
    out.textContent = r.ok ? `✓ ${r.engine} works! Found "${r.first}"${r.engine === 'Wikipedia' ? ' (add a Tavily key for news & live info)' : ''}` : `✗ ${r.message}`;
  } catch (err) {
    out.classList.add('bad');
    out.textContent = `✗ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$('checkUpd').addEventListener('click', async () => showUpdate(await window.settingsApi.checkUpdate()));
$('installUpd').addEventListener('click', () => window.settingsApi.installUpdate());

$('openGcal').addEventListener('click', () => window.settingsApi.openLink(GCAL_SETTINGS_URL));

$('revealCal').addEventListener('click', () => {
  const k = $('calendarUrl');
  const show = k.type === 'password';
  k.type = show ? 'text' : 'password';
  $('revealCal').textContent = show ? 'HIDE' : 'SHOW';
});

$('testCal').addEventListener('click', async () => {
  const out = $('calResult');
  const btn = $('testCal');
  btn.disabled = true;
  out.className = 'test-result';
  out.textContent = 'Checking…';
  try {
    const r = await window.settingsApi.testCalendar($('calendarUrl').value.trim());
    out.classList.add(r.ok ? 'ok' : 'bad');
    if (!r.ok) out.textContent = `✗ ${r.message}`;
    else if (!r.next) out.textContent = '✓ Works! Nothing on your calendar in the next 2 weeks.';
    else out.textContent = `✓ Works! ${r.count} event${r.count === 1 ? '' : 's'} soon. Next: "${r.next.title}" ${when(r.next.start, r.next.allDay)}. Hit SAVE to switch it on.`;
  } catch (err) {
    out.classList.add('bad');
    out.textContent = `✗ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

$('openConfig').addEventListener('click', () => window.settingsApi.openConfigFolder());

window.settingsApi.load().then(fill);
