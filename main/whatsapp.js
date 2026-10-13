'use strict';
// Explicit user commands only. No AI action tags, incoming-chat watcher or automatic retries.
const { execFile } = require('node:child_process');
const path = require('node:path');

const HELP = 'WhatsApp commands: "link whatsapp" (once - scan the QR code in Settings), "message Mom on WhatsApp: I will be home at 8", "reply to Mom on WhatsApp: Yes", "message family group on WhatsApp: dinner at 9", "call Mom", "call Mom on WhatsApp", "video call Mom", "message 98765 43210 on WhatsApp: hi", "save Mom\'s WhatsApp number as +91 98765 43210", "whatsapp contacts", "whatsapp status", "whatsapp diagnostics", "stop whatsapp". Once linked, messages go through WhatsApp Web in the background and names are matched against your real WhatsApp contacts and groups. Calling an Avenger name summons that character; add "on WhatsApp" to call a person with the same name.';
const MAX_CONTACTS = 100;
const NUMBER = String.raw`(\+?[\d][\d\s().-]{6,22}\d)`;

/** "+91 98765 43210" / "098765 43210" / "9876543210" -> "919876543210" ('' if it isn't a phone number).
 *  A bare 10-digit number starting 6-9 is taken as an Indian mobile (+91). */
function normalizePhone(input) {
  const s = String(input || '').trim();
  if (!/^\+?[\d\s().-]+$/.test(s)) return '';
  let d = s.replace(/\D/g, '');
  if (!s.startsWith('+')) {
    if (d.startsWith('00')) d = d.slice(2);
    else if (d.length === 11 && /^0[6-9]/.test(d)) d = `91${d.slice(1)}`;
    else if (d.length === 10 && /^[6-9]/.test(d)) d = `91${d}`;
  }
  return /^\d{8,15}$/.test(d) ? d : '';
}
/** "919876543210" -> "+91 98765 43210" (others: "+<digits>"). */
function showPhone(d) {
  return /^91\d{10}$/.test(d) ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : `+${d}`;
}
const looksLikeNumber = (s) => /^\+?[\d\s().-]{8,24}$/.test(String(s || '').trim()) && !!normalizePhone(s);
const MAX_MESSAGE = 4000;
function nativeHelperPath(base = __dirname) {
  // External PowerShell cannot read Electron's virtual app.asar filesystem.
  return path.join(base.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked'), 'windows', 'whatsapp.ps1');
}
function parseWhatsAppCommand(input, { allowBareCall = false } = {}) {
  const text = String(input || '').trim();
  if (/^(?:stop|cancel) whatsapp(?: automation)?[.!]?$/i.test(text)) return { type: 'stop' };
  if (/^(?:whatsapp (?:status|check)|check whatsapp)[.!]?$/i.test(text)) return { type: 'status' };
  if (/^whatsapp diagnostics[.!]?$/i.test(text)) return { type: 'diagnostics' };
  if (/^whatsapp help[.!]?$/i.test(text)) return { type: 'help' };
  if (/^(?:link|connect|pair|set ?up) (?:my )?whatsapp(?: web)?[.!]?$/i.test(text)) return { type: 'web-link' };
  let m;
  // the contacts book: names -> numbers, so commands can open the chat by number
  if (/^(?:(?:show|list|see)(?: me)? )?(?:my )?whatsapp (?:contacts|numbers)[.!?]?$/i.test(text)) return { type: 'contacts' };
  if ((m = new RegExp(`^(?:save|set|add|store|update) (.+?)(?:'s|’s| ka| ki)? (?:whatsapp )?(?:number|no\\.?|phone(?: number)?)(?: (?:on|in|for) whatsapp)? (?:as|is|to|=|:)\\s*${NUMBER}[.!]?$`, 'i').exec(text)) ||
      (m = new RegExp(`^(?:add|save) (.+?) (?:to|in) (?:my )?whatsapp contacts?\\s*(?:as|with|[:=,])?\\s*${NUMBER}[.!]?$`, 'i').exec(text)) ||
      (m = new RegExp(`^(.+?)(?:'s|’s) whatsapp (?:number|no\\.?) is ${NUMBER}[.!]?$`, 'i').exec(text))) {
    return { type: 'contact-add', name: unquote(m[1]).replace(/^my /i, ''), phone: m[2] };
  }
  if ((m = /^(?:remove|delete|forget) (.+?)(?:'s|’s)? (?:from (?:my )?whatsapp contacts|whatsapp (?:number|contact))[.!]?$/i.exec(text))) return { type: 'contact-remove', name: unquote(m[1]).replace(/^my /i, '') };
  if ((m = /^(?:(voice|video) )?call (.+?) (?:on|via|in) whatsapp[.!]?$/i.exec(text)) ||
      (m = /^whatsapp (?:(voice|video) )?call (.+)$/i.exec(text)) ||
      (allowBareCall && (m = /^(?:(voice|video) )?call (.+)$/i.exec(text)))) {
    return { type: 'call', contact: unquote(m[2]), callType: m[1] ? m[1].toLowerCase() : null };
  }
  if ((m = /^(?:message|text|reply to|send (?:a )?(?:message|reply) to) (.+?) (?:on|via|in) whatsapp\s*:\s*([\s\S]*)$/i.exec(text)) ||
      (m = /^whatsapp (?:message|text|send(?: to)?|reply(?: to)?) ("[^"\r\n]+"|[^:\r\n]+?)\s*:\s*([\s\S]*)$/i.exec(text))) {
    return { type: 'send', contact: unquote(m[1]), message: m[2].trim() };
  }
  if (/^whatsapp (?:send|reply|message|text|call|voice call|video call)\b/i.test(text) ||
      /^(?:send|reply|message|text|call|voice call|video call)\b[\s\S]*\b(?:on|via|in) whatsapp\b/i.test(text)) return { type: 'help' };
  return null;
}
function unquote(s) { return s.trim().replace(/^"([\s\S]*)"$/, '$1').trim(); }
function validContact(s) { return typeof s === 'string' && s.trim().length > 0 && s.length <= 120 && !/\p{Cc}/u.test(s); }
function validMessage(s) { return typeof s === 'string' && s.trim().length > 0 && s.length <= MAX_MESSAGE && !/[^\P{Cc}\t\r\n]/u.test(s); }

const ERRORS = {
  not_running: 'Open the WhatsApp Windows app and sign in, then try again.',
  window_unavailable: 'WhatsApp is running, but I could not access its main window. Restore the app from the taskbar so your chats are visible, then run CHECK WHATSAPP again.',
  minimized: 'WhatsApp is minimized. Restore it from the taskbar, then run CHECK WHATSAPP again. Sending and calling commands can restore a detected window automatically.',
  not_installed: 'I could not find the WhatsApp Windows app. Install it and sign in first.',
  multiple_windows: 'Close the extra WhatsApp windows and try again.',
  unavailable: 'WhatsApp is not ready. Keep the PC unlocked, open WhatsApp and sign in.',
  controls_unavailable: 'I cannot read the controls in this WhatsApp version. Use the English app language, update WhatsApp, then run CHECK WHATSAPP in Settings.',
  composer_unavailable: 'I cannot access the message input in this WhatsApp chat. No message was sent. Calling does not require the message input.',
  not_found: 'I could not find that exact chat name in WhatsApp. Check the saved name and try again - or save their number once ("save Mom\'s WhatsApp number as +91 98765 43210") and I\'ll open the chat directly.',
  link_unverified: 'WhatsApp opened, but its message box did not show your message, so nothing was sent. Check that the number is on WhatsApp and that the chat has no old unsent draft.',
  chat_not_opened: 'I found the WhatsApp search result, but could not open and verify the conversation. No message or call was sent.',
  click_blocked: 'Something is covering WhatsApp (another window that stays on top?). Move it aside and try again. No message or call was sent.',
  focus_refused: 'WhatsApp did not let me put the cursor in its search box, so I stopped before typing. No message or call was sent. Save their number once - "save Mom\'s WhatsApp number as +91 98765 43210" - and I\'ll open the chat straight from WhatsApp\'s link, no search box needed.',
  ambiguous_composer: 'This WhatsApp chat exposes more than one possible message input. I stopped without changing a draft or sending a message.',
  search_unverified: 'I could not verify the chat search text in WhatsApp. No message or call was sent.',
  ambiguous: 'More than one chat has that name. Give the intended chat a unique name in WhatsApp before trying again.',
  recipient_unverified: 'I could not verify the selected WhatsApp chat. No message or call was sent.',
  draft_exists: 'That WhatsApp chat already has an unsent draft. Send or clear it in WhatsApp, then try again.',
  message_unverified: 'I could not verify the text in WhatsApp. Nothing was sent; check the draft in WhatsApp.',
  focus_changed: 'Another window took over the keyboard while I was working in WhatsApp, so I stopped before sending or calling. Try again without touching the keyboard or mouse - or save their number once ("save Mom\'s WhatsApp number as +91 98765 43210") so I can skip the chat search.',
  call_active: 'There is already a WhatsApp call in progress. Finish it first.',
  dialog_open: 'Close the open WhatsApp dialog and try again. No message or call was sent.',
  call_unavailable: 'I verified the selected WhatsApp chat, but could not find a usable call button in its header. No call was started.',
  call_not_invokable: 'The WhatsApp call button is visible, but this app version does not expose an action for it. No call was started.',
  send_unavailable: 'The WhatsApp Send button is not accessible. The message may be in the draft; check WhatsApp.',
  send_uncertain: 'I clicked Send but could not confirm the result. Check WhatsApp before repeating the command.',
  call_uncertain: 'I requested the call but could not confirm it started. Check WhatsApp before repeating the command.',
  timeout: 'WhatsApp automation timed out. Check WhatsApp before repeating the command; a message or call may already have started.',
  stopped: 'WhatsApp automation stopped. Check WhatsApp if a message or call had already started.',
  helper_error: 'The WhatsApp control helper could not complete the command. Open WhatsApp and run CHECK WHATSAPP in Settings.',
};

const STAGES = { validation: 'validating command', status: 'checking app', discover: 'finding app', open_link: 'opening the chat from its number', focus: 'focusing WhatsApp',
  search: 'searching chats', search_type: 'entering chat search', search_verify: 'checking search text', search_results: 'reading search results',
  select_chat: 'opening chat', verify_chat: 'verifying recipient', message_input: 'reading message input',
  send_button: 'finding Send button', send_message: 'sending message', confirm_send: 'checking send result',
  call_button: 'finding call button', start_call: 'starting call', confirm_call: 'checking call result' };

function diagnosticsText(result) {
  const code = result && (result.code === 'ready' || Object.hasOwn(ERRORS, result.code) || result.code === 'busy') ? result.code : 'helper_error';
  const info = result && result.diagnostics;
  if (!info || typeof info !== 'object') return `Result: ${code}. Detection details are unavailable.`;
  const count = key => Number.isInteger(info[key]) && info[key] >= 0 && info[key] <= 10000 ? info[key] : 'unknown';
  const flag = key => info[key] === true ? 'yes' : info[key] === false ? 'no' : 'unknown';
  // Whitelist scalar diagnostics: never include raw helper output, window titles, chat names or messages.
  return `Result: ${code}\nHelper version: ${count('helperVersion')}\nWhatsApp processes: ${count('appProcesses')}\nVisible app windows: ${count('appWindows')}\nInaccessible app windows: ${count('inaccessibleWindows')}\nMinimized: ${flag('minimized')}\nChat search accessible: ${flag('search')}\nMessage input accessible: ${flag('composer')}\nVoice call button accessible: ${flag('voiceCall')}\nVideo call button accessible: ${flag('videoCall')}\nVoice call action accessible: ${flag('voiceInvoke')}\nVideo call action accessible: ${flag('videoInvoke')}`;
}

/** Replies for the WhatsApp Web engine (whatsweb.js). */
function webReply(r, target) {
  const who = r.name || target;
  switch (r.code) {
    case 'sent':
      return `Sent your message to ${who} on WhatsApp ✓`;
    case 'queued':
      return `Your message to ${who} is queued in WhatsApp but not confirmed yet - check your internet. It goes out by itself once it's back.`;
    case 'ambiguous':
      return `More than one WhatsApp chat matches "${target}": ${(r.options || []).join(', ')}. Use the full name. Nothing was sent.`;
    case 'not_found':
      return `I couldn't find "${target}" in your WhatsApp contacts or groups. Check the name as it appears in WhatsApp - or use their number. Nothing was sent.`;
    case 'not_on_whatsapp':
      return 'That number is not on WhatsApp. Nothing was sent.';
    case 'web_not_ready':
      return 'WhatsApp Web is still connecting - try again in a few seconds.';
    default:
      return `WhatsApp didn't accept the message${r.error ? ` (${r.error})` : ''}. Nothing was sent.`;
  }
}

class WhatsAppControl {
  /** @param {object} o  web: the WhatsApp Web engine (whatsweb.js); messages go through it once it's linked */
  constructor({ settings, platform = process.platform, hooks = {}, launch, web = null, onLink = null } = {}) {
    this.settings = settings;
    this.platform = platform;
    this.hooks = hooks;
    this.launch = launch;
    this.web = web;
    this.onLink = onLink; // "link whatsapp": main.js starts the engine and shows the QR code in Settings
    this.pending = null;
    this.webBusy = false;
  }
  enabled() { return this.settings.get('whatsappAutomation') && this.settings.get('pcControl'); }
  stop() {
    const task = this.pending;
    if (!task) return 'No WhatsApp command is running.';
    task.cancelled = true;
    if (task.child) task.child.kill();
    return ERRORS.stopped;
  }
  async native(request, task) {
    if (task.cancelled) return { ok: false, code: 'stopped' };
    if (this.hooks.run) return this.hooks.run(request, task);
    return new Promise(resolve => {
      const child = (this.hooks.execFile || execFile)('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-MTA', '-ExecutionPolicy', 'Bypass', '-File', nativeHelperPath()],
        // the link route may first have to start WhatsApp and load the chat
        { windowsHide: true, timeout: request.phone ? 60000 : 35000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (err, stdout) => {
          task.child = null;
          if (task.cancelled) return resolve({ ok: false, code: 'stopped' });
          if (err) return resolve({ ok: false, code: err.killed ? 'timeout' : 'helper_error' });
          try { resolve(JSON.parse(stdout.trim())); } catch { resolve({ ok: false, code: 'helper_error' }); }
        });
      task.child = child;
      // Contact/message content is JSON data on stdin, never executable code or shell arguments.
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(request));
    });
  }
  async execute(request, { launch = false } = {}) {
    if (this.pending) return { ok: false, code: 'busy' };
    const task = { cancelled: false, child: null };
    this.pending = task;
    try {
      let result = await this.native(request, task);
      if (result.code === 'not_running' && launch && this.launch && !task.cancelled && this.enabled()) {
        const opened = await this.launch();
        if (!opened) return { ok: false, code: 'not_installed' };
        if (!task.cancelled && this.enabled()) result = await this.native({ ...request, waitForApp: true }, task);
      }
      return task.cancelled ? { ok: false, code: 'stopped' } : result;
    } catch { return { ok: false, code: 'helper_error' }; }
    finally { if (this.pending === task) this.pending = null; }
  }
  async check() {
    if (this.platform !== 'win32') return { ok: false, text: 'WhatsApp Desktop automation runs on Windows.' };
    const result = await this.execute({ action: 'status' });
    return { ok: !!result.ok, text: this.describe(result), diagnostics: diagnosticsText(result) };
  }
  describe(result, request = {}) {
    if (result && result.ok && result.code === 'ready') return 'WhatsApp is detected and its chat search is accessible. Sending and calling are checked when you run a command.';
    const who = request.contact || (request.phone ? showPhone(request.phone) : '');
    if (result && result.ok && result.code === 'sent') return `Sent your message to ${who} in WhatsApp.`;
    if (result && result.ok && result.code === 'calling') return `Started a ${request.callType} call to ${who} in WhatsApp.`;
    if (result && result.code === 'recipient_unverified' && request.phone) {
      return `WhatsApp opened a chat, but its header did not show ${request.contact ? `"${request.contact}" or ` : ''}${showPhone(request.phone)}, so nothing was sent or called. Save the contact in Shadow with the same name WhatsApp shows for them.`;
    }
    if (result && result.code === 'busy') return 'A WhatsApp command is already running. Wait for it or say "stop whatsapp".';
    const error = ERRORS[result && result.code] || ERRORS.helper_error;
    const stage = result && Object.hasOwn(STAGES, result.stage) ? STAGES[result.stage] : null;
    const faults = ['element_unavailable', 'provider_error', 'unsupported_operation', 'invalid_argument', 'other'];
    const fault = result && faults.includes(result.fault) && /^[0-9A-F]{8}$/.test(result.errorNumber || '')
      ? `\nWindows detail: ${result.fault} (${result.errorNumber}).` : '';
    return error + (stage && ['send', 'call'].includes(request.action) ? `\nStopped while ${stage}. Result: ${Object.hasOwn(ERRORS, result.code) ? result.code : 'helper_error'}.${fault}` : '');
  }
  contacts() {
    const list = this.settings.get('whatsappContacts');
    return Array.isArray(list) ? list.filter((c) => c && c.name && c.phone) : [];
  }
  /** Saved number for a name ('' if none). */
  numberFor(name) {
    const want = String(name || '').trim().toLowerCase();
    const hit = this.contacts().find((c) => c.name.toLowerCase() === want);
    return hit ? hit.phone : '';
  }
  /** Settings → WhatsApp contacts and the chat commands. -> reply text */
  editContacts(cmd) {
    const list = this.contacts();
    if (cmd.type === 'contacts') {
      return list.length ? `📇 WhatsApp numbers: ${list.map((c) => `${c.name} ${showPhone(c.phone)}`).join(' · ')}` : 'No WhatsApp numbers saved yet. Say "save Mom\'s WhatsApp number as +91 98765 43210".';
    }
    if (cmd.type === 'contact-remove') {
      const left = list.filter((c) => c.name.toLowerCase() !== String(cmd.name).trim().toLowerCase());
      if (left.length === list.length) return `"${cmd.name}" isn't in your WhatsApp contacts.`;
      this.settings.update({ whatsappContacts: left });
      return `Removed ${cmd.name} from your WhatsApp contacts ✓`;
    }
    const name = String(cmd.name || '').trim();
    const phone = normalizePhone(cmd.phone);
    if (!validContact(name) || name.length > 60) return 'Give the contact a short name, like "Mom".';
    if (!phone) return 'That number doesn\'t look right. Use the full number with country code, like +91 98765 43210.';
    const next = [...list.filter((c) => c.name.toLowerCase() !== name.toLowerCase()), { name, phone }];
    if (next.length > MAX_CONTACTS) return `You can save up to ${MAX_CONTACTS} WhatsApp numbers.`;
    this.settings.update({ whatsappContacts: next });
    return `Saved ${name}: ${showPhone(phone)} ✓ Now "message ${name} on WhatsApp: hi" or "call ${name} on WhatsApp" opens their chat directly.`;
  }
  /** Which route a command takes: 'web' (WhatsApp Web engine), 'connecting', or 'app' (the WhatsApp app on screen). */
  route() {
    if (!this.web) return 'app';
    if (this.web.ready()) return 'web';
    if (!this.settings.get('waWebLinked')) return 'app';
    if (['off', 'error'].includes(this.web.state) && this.settings.get('whatsappAutomation')) this.web.start(); // linked but stopped: reconnect
    return ['starting', 'linking'].includes(this.web.state) ? 'connecting' : 'app';
  }
  /** Messages and calls through the WhatsApp Web engine. */
  async runWeb(cmd) {
    if (this.webBusy) return 'A WhatsApp command is already running. Wait for it or say "stop whatsapp".';
    this.webBusy = true;
    try {
      const typed = looksLikeNumber(cmd.contact);
      const number = typed ? normalizePhone(cmd.contact) : this.numberFor(cmd.contact);
      const target = typed ? '' : cmd.contact;
      if (cmd.type === 'send') return webReply(await this.web.send(target, cmd.message, { number }), target || showPhone(number));
      // calls: WhatsApp Web can't place them - find the number, then the WhatsApp app calls it by number
      if (!this.enabled()) return 'Calls press the call button in the WhatsApp app, so PC controls must be on too (Settings → Behaviour).';
      const r = await this.web.resolve(target, { number });
      if (!r.ok) return webReply({ code: r.reason, options: r.options }, target || showPhone(number)).replace('Nothing was sent.', 'No call was started.');
      if (r.group) return 'Group calls aren\'t supported yet - call one person at a time. No call was started.';
      const callType = cmd.callType || this.settings.get('whatsappCallType') || 'voice';
      const request = { action: 'call', contact: r.name || target, phone: normalizePhone(`+${r.number}`) || r.number, callType };
      return this.describe(await this.execute(request), request);
    } catch (err) {
      return `WhatsApp Web ran into a problem (${String((err && err.message) || err).slice(0, 100)}). Nothing was sent.`;
    } finally {
      this.webBusy = false;
    }
  }
  async run(cmd) {
    if (cmd.type === 'help') return HELP;
    if (['contacts', 'contact-add', 'contact-remove'].includes(cmd.type)) return this.editContacts(cmd);
    if (cmd.type === 'web-link') {
      if (!this.web) return HELP;
      if (this.web.ready()) return `WhatsApp Web is already linked${this.web.me && this.web.me.name ? ` (${this.web.me.name})` : ''} ✓`;
      if (this.onLink) this.onLink();
      return 'Opening Settings → WhatsApp: scan the QR code with your phone (WhatsApp → Linked devices → Link a device).';
    }
    if (cmd.type === 'stop') return this.stop();
    if (cmd.type === 'status') {
      const w = this.web;
      const linkedState = w && { starting: 'connecting…', linking: 'connecting…', qr: 'waiting for its QR code to be scanned in Settings', error: `stopped (${w.error}) - it reconnects with your next message`, off: 'off - it starts with your next message' }[w.state];
      const engine = w ? `\nWhatsApp Web engine: ${w.ready() ? `linked${w.me && w.me.name ? ` as ${w.me.name}` : ''} - messages go through it` : this.settings.get('waWebLinked') ? linkedState || w.state : 'not linked (say "link whatsapp")'}` : '';
      return (await this.check()).text + engine;
    }
    if (cmd.type === 'diagnostics') {
      const result = await this.check();
      return result.text + (result.diagnostics ? '\n\n' + result.diagnostics : '');
    }
    const route = ['send', 'call'].includes(cmd.type) ? this.route() : 'app';
    if (route !== 'app') {
      if (!this.settings.get('whatsappAutomation')) return 'Turn on WhatsApp automation in Settings, then save.';
      if (!validContact(cmd.contact)) return 'Use a WhatsApp contact or group name (or a number), up to 120 characters, on one line.';
      if (cmd.type === 'send' && !validMessage(cmd.message)) return `Include the message after a colon, with 1–${MAX_MESSAGE} characters. Nothing was sent.`;
      return route === 'connecting' ? webReply({ code: 'web_not_ready' }) : this.runWeb(cmd);
    }
    if (!this.enabled()) return 'Turn on WhatsApp Desktop automation and PC controls in Settings, then save.';
    if (this.platform !== 'win32') return 'WhatsApp Desktop automation runs on Windows.';
    if (!validContact(cmd.contact)) return 'Use an exact WhatsApp chat name, up to 120 characters, on one line.';
    if (cmd.type === 'send' && !validMessage(cmd.message)) return `Include the message after a colon, with 1–${MAX_MESSAGE} characters. Nothing was sent.`;
    if (!['send', 'call'].includes(cmd.type)) return HELP;
    const callType = cmd.callType || this.settings.get('whatsappCallType') || 'voice';
    if (cmd.type === 'call' && !['voice', 'video'].includes(callType)) return HELP;
    // a saved (or typed) number opens the chat through WhatsApp's own link - no chat search needed
    const number = looksLikeNumber(cmd.contact) ? normalizePhone(cmd.contact) : this.numberFor(cmd.contact);
    const contact = looksLikeNumber(cmd.contact) ? '' : cmd.contact;
    const request = { action: cmd.type, contact, ...(number ? { phone: number } : {}), ...(cmd.type === 'send' ? { message: cmd.message } : { callType }) };
    return this.describe(await this.execute(request, { launch: !number }), request);
  }
}
module.exports = { WhatsAppControl, parseWhatsAppCommand, validContact, validMessage, nativeHelperPath, diagnosticsText, normalizePhone, showPhone, webReply, HELP };
