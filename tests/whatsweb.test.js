'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WhatsWeb, findBrowser } = require('../main/whatsweb');
const { WhatsAppControl, parseWhatsAppCommand: parse } = require('../main/whatsapp');

/** Stands in for whatsapp-web.js's Client. */
class FakeClient extends EventEmitter {
  constructor({ contacts = [], chats = [], numbers = [], ack = 'event' } = {}) {
    super();
    Object.assign(this, { contacts, chats, numbers, ack });
    this.info = { pushname: 'Prince', wid: { user: '919800000001' } };
    this.sent = [];
    this.calls = { contacts: 0, logout: 0, destroy: 0, offline: 0 };
  }
  async initialize() {}
  async getContacts() {
    this.calls.contacts++;
    return this.contacts;
  }
  async getChats() {
    return this.chats;
  }
  async getNumberId(n) {
    return this.numbers.includes(n) ? { server: 'c.us', user: n, _serialized: `${n}@c.us` } : null;
  }
  async sendMessage(id, text, options) {
    if (this.ack === 'throw') throw new Error('Evaluation failed');
    this.sent.push({ id, text, options });
    const msg = { id: { _serialized: `msg${this.sent.length}` }, ack: 0 };
    if (this.ack === 'event') setImmediate(() => this.emit('message_ack', msg, 1));
    if (this.ack === 'error') setImmediate(() => this.emit('message_ack', msg, -1));
    return msg;
  }
  async sendPresenceUnavailable() {
    this.calls.offline++;
  }
  async logout() {
    this.calls.logout++;
  }
  async destroy() {
    this.calls.destroy++;
  }
}

const person = (user, name, o = {}) => ({ id: { _serialized: `${user}@c.us`, user }, number: user, name, pushname: o.pushname || name, isWAContact: true, isMyContact: o.saved !== false, isGroup: false, ...o });
const group = (id, name) => ({ id: { _serialized: `${id}@g.us` }, name, isGroup: true });
const CONTACTS = [
  person('919800000010', 'Mom'),
  person('919800000011', 'Rahul Sharma'),
  person('919800000012', 'Rahul Verma'),
  person('919800000013', 'Priya Singh'),
  person('919800000014', undefined, { pushname: 'Mom', saved: false }), // someone else whose profile name is "Mom"
  person('919800000015', undefined, { pushname: 'Ankit', saved: false }),
  person('919800000016', 'Study Buddy'),
];
const CHATS = [group('1203630001', 'Family'), group('1203630002', 'Study Group')];

function settingsStore(values = {}) {
  const v = { ...values };
  return { get: (k) => v[k], update: (patch) => Object.assign(v, patch), values: v };
}
function engine(o = {}) {
  const settings = o.settings || settingsStore();
  const clients = [];
  const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'waweb-test-'));
  let now = 0;
  const web = new WhatsWeb({
    settings,
    dataPath,
    platform: 'linux',
    clock: () => now,
    hooks: {
      ackMs: 30,
      createClient: () => {
        const c = new FakeClient({ contacts: CONTACTS, chats: CHATS, numbers: ['919800000010', '919811111111'], ...o.client });
        clients.push(c);
        return c;
      },
    },
  });
  return { web, settings, clients, dataPath, tick: (ms) => (now += ms) };
}
async function linked(o) {
  const t = engine(o);
  await t.web.start();
  t.clients[0].emit('ready');
  return t;
}

test('linking: QR code, then linked and remembered; the session never shows as online', async () => {
  const { web, settings, clients } = engine();
  const seen = [];
  web.on('status', (s) => seen.push(s.state));
  assert.equal(web.status().state, 'off');
  await web.start();
  await web.start(); // a second click doesn't open a second browser
  assert.equal(clients.length, 1);
  clients[0].emit('qr', '2@abc,def');
  assert.deepEqual([web.status().state, web.status().qr], ['qr', '2@abc,def']);
  clients[0].emit('authenticated');
  assert.equal(web.status().qr, '');
  clients[0].emit('ready');
  assert.equal(web.ready(), true);
  assert.deepEqual(web.status().me, { name: 'Prince', number: '919800000001' });
  assert.equal(settings.values.waWebLinked, true);
  assert.deepEqual(seen, ['starting', 'qr', 'linking', 'ready']);
  assert.ok(clients[0].calls.offline >= 1);
  await web.stop();
});

