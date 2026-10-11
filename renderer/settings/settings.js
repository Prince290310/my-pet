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

function fill({ settings: s, providers: list, startWithWindows, configDir, calendar, update }) {
  $('petName').value = s.petName;
  form.querySelectorAll('input[name="scale"]').forEach((r) => (r.checked = Number(r.value) === s.scale));
  $('quipMinMinutes').value = s.quipMinMinutes;
  $('quipMaxMinutes').value = s.quipMaxMinutes;
  $('sleepTimeoutMinutes').value = s.sleepTimeoutMinutes;
  $('muteQuips').checked = s.muteQuips;
  $('startWithWindows').checked = startWithWindows;
  $('morningBriefing').checked = s.morningBriefing;
  $('todoNudges').checked = s.todoNudges;
  $('webSearch').checked = s.webSearch;
  $('searchKey').value = s.searchKey;
  $('configDir').textContent = configDir;
  $('calendarUrl').value = s.calendarUrl;
  $('calendarLeadMinutes').value = s.calendarLeadMinutes;
  $('calendarAtStart').checked = s.calendarAtStart;
  $('calendarInChat').checked = s.calendarInChat;
  showCalendarStatus(calendar);
  showUpdate(update);

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
      petName: $('petName').value,
      scale: Number(form.querySelector('input[name="scale"]:checked').value),
      quipMinMinutes: min,
      quipMaxMinutes: max,
      sleepTimeoutMinutes: Number($('sleepTimeoutMinutes').value),
      muteQuips: $('muteQuips').checked,
      startWithWindows: $('startWithWindows').checked,
      morningBriefing: $('morningBriefing').checked,
      todoNudges: $('todoNudges').checked,
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
