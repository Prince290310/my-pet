'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { WhatsAppControl, parseWhatsAppCommand: parse, validContact, validMessage, nativeHelperPath, diagnosticsText } = require('../main/whatsapp');
const { validate } = require('../main/settings');
function setup(overrides = {}, hooks = {}) {
  const values = { pcControl: true, whatsappAutomation: true, whatsappCallType: 'voice', ...overrides };
  const calls = [];
  const control = new WhatsAppControl({ settings: { get: k => values[k] }, platform: 'win32', hooks: { run: async request => {
    calls.push(request);
    return { ok: true, code: request.action === 'status' ? 'ready' : request.action === 'send' ? 'sent' : 'calling' };
  }, ...hooks } });
  return { control, values, calls };
}
test('message and reply commands preserve punctuation, Unicode and multiline text', () => {
  for (const command of ['message Mom on WhatsApp: ', 'reply to Mom on WhatsApp: ', 'send a message to Mom on WhatsApp: ', 'whatsapp send Mom: ', 'whatsapp reply to Mom: ']) {
    assert.deepEqual(parse(command + 'Hi 😊: (yes) +{ENTER}\nमैं आ रहा हूँ'), { type: 'send', contact: 'Mom', message: 'Hi 😊: (yes) +{ENTER}\nमैं आ रहा हूँ' });
  }
  assert.deepEqual(parse('whatsapp message "Mom: work": Hi!'), { type: 'send', contact: 'Mom: work', message: 'Hi!' });
});
test('calls require WhatsApp explicitly and default to the configured voice preference', async () => {
  const { control, calls } = setup();
  await control.run(parse('call Mom on WhatsApp'));
  assert.deepEqual(calls.pop(), { action: 'call', contact: 'Mom', callType: 'voice' });
  await control.run(parse('video call Mom on WhatsApp'));
  assert.equal(calls.pop().callType, 'video');
  await control.run(parse('whatsapp voice call Mom'));
  assert.equal(calls.pop().callType, 'voice');
  assert.equal(parse('call Thor'), null);
  assert.equal(parse('remind me to call Mom on WhatsApp'), null);
  assert.equal(parse('what did Mom say?'), null);
  assert.equal(parse('[[whatsapp | call Mom]]'), null);
  assert.equal(parse('open whatsapp'), null);
});
test('missing message text and invalid commands give help without doing anything', async () => {
  const { control, calls } = setup();
  assert.equal(parse('reply to Mom on WhatsApp').type, 'help');
  assert.equal(parse('whatsapp send Mom').type, 'help');
  assert.match(await control.run(parse('whatsapp send Mom: ')), /Nothing was sent/);
  assert.equal(calls.length, 0);
});
test('contact and message validation rejects control characters and overlong requests', () => {
  assert.equal(validContact('Mom\nDad'), false);
  assert.equal(validContact('Mom\u0085'), false);
  assert.equal(validContact('x'.repeat(121)), false);
  assert.equal(validMessage('hello\u0000'), false);
  assert.equal(validMessage('hello\u0085'), false);
  assert.equal(validMessage('x'.repeat(4001)), false);
  assert.equal(validMessage('hello\nworld\t😊'), true);
});
test('automation is opt in and both switches prevent all side effects', async () => {
  assert.equal(validate({}).whatsappAutomation, false);
  assert.equal(validate({ whatsappAutomation: 'false' }).whatsappAutomation, false);
  assert.equal(validate({}).whatsappCallType, 'voice');
  assert.equal(validate({ whatsappCallType: 'other' }).whatsappCallType, 'voice');
  for (const overrides of [{ pcControl: false }, { whatsappAutomation: false }]) {
    const { control, calls } = setup(overrides);
    assert.match(await control.run(parse('call Mom on WhatsApp')), /Turn on/);
    assert.equal(calls.length, 0);
  }
});
test('other operating systems never launch the Windows helper', async () => {
  const { control, calls } = setup();
  control.platform = 'linux';
  assert.match(await control.run(parse('call Mom on WhatsApp')), /Windows/);
  assert.equal((await control.check()).ok, false);
  assert.equal(calls.length, 0);
});
test('the exact requested body is sent, including messages longer than ordinary chat input', async () => {
  const { control, calls } = setup();
  const body = 'Hello 😊\n' + 'x'.repeat(2500);
  assert.match(await control.run(parse('message Mom on WhatsApp: ' + body)), /Sent your message/);
  assert.equal(calls[0].message, body);
});
test('unconfirmed sends and calls are never retried', async () => {
  for (const code of ['send_uncertain', 'call_uncertain', 'timeout', 'recipient_unverified', 'ambiguous', 'draft_exists']) {
    let count = 0, opened = 0;
    const { control } = setup({}, { run: async () => { count++; return { ok: false, code }; } });
    control.launch = async () => { opened++; return true; };
    const result = await control.run(parse('message Mom on WhatsApp: hi'));
    assert.equal(count, 1);
    assert.equal(opened, 0);
    assert.ok(!result.startsWith('Sent'));
  }
});
test('only a definite app-not-running result allows one launch and one retry', async () => {
  let count = 0, opened = 0;
  const { control } = setup({}, { run: async request => {
    count++;
    if (count === 1) return { ok: false, code: 'not_running' };
    assert.equal(request.waitForApp, true);
    return { ok: true, code: 'sent' };
  } });
  control.launch = async () => { opened++; return true; };
  assert.match(await control.run(parse('message Mom on WhatsApp: hi')), /Sent/);
  assert.equal(count, 2);
  assert.equal(opened, 1);
});
test('commands serialize; stop marks a running action uncertain and blocks follow-up work', async () => {
  let finish;
  const { control } = setup({}, { run: () => new Promise(resolve => { finish = resolve; }) });
  const first = control.run(parse('message Mom on WhatsApp: hi'));
  assert.match(await control.run(parse('call Dad on WhatsApp')), /already running/);
  assert.match(control.stop(), /Check WhatsApp/);
  finish({ ok: true, code: 'sent' });
  assert.match(await first, /stopped/);
  assert.equal(control.pending, null);
});
test('turning controls off during app launch prevents a subsequent send', async () => {
  let count = 0;
  const { control, values } = setup({}, { run: async () => { count++; return { ok: false, code: 'not_running' }; } });
  control.launch = async () => { values.whatsappAutomation = false; return true; };
  await control.run(parse('message Mom on WhatsApp: hi'));
  assert.equal(count, 1);
});
test('native transport uses a fixed script and literal UTF-8 JSON on stdin', async () => {
  let invocation;
  const control = new WhatsAppControl({ settings: { get: () => true }, platform: 'win32', hooks: { execFile: (file, args, options, callback) => {
    const stdin = new PassThrough();
    let data = '';
    stdin.on('data', chunk => { data += chunk.toString('utf8'); });
    stdin.on('finish', () => { invocation = { file, args, options, data }; callback(null, '{"ok":true,"code":"sent"}'); });
    return { stdin, kill() {} };
  } } });
  const request = { type: 'send', contact: "O'Connor", message: '$(echo nope); +{ENTER} 😊' };
  assert.match(await control.run(request), /Sent/);
  assert.equal(invocation.file, 'powershell.exe');
  assert.ok(invocation.args.includes('-File'));
  assert.ok(invocation.args.includes('-STA'));
  assert.ok(!invocation.args.some(arg => arg.includes(request.contact) || arg.includes(request.message)));
  assert.deepEqual(JSON.parse(invocation.data), { action: 'send', contact: request.contact, message: request.message });
});
test('installed apps resolve the helper outside the virtual ASAR archive', () => {
  assert.equal(nativeHelperPath('/opt/Shadow/resources/app.asar/main'), '/opt/Shadow/resources/app.asar.unpacked/main/windows/whatsapp.ps1');
  assert.equal(nativeHelperPath('/workspace/my-pet/main'), '/workspace/my-pet/main/windows/whatsapp.ps1');
  const packaged = nativeHelperPath('C:\\Program Files\\Shadow\\resources\\app.asar\\main');
  assert.ok(packaged.includes('app.asar.unpacked'));
  assert.ok(!packaged.includes('app.asar\\main'));
});
test('a running app with an inaccessible window is not mistaken for a closed app or relaunched', async () => {
  let opened = 0;
  const { control } = setup({}, { run: async () => ({ ok: false, code: 'window_unavailable' }) });
  control.launch = async () => { opened++; return true; };
  assert.match(await control.run(parse('call Mom on WhatsApp')), /WhatsApp is running/);
  assert.equal(opened, 0);
});
test('diagnostics remain read only when automation is disabled and never launch the app', async () => {
  const requests = [];
  let opened = 0;
  const { control } = setup({ whatsappAutomation: false, pcControl: false }, { run: async request => {
    requests.push(request);
    return { ok: false, code: 'window_unavailable', diagnostics: {
      helperVersion: 2, appProcesses: 3, appWindows: 0, inaccessibleWindows: 1,
      minimized: false, search: false, composer: false, voiceCall: false, videoCall: false,
    } };
  } });
  control.launch = async () => { opened++; return true; };
  assert.deepEqual(parse('WHATSAPP DIAGNOSTICS!'), { type: 'diagnostics' });
  const output = await control.run(parse('whatsapp diagnostics'));
  assert.match(output, /WhatsApp is running/);
  assert.match(output, /WhatsApp processes: 3/);
  assert.match(output, /Inaccessible app windows: 1/);
  assert.deepEqual(requests, [{ action: 'status' }]);
  assert.equal(opened, 0);
});
test('diagnostic rendering drops titles, private data and unexpected non-scalar values', () => {
  const output = diagnosticsText({ code: 'private contact name', diagnostics: {
    helperVersion: 2, appProcesses: 'Private message', appWindows: -1,
    inaccessibleWindows: { message: 'PRIVATE' }, search: 'PRIVATE',
    composer: true, voiceCall: false, windowTitle: 'PRIVATE', chats: ['PRIVATE'],
  } });
  assert.match(output, /Result: helper_error/);
  assert.match(output, /WhatsApp processes: unknown/);
  assert.match(output, /Chat search accessible: unknown/);
  assert.match(output, /Message input accessible: yes/);
  assert.ok(!output.includes('PRIVATE') && !output.includes('Private') && !output.includes('private contact'));
});
test('a minimized app is distinguished from a closed app without triggering launch or retry', async () => {
  let opened = 0, count = 0;
  const { control } = setup({}, { run: async () => { count++; return { ok: false, code: 'minimized' }; } });
  control.launch = async () => { opened++; return true; };
  assert.match((await control.check()).text, /minimized/);
  assert.equal(opened, 0);
  assert.equal(count, 1);
});