test('a QR code nobody scans times out; a refused link is forgotten', async () => {
  const { web, settings, clients } = engine({ settings: settingsStore({ waWebLinked: true }) });
  await web.start();
  clients[0].emit('qr', 'code');
  clients[0].emit('disconnected', 'Max qrcode retries reached');
  assert.equal(web.status().state, 'error');
  assert.match(web.status().error, /QR code timed out/);
  assert.equal(settings.values.waWebLinked, false); // a QR code at start means the phone removed the link
  assert.equal(clients[0].calls.destroy, 1);
  settings.update({ waWebLinked: true });
  await web.start();
  clients[1].emit('auth_failure', 'bad session');
  assert.equal(settings.values.waWebLinked, false);
  assert.match(web.status().error, /refused the link/);
  clients[1].emit('ready'); // late events from a dropped client are ignored
  assert.equal(web.ready(), false);
});

test('logging out on the phone unlinks; other disconnects keep the link', async () => {
  const t = await linked({ settings: settingsStore({ waWebLinked: true }) });
  t.clients[0].emit('disconnected', 'NAVIGATION');
  assert.equal(t.settings.values.waWebLinked, true);
  await t.web.start();
  t.clients[1].emit('ready');
  t.clients[1].emit('disconnected', 'LOGOUT');
  assert.equal(t.settings.values.waWebLinked, false);
});

test('without Windows (and no test client) the engine explains instead of starting', async () => {
  const web = new WhatsWeb({ settings: settingsStore(), dataPath: os.tmpdir(), platform: 'linux' });
  assert.equal(web.available(), false);
  await web.start();
  assert.equal(web.status().state, 'error');
  assert.match(web.status().error, /Windows/);
});

test('names resolve against real WhatsApp contacts and groups', async () => {
  const { web } = await linked();
  const r = (t, o) => web.resolve(t, o);
  assert.deepEqual(await r('mom'), { ok: true, id: '919800000010@c.us', name: 'Mom', number: '919800000010', group: false }); // the saved Mom, not a stranger called Mom
  assert.equal((await r('  PRIYA  singh ')).id, '919800000013@c.us');
  assert.equal((await r('priya')).name, 'Priya Singh');
  assert.equal((await r('singh')).name, 'Priya Singh');
  assert.deepEqual(await r('Rahul'), { ok: false, reason: 'ambiguous', options: ['Rahul Sharma', 'Rahul Verma'] });
  assert.equal((await r('rahul verma')).id, '919800000012@c.us');
  assert.deepEqual(await r('family group'), { ok: true, id: '1203630001@g.us', name: 'Family', number: '', group: true });
  assert.equal((await r('family')).group, true);
  assert.equal((await r('study group')).name, 'Study Group'); // the group's own name wins over "Study Buddy"
  assert.deepEqual(await r('study'), { ok: false, reason: 'ambiguous', options: ['Study Buddy', 'Study Group'] });
  assert.equal((await r('Ankit')).id, '919800000015@c.us'); // unsaved people match only by their exact name
  assert.deepEqual(await r('Ank'), { ok: false, reason: 'not_found' });
  assert.deepEqual(await r('Nobody'), { ok: false, reason: 'not_found' });
  assert.deepEqual(await r(''), { ok: false, reason: 'not_found' });
  assert.equal((await r('\u202aMom\u202c')).name, 'Mom');
});

test('numbers are checked with WhatsApp first', async () => {
  const { web } = await linked();
  assert.deepEqual(await web.resolve('', { number: '919800000010' }), { ok: true, id: '919800000010@c.us', name: 'Mom', number: '919800000010', group: false });
  assert.deepEqual(await web.resolve('', { number: '919811111111' }), { ok: true, id: '919811111111@c.us', name: '', number: '919811111111', group: false });
  assert.deepEqual(await web.resolve('', { number: '919822222222' }), { ok: false, reason: 'not_on_whatsapp' });
});

