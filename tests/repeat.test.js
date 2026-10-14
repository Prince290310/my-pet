'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskStore, parseCommand: parse, clockHM, daysLabel } = require('../main/tasks');

const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime(); // October 2026: the 14th is a Wednesday
function store(start) {
  let now = start;
  const st = new TaskStore({ clock: () => now });
  return { st, set: (t) => (now = t), say: (text) => st.run(parse(text, now), now), open: () => st.openTodos().map((t) => t.text) };
}

test('plain phrasings for repeating objectives', () => {
  const now = at(14, 10);
  const obj = (text) => {
    const c = parse(text, now);
    return c && c.type === 'repeat-add' && c.todo ? [c.text, c.days.join(''), c.time] : c;
  };
  assert.deepEqual(obj('every day: study 2 hours'), ['study 2 hours', '0123456', '']);
  assert.deepEqual(obj('Everyday - gym'), ['gym', '0123456', '']);
  assert.deepEqual(obj('daily todo: gym'), ['gym', '0123456', '']);
  assert.deepEqual(obj('daily objective meditate'), ['meditate', '0123456', '']);
  assert.deepEqual(obj('har roz: pray'), ['pray', '0123456', '']);
  assert.deepEqual(obj('every weekday at 7 pm: gym'), ['gym', '12345', '19:00']);
  assert.deepEqual(obj('every weekend: clean my room'), ['clean my room', '06', '']);
  assert.deepEqual(obj('every mon, wed and fri: gym'), ['gym', '135', '']);
  assert.deepEqual(obj('every sunday: plan the week'), ['plan the week', '0', '']);
  assert.deepEqual(obj('add revise notes to my objectives every monday and thursday'), ['revise notes', '14', '']);
  assert.deepEqual(obj('every day add drink water to my list'), ['drink water', '0123456', '']);
  assert.deepEqual(obj('make gym a daily objective'), ['gym', '0123456', '']);
  assert.deepEqual(obj('repeat study 2 hours every day'), ['study 2 hours', '0123456', '']);
  assert.deepEqual(parse('make 3 daily', now), { type: 'repeat-add', todo: true, n: 3, days: [0, 1, 2, 3, 4, 5, 6], time: '' });
  // ordinary sentences are left to the chat
  for (const t of ['everyday i feel tired', 'every day I wake up late', 'I go to the gym every day', 'todo: gym', 'add gym to my list']) {
    const c = parse(t, now);
    assert.ok(!c || !c.type.startsWith('repeat'), t);
  }
});

test('plain phrasings for repeating reminders; "on monday" stays one-time', () => {
  const now = at(14, 10);
  const rem = (text) => {
    const c = parse(text, now);
    return c && c.type === 'repeat-add' && !c.todo ? [c.text, c.days.join(''), c.time] : c;
  };
  assert.deepEqual(rem('remind me every day at 9 pm to drink water'), ['drink water', '0123456', '21:00']);
  assert.deepEqual(rem('remind me to drink water every day at 9 pm'), ['drink water', '0123456', '21:00']);
  assert.deepEqual(rem('remind me to drink water at 9 pm every day'), ['drink water', '0123456', '21:00']);
  assert.deepEqual(rem('every night at 10 remind me to sleep'), ['sleep', '0123456', '22:00']);
  assert.deepEqual(rem('remind me every morning to take vitamins'), ['take vitamins', '0123456', '08:00']);
  assert.deepEqual(rem('remind me on mondays at 8 am to submit the form'), ['submit the form', '1', '08:00']);
  assert.deepEqual(parse('remind me to drink water every day', now), { type: 'repeat-error', error: 'need-time' });
  assert.equal(parse('remind me at 6 pm to call mom', now).type, 'remind');
  assert.equal(parse('remind me tomorrow at 7 to run', now).type, 'remind');
  assert.equal(clockHM('9'), '09:00');
  assert.equal(clockHM('6'), '18:00');
  assert.equal(clockHM('10', 'night'), '22:00');
  assert.equal(clockHM('12:30 am'), '00:30');
  assert.equal(daysLabel([1, 3, 5]), 'every Mon, Wed & Fri');
  assert.equal(daysLabel([0, 1]), 'every Mon & Sun');
});

test('a repeating objective comes back every morning from 5 AM - never twice, carried over if not done', () => {
  const { st, set, say, open } = store(at(14, 10));
  assert.match(say('every day: study 2 hours'), /^Done 🔁 "study 2 hours" goes on your objectives every day by itself\. It's on today's list too\.$/);
  assert.deepEqual(open(), ['study 2 hours']);
  set(at(14, 11));
  st.check();
  assert.deepEqual(open(), ['study 2 hours']); // not again today
  assert.match(say('done 1'), /done\. 🔁 Back tomorrow\./);
  set(at(15, 4, 59));
  st.check();
  assert.deepEqual(open(), []); // the day starts at 5
  set(at(15, 5));
  st.check();
  assert.deepEqual(open(), ['study 2 hours']);
  set(at(16, 6)); // not done yesterday: still one copy
  st.check();
  assert.deepEqual(open(), ['study 2 hours']);
});

test('only on its days; created on another day it waits', () => {
  const { st, set, say, open } = store(at(14, 10)); // Wednesday
  assert.match(say('every monday: plan the week'), /First one on Monday\.$/);
  assert.deepEqual(open(), []);
  for (const d of [15, 16, 17, 18]) {
    set(at(d, 9));
    st.check();
    assert.deepEqual(open(), [], `Oct ${d}`);
  }
  set(at(19, 9)); // Monday
  st.check();
  assert.deepEqual(open(), ['plan the week']);
});

