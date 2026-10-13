'use strict';
// Explicit user commands only. No AI action tags, incoming-chat watcher or automatic retries.
const { execFile } = require('node:child_process');
const path = require('node:path');

const HELP = 'WhatsApp commands: "message Mom on WhatsApp: I will be home at 8", "reply to Mom on WhatsApp: Yes", "call Mom", "call Mom on WhatsApp", "video call Mom", "whatsapp status", "whatsapp diagnostics", "stop whatsapp". Use the exact saved chat name. Calling an Avenger name summons that character; add "on WhatsApp" to call a person with the same name.';
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
  let m;
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
  not_found: 'I could not find that exact chat name in WhatsApp. Check the saved name and try again.',
  chat_not_opened: 'I found the WhatsApp search result, but could not open and verify the conversation. No message or call was sent.',
  click_blocked: 'Something is covering the WhatsApp chat result. Move that window aside and try again. No message or call was sent.',
  ambiguous_composer: 'This WhatsApp chat exposes more than one possible message input. I stopped without changing a draft or sending a message.',
  search_unverified: 'I could not verify the chat search text in WhatsApp. No message or call was sent.',
  ambiguous: 'More than one chat has that name. Give the intended chat a unique name in WhatsApp before trying again.',
  recipient_unverified: 'I could not verify the selected WhatsApp chat. No message or call was sent.',
  draft_exists: 'That WhatsApp chat already has an unsent draft. Send or clear it in WhatsApp, then try again.',
  message_unverified: 'I could not verify the text in WhatsApp. Nothing was sent; check the draft in WhatsApp.',
  focus_changed: 'The active window changed. I stopped before sending or calling; try again with WhatsApp in front.',
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

const STAGES = { validation: 'validating command', status: 'checking app', discover: 'finding app', focus: 'focusing WhatsApp',
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

class WhatsAppControl {
  constructor({ settings, platform = process.platform, hooks = {}, launch } = {}) {
    this.settings = settings;
    this.platform = platform;
    this.hooks = hooks;
    this.launch = launch;
    this.pending = null;
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
        { windowsHide: true, timeout: 35000, maxBuffer: 64 * 1024, encoding: 'utf8' }, (err, stdout) => {
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
    if (result && result.ok && result.code === 'sent') return `Sent your message to ${request.contact} in WhatsApp.`;
    if (result && result.ok && result.code === 'calling') return `Started a ${request.callType} call to ${request.contact} in WhatsApp.`;
    if (result && result.code === 'busy') return 'A WhatsApp command is already running. Wait for it or say "stop whatsapp".';
    const error = ERRORS[result && result.code] || ERRORS.helper_error;
    const stage = result && Object.hasOwn(STAGES, result.stage) ? STAGES[result.stage] : null;
    const faults = ['element_unavailable', 'provider_error', 'unsupported_operation', 'invalid_argument', 'other'];
    const fault = result && faults.includes(result.fault) && /^[0-9A-F]{8}$/.test(result.errorNumber || '')
      ? `\nWindows detail: ${result.fault} (${result.errorNumber}).` : '';
    return error + (stage && ['send', 'call'].includes(request.action) ? `\nStopped while ${stage}. Result: ${Object.hasOwn(ERRORS, result.code) ? result.code : 'helper_error'}.${fault}` : '');
  }
  async run(cmd) {
    if (cmd.type === 'help') return HELP;
    if (cmd.type === 'stop') return this.stop();
    if (cmd.type === 'status') return (await this.check()).text;
    if (cmd.type === 'diagnostics') {
      const result = await this.check();
      return result.text + (result.diagnostics ? '\n\n' + result.diagnostics : '');
    }
    if (!this.enabled()) return 'Turn on WhatsApp Desktop automation and PC controls in Settings, then save.';
    if (this.platform !== 'win32') return 'WhatsApp Desktop automation runs on Windows.';
    if (!validContact(cmd.contact)) return 'Use an exact WhatsApp chat name, up to 120 characters, on one line.';
    if (cmd.type === 'send' && !validMessage(cmd.message)) return `Include the message after a colon, with 1–${MAX_MESSAGE} characters. Nothing was sent.`;
    if (!['send', 'call'].includes(cmd.type)) return HELP;
    const callType = cmd.callType || this.settings.get('whatsappCallType') || 'voice';
    if (cmd.type === 'call' && !['voice', 'video'].includes(callType)) return HELP;
    const request = { action: cmd.type, contact: cmd.contact, ...(cmd.type === 'send' ? { message: cmd.message } : { callType }) };
    return this.describe(await this.execute(request, { launch: true }), request);
  }
}
module.exports = { WhatsAppControl, parseWhatsAppCommand, validContact, validMessage, nativeHelperPath, diagnosticsText, HELP };