test('the contact list is cached for five minutes', async () => {
  const t = await linked();
  await t.web.resolve('Mom');
  await t.web.resolve('Priya');
  assert.equal(t.clients[0].calls.contacts, 1);
  t.tick(5 * 60 * 1000 + 1);
  await t.web.resolve('Mom');
  assert.equal(t.clients[0].calls.contacts, 2);
});

test('sending: confirmed by WhatsApp, queued when offline, failed when refused - never marks chats read', async () => {
  let t = await linked();
  assert.deepEqual(await t.web.send('Mom', 'Home by 8 😊\nok?'), { ok: true, code: 'sent', name: 'Mom', group: false });
  assert.deepEqual(t.clients[0].sent, [{ id: '919800000010@c.us', text: 'Home by 8 😊\nok?', options: { sendSeen: false } }]);
  assert.equal((await t.web.send('family group', 'dinner at 9')).group, true);
  assert.deepEqual(await t.web.send('Rahul', 'hi'), { ok: false, code: 'ambiguous', options: ['Rahul Sharma', 'Rahul Verma'] });
  assert.equal(t.clients[0].sent.length, 2);
  t = await linked({ client: { ack: 'none' } });
  assert.equal((await t.web.send('Mom', 'hi')).code, 'queued');
  assert.equal(t.web.acks.size, 0);
  t = await linked({ client: { ack: 'error' } });
  assert.equal((await t.web.send('Mom', 'hi')).code, 'failed');
  t = await linked({ client: { ack: 'throw' } });
  assert.deepEqual(await t.web.send('Mom', 'hi'), { ok: false, code: 'failed', name: 'Mom', error: 'Evaluation failed' });
  assert.deepEqual(await engine().web.send('Mom', 'hi'), { ok: false, code: 'web_not_ready' });
});

test('unlink logs out, closes the browser and deletes the saved session', async () => {
  const t = await linked();
  fs.writeFileSync(path.join(t.dataPath, 'session.txt'), 'x');
  await t.web.unlink();
  assert.equal(t.clients[0].calls.logout, 1);
  assert.equal(t.clients[0].calls.destroy, 1);
  assert.equal(fs.existsSync(t.dataPath), false);
  assert.deepEqual(t.web.status(), { state: 'off', qr: '', me: null, error: '', linked: false });
});