test('an existing objective can be made repeating; the same words are not added twice', () => {
  const { st, set, say, open } = store(at(14, 10));
  say('todo: gym');
  say('todo: buy milk');
  assert.match(say('make 1 daily'), /"gym" goes on your objectives every day/);
  assert.deepEqual(st.openTodos().map((t) => !!t.rid), [true, false]);
  assert.match(say('every day: gym'), /^Updated 🔁/);
  assert.equal(st.repeats().length, 1);
  set(at(15, 6));
  st.check();
  assert.deepEqual(open(), ['gym', 'buy milk']);
  assert.match(say('make 9 daily'), /no number 9/);
});

test('repeating reminders fire once a day at their time, late ones are marked, very old ones skipped', () => {
  const { st, set, say } = store(at(14, 22)); // 10 PM: today's 9 PM has passed
  assert.match(say('remind me every day at 9 pm to drink water'), /First one tomorrow\./);
  assert.deepEqual(st.check(), []);
  set(at(15, 20, 59));
  assert.deepEqual(st.check(), []);
  set(at(15, 21, 0));
  assert.deepEqual(st.check().map((r) => r.message), ['Prince! Drink water 🔁']);
  set(at(15, 21, 5));
  assert.deepEqual(st.check(), []);
  set(at(16, 21, 30)); // the PC woke up half an hour late
  assert.deepEqual(st.check().map((r) => r.message), ['Prince! Drink water 🔁 (was due 9:00 PM)']);
  set(at(18, 4)); // off from before 9 PM on the 17th until 4 AM: too old to be useful
  assert.deepEqual(st.check(), []);
});

test('an objective with a time nudges only if it is still open', () => {
  const { st, set, say } = store(at(14, 10));
  say('every day at 7 pm: study');
  set(at(14, 19));
  assert.deepEqual(st.check().map((r) => r.message), ["Prince! Time for: Study 🔁 (still on today's objectives)"]);
  set(at(15, 6));
  st.check();
  say('done 1');
  set(at(15, 19));
  assert.deepEqual(st.check(), []);
});

test('list, stop by number or name, and removing today\'s copy', () => {
  const { st, say, open } = store(at(14, 10));
  say('every day: study 2 hours');
  say('every weekday at 7 pm: gym');
  say('remind me every day at 9 pm to drink water');
  assert.equal(say('my repeating tasks'), 'Repeating: 1. 🔁 every day - study 2 hours · 2. 🔁 every weekday - gym (nudge at 7:00 PM if not done) · 3. ⏰ every day at 9:00 PM - drink water. Stop one with "stop repeating 2".');
  assert.equal(say('show my list'), 'Your list: 1. 🔁 study 2 hours · 2. 🔁 gym');
  assert.match(say('remove 2'), /^Removed today's "gym"\. It's a repeating objective, so it comes back tomorrow/);
  assert.equal(say('stop repeating 3'), 'Stopped ✓ "drink water" won\'t repeat any more.');
  assert.equal(say('stop repeating study'), 'Stopped ✓ "study 2 hours" won\'t repeat any more. Today\'s one stays on your list.');
  assert.deepEqual(open(), ['study 2 hours']);
  assert.equal(st.openTodos()[0].rid, undefined);
  assert.match(say('stop repeating yoga'), /^I couldn't find that one/);
  say('every day: maths revision');
  say('every day: maths homework');
  assert.match(say('stop repeating maths'), /^More than one repeating task matches "maths"/);
});

test('saved and reloaded; bad entries in the file are dropped', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'repeat-test-')), 'tasks.json');
  const a = new TaskStore({ file, clock: () => at(14, 10) });
  a.run(parse('every day: study'));
  a.run(parse('remind me every day at 9 pm to drink water'));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.repeats.push({ id: 'x', text: 'no days', days: [] }, { id: 'y', text: 'reminder without time', days: [1], todo: false });
  fs.writeFileSync(file, JSON.stringify(raw));
  const b = new TaskStore({ file, clock: () => at(14, 10) });
  assert.deepEqual(b.repeats().map((r) => r.text), ['study', 'drink water']);
  assert.ok(b.openTodos()[0].rid);
});

test('the AI can set and stop repeating tasks with hidden tags', () => {
  const { st } = store(at(14, 10));
  const r = st.applyTags('Done Prince!\n[[repeat remind | weekdays | 07:30 | wake up]]\n[[repeat todo | mon,wed | read 20 pages]]\n[[repeat todo | daily | 18:00 | gym]]', at(14, 10));
  assert.equal(r.text, 'Done Prince! 🔁 every weekday at 7:30 AM - wake up · 🔁 every Mon & Wed - read 20 pages · 🔁 every day - gym (nudge at 6:00 PM if not done)');
  assert.deepEqual(st.repeats().map((x) => [x.todo, x.days.join(''), x.time]), [[false, '12345', '07:30'], [true, '13', ''], [true, '0123456', '18:00']]);
  assert.match(st.chatContext(at(14, 10)), /Repeating objectives and reminders \(numbered\):\n1\. reminder every weekday at 7:30 AM - wake up/);
  const s = st.applyTags('Okay, I stopped it. [[repeat stop | 1]]', at(14, 10));
  assert.equal(s.text, 'Okay, I stopped it.');
  assert.equal(st.repeats().length, 2);
  assert.equal(st.applyTags('[[repeat remind | someday | 07:30 | x]]').text, "couldn't set that repeating reminder");
});
