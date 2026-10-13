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
      text.textContent = `${f.icon || ICON[f.id] || '🐾'} ${f.name}${f.animal === 'Avenger' ? '' : ` the ${f.animal}`} - ${f.job ? `${f.job}: ${f.blurb}` : 'No job assigned'}`;
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
  $('teamPreview').alt = avengers ? 'The fifteen Avengers pixel characters, including eight new teammates without assigned jobs' : 'Original Shadow panther';
  $('teamPreview').classList.toggle('original', !avengers);
  $('teamDescription').textContent = avengers ? 'A team of fifteen Avengers. Choose one of the original seven heroes to lead. Vision, Scarlet Witch, Black Widow, Black Panther, Hawkeye, Ant-Man, Falcon and War Machine are visual teammates with no jobs or skills assigned.' : 'Your original panther with Atlas, Dash, Bolt, Sage, Zen and Tempo.';
  $('mainHeroField').classList.toggle('hidden', !avengers);
  $('heroMotion').classList.toggle('hidden', !avengers);
  showHeroMotion();
}
const HERO_MOVES = { ironman: 'Horizontal flight, rear thrusters and smooth landings', spiderman: 'Web swings and acrobatic arrivals', cap: 'Shield runs and defensive landings', thor: 'Hammer-powered leaps and lightning landings', strange: 'Portal arrivals and mystic glides', hulk: 'Heavy bounds, ground slams and landing dust', quicksilver: 'Fast dashes with blue and silver speed trails' };
function showHeroMotion() { $('heroMotion').textContent = HERO_MOVES[$('mainHero').value] || ''; }
$('mainHero').addEventListener('change', showHeroMotion);
$('appearance').addEventListener('change', () => showAppearance($('appearance').value));
$('restoreShadow').addEventListener('click', async () => {
  try {
    fill(await window.settingsApi.save({ appearance: 'shadow' }));
    setStatus('Original Shadow & friends restored ✓');
  } catch (err) { setStatus(`Could not restore: ${err.message}`, true); }
});
function fill({ settings: s, appearance: theme, providers: list, startWithWindows, configDir, calendar, update, friends, telegram, spotify, exams, hud }) {
  showWaContacts(s.whatsappContacts || []);
  $('appearance').value = s.appearance;
  $('mainHero').replaceChildren(...theme.heroes.map(hero => { const option = document.createElement('option'); option.value = hero.id; option.textContent = hero.name; return option; }));
  $('mainHero').value = s.mainHero;
  showAppearance(s.appearance);
  document.documentElement.dataset.appearance = s.appearance;
  document.title = `${theme.name} Settings`;
  document.querySelector('.logo').src = `${theme.assetPath}/icon.png`;
  document.querySelector('.sub').textContent = s.appearance === 'avengers' ? 'Your Avengers command center. Changes apply when you hit Save.' : 'Tune your panther. Changes apply instantly when you hit Save.';
  $('friendsDescription').textContent = s.appearance === 'avengers' ? 'Your Avengers team. The original six supporting roles stay available; the eight new characters have no jobs assigned. Call them by name, assemble the team, or choose Always to keep them around.' : "Shadow's gang - each one has a job and shows up to do it.";
  $('callGang').textContent = s.appearance === 'avengers' ? 'AVENGERS, ASSEMBLE! ⚡' : 'CALL THE GANG 🐾';
  $('nameHelp').textContent = s.appearance === 'avengers' ? 'The default name Shadow displays your selected hero’s name. Enter a custom name if you prefer.' : '';
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
  $('whatsappAutomation').checked = s.whatsappAutomation;
  $('whatsappCallType').value = s.whatsappCallType;
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
  $('hudTitle').textContent = s.appearance === 'avengers' ? 'Iron Man HUD' : 'HUD';
  $('hudHotkey').value = s.hudHotkey;
  $('hudSeconds').value = String(s.hudSeconds);
  $('weatherCity').value = s.weatherCity;
  $('hudSound').checked = s.hudSound;
  showHudKey(hud);
  $('jarvisTitle').textContent = `${hud ? hud.consoleName : 'J.A.R.V.I.S.'} console`;
  $('jarvisHotkey').value = s.jarvisHotkey;
  $('hudBrief').checked = s.hudBrief;
  $('hudBriefDelay').value = String(s.hudBriefDelay);
  $('hudDebrief').checked = s.hudDebrief;
  $('hudDebriefTime').value = s.hudDebriefTime;
  showDebriefTwin();
  const who = hud ? hud.consoleName : 'J.A.R.V.I.S.';
  $('voiceTitle').textContent = `${who}'s voice`;
  $('voiceOn').checked = s.voiceOn;
  $('voiceAuto').checked = s.voiceAuto;
  $('voiceRate').value = s.voiceRate;
  wantedVoice = s.voiceName;
  fillVoices();
  $('newsOn').checked = s.newsOn;
  $('newsBanking').checked = s.newsTopics.banking;
  $('newsIndia').checked = s.newsTopics.india;
  $('newsWorld').checked = s.newsTopics.world;
  $('newsTopic').value = s.newsTopic;

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
      mainHero: $('mainHero').value,
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
      whatsappAutomation: $('whatsappAutomation').checked,
      whatsappCallType: $('whatsappCallType').value,
      pcCare: $('pcCare').checked,
      telegramToken: $('telegramToken').value.trim(),
      telegramEnabled: $('telegramEnabled').checked,
      telegramNotify: $('telegramNotify').checked,
      phoneFiles: $('phoneFiles').checked,
      phoneFilesScope: (form.querySelector('input[name="phoneFilesScope"]:checked') || {}).value,
      musicService: (form.querySelector('input[name="musicService"]:checked') || {}).value,
      startupOnWake: $('startupOnWake').checked,
      examStudyTime: $('examStudyTime').value,
      hudHotkey: $('hudHotkey').value,
      hudSeconds: Number($('hudSeconds').value),
      hudSound: $('hudSound').checked,
      weatherCity: $('weatherCity').value.trim(),
      jarvisHotkey: $('jarvisHotkey').value,
      hudBrief: $('hudBrief').checked,
      hudBriefDelay: Number($('hudBriefDelay').value),
      hudDebrief: $('hudDebrief').checked,
      hudDebriefTime: $('hudDebriefTime').value,
      voiceOn: $('voiceOn').checked,
      voiceAuto: $('voiceAuto').checked,
      voiceName: $('voiceName').value,
      voiceRate: $('voiceRate').value,
      newsOn: $('newsOn').checked,
      newsTopics: { banking: $('newsBanking').checked, india: $('newsIndia').checked, world: $('newsWorld').checked },
      newsTopic: $('newsTopic').value.trim(),
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

// ---- WhatsApp saved numbers
function showWaContacts(list) {
  const ul = $('waContacts');
  ul.replaceChildren(
    ...list.map((c) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = `${c.name} · ${/^91\d{10}$/.test(c.phone) ? `+91 ${c.phone.slice(2, 7)} ${c.phone.slice(7)}` : `+${c.phone}`}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ghost';
      del.textContent = 'REMOVE';
      del.addEventListener('click', async () => {
        const r = await window.settingsApi.whatsappContacts({ type: 'contact-remove', name: c.name });
        $('waMsg').textContent = r.reply;
        showWaContacts(r.list);
      });
      li.append(span, del);
      return li;
    })
  );
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No numbers saved yet';
    ul.append(li);
  }
}
$('waAdd').addEventListener('click', async () => {
  const r = await window.settingsApi.whatsappContacts({ type: 'contact-add', name: $('waName').value.trim(), phone: $('waPhone').value.trim() });
  $('waMsg').textContent = r.reply;
  showWaContacts(r.list);
  if (/^Saved/.test(r.reply)) {
    $('waName').value = '';
    $('waPhone').value = '';
  }
});
// ---- WhatsApp Web engine (link by QR)
function showWaWeb(st) {
  if (!st) return;
  const dot = $('waWebDot'), text = $('waWebText');
  const me = st.me && (st.me.name || st.me.number) ? `${st.me.name || ''}${st.me.name && st.me.number ? ' · ' : ''}${st.me.number ? `+${st.me.number}` : ''}` : '';
  const view = {
    ready: ['ready', `Linked${me ? ` as ${me}` : ''} - messages go through WhatsApp Web`],
    qr: ['busy', 'Scan the QR code with your phone'],
    starting: ['busy', st.linked ? 'Reconnecting to WhatsApp Web…' : 'Starting WhatsApp Web…'],
    linking: ['busy', 'Linked - loading your chats…'],
    error: ['bad', st.error || 'WhatsApp Web stopped.'],
    off: ['', st.linked ? 'Linked - starts while WhatsApp automation is on' : 'Not linked'],
  }[st.state] || ['', st.state];
  if (!st.available && st.state !== 'ready') view.splice(0, 2, 'bad', 'The WhatsApp Web engine runs on Windows.');
  dot.className = `wa-dot ${view[0]}`;
  text.textContent = view[1];
  $('waQrBox').hidden = !(st.state === 'qr' && st.qrImage);
  if (st.qrImage) $('waQr').src = st.qrImage;
  const busy = ['starting', 'qr', 'linking'].includes(st.state);
  $('waLink').hidden = st.state === 'ready';
  $('waLink').disabled = busy || !st.available;
  $('waLink').textContent = st.linked && st.state !== 'qr' ? 'RECONNECT' : 'LINK WHATSAPP';
  $('waUnlink').hidden = !(st.linked || st.state === 'ready' || busy);
}
window.settingsApi.onWaWebStatus(showWaWeb);
window.settingsApi.waWebStatus().then(showWaWeb).catch(() => {});
$('waLink').addEventListener('click', async () => {
  $('whatsappAutomation').checked = true; // linking turns WhatsApp automation on (main does the same)
  $('waLink').disabled = true;
  showWaWeb(await window.settingsApi.linkWaWeb());
});
$('waUnlink').addEventListener('click', async () => {
  $('waUnlink').disabled = true;
  try {
    showWaWeb(await window.settingsApi.unlinkWaWeb());
  } finally {
    $('waUnlink').disabled = false;
  }
});
$('checkWhatsApp').addEventListener('click', async () => {
  const button = $('checkWhatsApp'), out = $('whatsappResult');
  button.disabled = true;
  out.className = 'test-result';
  out.textContent = 'Checking the open WhatsApp Windows app…';
  $('whatsappDiagnostics').hidden = true;
  try {
    const result = await window.settingsApi.checkWhatsApp();
    out.textContent = result.text;
    out.classList.add(result.ok ? 'ok' : 'bad');
    $('whatsappDiagnosticsText').textContent = result.diagnostics || '';
    $('whatsappDiagnostics').hidden = !result.diagnostics;
  } catch { out.textContent = 'Could not check WhatsApp. Open the app and try again.'; }
  finally { button.disabled = false; }
});
$('stopWhatsApp').addEventListener('click', async () => {
  $('whatsappResult').textContent = await window.settingsApi.stopWhatsApp();
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

/** Whether the HUD hotkeys work (another app may already use one). */
function showHudKey(hud) {
  keyNote($('hudKeyNote'), hud && { key: hud.key, taken: hud.taken }, 'No hotkey - open it from the chat ("hud") or the tray menu.');
  keyNote($('jarvisKeyNote'), hud && { key: hud.jarvisKey, taken: hud.jarvisTaken }, 'No hotkey - say "jarvis" in the chat or use the tray menu.');
}
/** "21:00" -> the twin debrief 12 hours later ("and 9:00 AM"). */
function showDebriefTwin() {
  const [h, m] = ($('hudDebriefTime').value || '21:00').split(':').map(Number);
  const t = (h + 12) % 24;
  $('debriefTwin').textContent = `and ${t % 12 || 12}:${String(m).padStart(2, '0')} ${t < 12 ? 'AM' : 'PM'}`;
}
$('hudDebriefTime').addEventListener('input', showDebriefTwin);
$('briefNow').addEventListener('click', () => window.settingsApi.reportNow('brief'));
$('newsNow').addEventListener('click', () => window.settingsApi.reportNow('news'));

// ---- her voice: the Windows voices this PC has (the HUD uses the same ones)
let wantedVoice = '';
const englishVoices = () => {
  try {
    return speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  } catch {
    return [];
  }
};
function fillVoices() {
  const sel = $('voiceName');
  const list = englishVoices();
  sel.replaceChildren(
    new Option('Auto - a female voice (Indian English first)', ''),
    ...list.map((v) => new Option(`${v.name.replace(/^Microsoft /, '')}${v.localService ? '' : ' (online)'}`, v.name))
  );
  if (wantedVoice && !list.some((v) => v.name === wantedVoice)) sel.append(new Option(`${wantedVoice} (not on this PC)`, wantedVoice));
  sel.value = wantedVoice;
  $('voiceNote').textContent = list.length ? `${list.length} English voice${list.length === 1 ? '' : 's'} on this PC` : 'No voices found here - the HUD will use Windows\' own speech.';
}
try {
  speechSynthesis.addEventListener('voiceschanged', fillVoices);
} catch {
  /* no speech here */
}
$('voiceTest').addEventListener('click', () => {
  const list = englishVoices();
  const name = $('voiceName').value;
  const v = list.find((x) => x.name === name) || list.find((x) => /heera|neerja|zira|hazel|susan|aria|jenny|libby|sonia|female/i.test(x.name)) || list[0];
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance("Hello Prince. This is how I'll sound when I brief you.");
    if (v) u.voice = v;
    u.rate = { slow: 0.9, normal: 1, fast: 1.15 }[$('voiceRate').value] || 1;
    u.pitch = 1.05;
    speechSynthesis.speak(u);
    $('voiceNote').textContent = v ? `Speaking: ${v.name.replace(/^Microsoft /, '')}` : 'Speaking with the default voice';
  } catch {
    $('voiceNote').textContent = 'Could not play a voice here.';
  }
});
$('debriefNow').addEventListener('click', () => window.settingsApi.reportNow('debrief'));
function keyNote(note, hud, none) {
  if (!hud || !hud.key) {
    note.textContent = none;
    note.className = 'note';
  } else if (hud.taken) {
    note.textContent = `${hud.key} is already used by another app - pick a different one.`;
    note.className = 'note warn';
  } else {
    note.textContent = `Press ${hud.key} anywhere to open or close it.`;
    note.className = 'note';
  }
}
$('hudShow').addEventListener('click', () => window.settingsApi.showHud());

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