test('the browser is Edge if present, else Chrome', () => {
  const env = { 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local' };
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const chrome = 'C:\\Users\\p\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  assert.equal(findBrowser(env, (p) => p === edge || p === chrome), edge);
  assert.equal(findBrowser(env, (p) => p === chrome), chrome);
  assert.equal(findBrowser(env, () => false), '');
});

// ---- WhatsApp commands with the engine
function control(o = {}) {
  const values = { pcControl: true, whatsappAutomation: true, whatsappCallType: 'voice', waWebLinked: true, whatsappContacts: [], ...o.values };
  const settings = o.settings ? (o.settings.update({ ...values, ...o.settings.values }), o.settings) : settingsStore(values); // share the engine's settings like the app does
  const runs = [];
  const links = [];
  const ctl = new WhatsAppControl({
    settings,
    platform: 'win32',
    web: o.web,
    onLink: () => links.push(1),
    hooks: {
      run: async (request) => {
        runs.push(request);
        return { ok: true, code: request.action === 'send' ? 'sent' : 'calling' };
      },
    },
  });
  return { ctl, runs, links, values: settings.values };
}

test('once linked, messages go through WhatsApp Web and nothing on screen is touched', async () => {
  const t = await linked();
  const { ctl, runs } = control({ web: t.web });
  assert.equal(ctl.route(), 'web');
  assert.equal(await ctl.run(parse('message mom on WhatsApp: Home by 8')), 'Sent your message to Mom on WhatsApp ✓');
  assert.match(await ctl.run(parse('message Rahul on WhatsApp: hi')), /More than one WhatsApp chat matches "Rahul": Rahul Sharma, Rahul Verma\. Use the full name\. Nothing was sent\./);
  assert.match(await ctl.run(parse('message Nobody on WhatsApp: hi')), /couldn't find "Nobody"/);
  assert.match(await ctl.run(parse('message 98222 22222 on WhatsApp: hi')), /not on WhatsApp/);
  assert.equal(await ctl.run(parse('message 98111 11111 on WhatsApp: hi')), 'Sent your message to +91 98111 11111 on WhatsApp ✓');
  assert.deepEqual(runs, []);
  assert.deepEqual(t.clients[0].sent.map((m) => m.id), ['919800000010@c.us', '919811111111@c.us']);
});

test('a saved number is used for the person it belongs to', async () => {
  const t = await linked();
  const { ctl } = control({ web: t.web, values: { whatsappContacts: [{ name: 'Mummy', phone: '919800000010' }] } });
  assert.equal(await ctl.run(parse('message Mummy on WhatsApp: hi')), 'Sent your message to Mummy on WhatsApp ✓');
  assert.equal(t.clients[0].sent[0].id, '919800000010@c.us');
});

test('calls: WhatsApp Web finds the number, the WhatsApp app rings it', async () => {
  const t = await linked();
  const { ctl, runs, values } = control({ web: t.web });
  await ctl.run(parse('video call Priya on WhatsApp'));
  assert.deepEqual(runs.pop(), { action: 'call', contact: 'Priya Singh', phone: '919800000013', callType: 'video' });
  assert.match(await ctl.run(parse('call family group on WhatsApp')), /Group calls aren't supported/);
  assert.match(await ctl.run(parse('call Rahul on WhatsApp')), /More than one.*No call was started\./);
  values.pcControl = false;
  assert.match(await ctl.run(parse('call Mom on WhatsApp')), /PC controls must be on/);
  assert.equal(runs.length, 0);
  assert.equal(t.clients[0].sent.length, 0);
});

test('without a link the WhatsApp app is used as before; while reconnecting nothing is sent', async () => {
  const { ctl, runs } = control({ values: { waWebLinked: false } });
  assert.equal(ctl.route(), 'app');
  await ctl.run(parse('message Mom on WhatsApp: hi'));
  assert.equal(runs.pop().action, 'send');
  const t = engine({ settings: settingsStore({ waWebLinked: true }) });
  await t.web.start();
  const c = control({ web: t.web, settings: t.settings });
  assert.equal(c.ctl.route(), 'connecting');
  assert.match(await c.ctl.run(parse('message Mom on WhatsApp: hi')), /still connecting/);
  assert.equal(c.runs.length, 0);
  t.clients[0].emit('auth_failure', 'x'); // the link is gone -> back to the app
  assert.equal(c.ctl.route(), 'app');
});

test('linked but stopped (browser closed, sleep): the next command reconnects instead of using the app', async () => {
  const t = await linked({ settings: settingsStore({ waWebLinked: true }) });
  t.clients[0].emit('disconnected', 'NAVIGATION');
  const { ctl, runs } = control({ web: t.web, settings: t.settings });
  assert.match(await ctl.run(parse('message Mom on WhatsApp: hi')), /still connecting/);
  assert.equal(t.clients.length, 2);
  assert.equal(runs.length, 0);
  t.clients[1].emit('ready');
  assert.match(await ctl.run(parse('message Mom on WhatsApp: hi')), /Sent your message to Mom/);
});

test('the engine still obeys the WhatsApp switch and validation', async () => {
  const t = await linked();
  const { ctl, values } = control({ web: t.web });
  values.whatsappAutomation = false;
  assert.match(await ctl.run(parse('message Mom on WhatsApp: hi')), /Turn on WhatsApp automation/);
  values.whatsappAutomation = true;
  assert.match(await ctl.run({ type: 'send', contact: 'Mom', message: '' }), /Include the message/);
  assert.match(await ctl.run({ type: 'send', contact: 'Mom\nDad', message: 'hi' }), /contact or group name/);
  assert.equal(t.clients[0].sent.length, 0);
});

test('"link whatsapp" opens the QR code; status shows the engine', async () => {
  const off = control({ web: engine().web, values: { waWebLinked: false } });
  assert.deepEqual(parse('link my whatsapp'), { type: 'web-link' });
  assert.match(await off.ctl.run(parse('link whatsapp')), /scan the QR code/);
  assert.equal(off.links.length, 1);
  const t = await linked();
  const on = control({ web: t.web });
  assert.match(await on.ctl.run(parse('connect whatsapp web')), /already linked \(Prince\)/);
  assert.equal(on.links.length, 0);
});
