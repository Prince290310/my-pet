'use strict';
/*
 * games.js - mini-games for study breaks.
 *
 *   catch the treat   Treats fall from the top of the screen; Shadow runs along the bottom after your
 *                     mouse and catches them. 🐟 +1 · 🍗 +2 · 🥩 +3 · ⭐ +5 · 🥦 -2 (panthers hate
 *                     broccoli). 45 seconds. The treats live in a see-through, click-through layer,
 *                     so your clicks still go to whatever is underneath.
 *   quiz race         5 questions in the chat; type the answer before Sage buzzes in. Maths sums
 *                     (works offline), or "quiz race on planets" (needs the AI brain).
 *   stop the game · my high scores
 *
 * Best scores are kept in %APPDATA%\Shadow\games.json.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const TREATS = [
  { kind: 'fish', emoji: '🐟', points: 1, weight: 55 },
  { kind: 'drumstick', emoji: '🍗', points: 2, weight: 25 },
  { kind: 'steak', emoji: '🥩', points: 3, weight: 10 },
  { kind: 'star', emoji: '⭐', points: 5, weight: 4 },
  { kind: 'broccoli', emoji: '🥦', points: -2, weight: 6 },
];
const SIZE = 40; // treat size in px

const clean = (s) =>
  String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(?:hey |ok |okay )?(?:shadow|sage)?[,:!]?\s*/i, '')
    .replace(/^(?:please|pls|plz|can you|could you)\s+/i, '')
    .replace(/[?.!]+$/, '')
    .trim();

/** Chat message -> game command, or null. */
function parseGameCommand(input) {
  const l = clean(input).toLowerCase();
  let m;
  if (/^(?:let'?s )?(?:play )?(?:catch(?: the)? treats?|treat catch(?:er)?|the treat game|catch game|play catch)$/.test(l)) return { type: 'catch' };
  if ((m = /^(?:let'?s )?(?:start |play |do )?(?:an? |the )?(?:quiz race|race(?: against| with| vs\.?)? sage|quiz battle|maths? race|maths? quiz race|speed quiz)(?: (?:on|about|of) (.+))?$/.exec(l))) {
    return { type: 'race', topic: m[1] ? m[1].trim().slice(0, 80) : '' };
  }
  if (/^(?:stop|end|quit|exit|cancel)(?: the| this)? (?:game|race|quiz race|catch)$/.test(l)) return { type: 'stop' };
  if (/^(?:my |show (?:my )?)?(?:high ?scores?|best scores?|game scores?|scores)$/.test(l)) return { type: 'scores' };
  if (/^(?:let'?s )?play (?:a |some )?(?:game|games|mini ?-?games?)(?: with me)?$|^(?:mini ?-?games?|games|i'?m bored|im bored|i am bored|play with me|game time)$/.test(l)) return { type: 'menu' };
  return null;
}

// ------------------------------------------------------------------ scores
class Scores {
  constructor(file) {
    this.file = file;
    this.data = { catchBest: 0, catchPlays: 0, raceWins: 0, raceLosses: 0, raceDraws: 0 };
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      /* first game */
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.warn('[games] could not save:', err.message);
    }
  }

  text() {
    const d = this.data;
    const race = d.raceWins + d.raceLosses + d.raceDraws;
    return `🏆 Catch the treat best: ${d.catchBest} (${d.catchPlays} game${d.catchPlays === 1 ? '' : 's'}) · Quiz race vs Sage: ${race ? `${d.raceWins} won, ${d.raceLosses} lost${d.raceDraws ? `, ${d.raceDraws} tied` : ''}` : 'not raced yet'}`;
  }
}

// ------------------------------------------------------------------ catch the treat
class CatchGame extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./brain').Brain} o.brain
   * @param {import('./petWindow').PetWindow} o.pet
   * @param {{ cursor(): {x,y} }} o.sensors
   * @param {(workArea) => { send(state), close() }} o.openLayer  the see-through treat layer (main.js)
   * @param {Scores} o.scores
   */
  constructor({ brain, pet, sensors, openLayer, scores, rng = Math.random, durationMs = 45000, tickMs = 33 }) {
    super();
    Object.assign(this, { brain, pet, sensors, openLayer, scores, rng, durationMs, tickMs });
    this.game = null;
  }

  running() {
    return !!this.game;
  }

  start() {
    if (this.game) return 'We are already playing! Move your mouse 🐾';
    if (this.brain.activeReminder) return 'Close the reminder first, Prince ⏰';
    const wa = this.pet.display().workArea;
    this.brain.startGame();
    const layer = this.openLayer(wa);
    const now = Date.now();
    this.game = { wa, layer, treats: [], pops: [], score: 0, caught: 0, t0: now, last: now, nextSpawn: now + 900, id: 0 };
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.emit('start');
    return '🎮 Catch the treat! Move your mouse left and right - Shadow runs after it. 🐟 +1 · 🍗 +2 · 🥩 +3 · ⭐ +5 · 🥦 -2 · 45 seconds. GO! (say "stop the game" to quit)';
  }

  pickTreat() {
    let r = this.rng() * TREATS.reduce((s, t) => s + t.weight, 0);
    for (const t of TREATS) if ((r -= t.weight) <= 0) return t;
    return TREATS[0];
  }

  /** Drop a treat (x/kind/y optional - the self-test drops them where it wants). */
  spawn({ x, kind, y, vy } = {}) {
    const g = this.game;
    if (!g) return null;
    const type = TREATS.find((t) => t.kind === kind) || this.pickTreat();
    const speedUp = 1 + Math.min(0.6, (Date.now() - g.t0) / this.durationMs); // faster towards the end
    const treat = {
      id: ++g.id,
      ...type,
      x: x !== undefined ? x : g.wa.x + SIZE + this.rng() * (g.wa.width - 2 * SIZE),
      y: y !== undefined ? y : g.wa.y - SIZE,
      vy: vy !== undefined ? vy : (220 + this.rng() * 160) * speedUp,
    };
    g.treats.push(treat);
    return treat;
  }

  tick() {
    const g = this.game;
    if (!g) return;
    const now = Date.now();
    const dt = Math.min(0.1, (now - g.last) / 1000);
    g.last = now;
    // Shadow runs after the mouse along the floor
    const c = this.sensors.cursor();
    this.brain.gameMove(c.x - this.pet.S / 2, dt);
    if (now >= g.nextSpawn) {
      this.spawn();
      const progress = (now - g.t0) / this.durationMs;
      g.nextSpawn = now + (850 - 400 * Math.min(1, progress)) * (0.7 + this.rng() * 0.6);
    }
    // catch zone: the panther's body (the sprite box, minus the empty top)
    const S = this.pet.S;
    const px = this.pet.pos.x;
    const py = this.pet.pos.y;
    const keep = [];
    for (const t of g.treats) {
      t.y += t.vy * dt;
      const inX = t.x >= px + S * 0.08 && t.x <= px + S * 0.92;
      const inY = t.y + SIZE / 2 >= py + S * 0.35 && t.y - SIZE / 2 <= py + S;
      if (inX && inY) {
        g.score = Math.max(0, g.score + t.points);
        if (t.points > 0) g.caught++;
        g.pops.push({ x: t.x, y: py, text: t.points > 0 ? `+${t.points}` : `${t.points} yuck!`, until: now + 700, bad: t.points < 0 });
        this.emit('caught', t);
      } else if (t.y - SIZE > g.wa.y + g.wa.height) {
        // fell past the floor
      } else keep.push(t);
    }
    g.treats = keep;
    g.pops = g.pops.filter((p) => p.until > now);
    const left = Math.max(0, Math.ceil((g.t0 + this.durationMs - now) / 1000));
    g.layer.send({
      wa: g.wa,
      treats: g.treats.map((t) => ({ x: t.x - g.wa.x, y: t.y - g.wa.y, emoji: t.emoji })),
      pops: g.pops.map((p) => ({ x: p.x - g.wa.x, y: p.y - g.wa.y, text: p.text, bad: p.bad })),
      score: g.score,
      left,
    });
    if (now - g.t0 >= this.durationMs) this.stop('time');
  }

  /** End the game. reason: time | stopped | interrupted. Returns the result line. */
  stop(reason = 'stopped') {
    const g = this.game;
    if (!g) return null;
    clearInterval(this.timer);
    this.game = null;
    try {
      g.layer.close();
    } catch {
      /* already gone */
    }
    const d = this.scores.data;
    const best = g.score > d.catchBest;
    d.catchPlays++;
    if (best) d.catchBest = g.score;
    this.scores.save();
    const line =
      reason === 'interrupted'
        ? `Game paused for something important - you had ${g.score} points 🐾`
        : `🏁 ${reason === 'time' ? "Time's up!" : 'Game over!'} ${g.score} point${g.score === 1 ? '' : 's'} (${g.caught} treat${g.caught === 1 ? '' : 's'} caught)${best && g.score ? ' - NEW BEST! 🏆' : ` · best ${d.catchBest}`}`;
    this.brain.endGame(reason !== 'interrupted' ? line : null);
    this.emit('end', { score: g.score, best, line, reason });
    return line;
  }
}

// ------------------------------------------------------------------ quiz race vs Sage
const NUM_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.\s-]/g, ' ')
    .replace(/\b(?:the|a|an|is|it'?s|its|answer|i think|maybe)\b/g, ' ')
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, (w) => String(NUM_WORDS[w]))
    .replace(/\s+/g, ' ')
    .trim();
}

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** Is `given` a right answer to a question with answers `answers`? Forgives small typos. */
function isRight(given, answers) {
  const g = norm(given);
  if (!g) return false;
  return answers.some((ans) => {
    const a = norm(ans);
    if (!a) return false;
    if (g === a) return true;
    if (/^-?\d+(?:\.\d+)?$/.test(a)) return Number(g.replace(/[^\d.-]/g, '')) === Number(a) && /\d/.test(g);
    if (a.length >= 4 && (` ${g} `.includes(` ${a} `) || g.split(' ').some((w) => w.length >= 4 && distance(w, a) <= (a.length >= 8 ? 2 : 1)))) return true;
    return a.length >= 4 && distance(g, a) <= (a.length >= 8 ? 2 : 1);
  });
}

/** 5 quick mental-maths questions (no AI needed). */
function mathQuestions(rng = Math.random, n = 5) {
  const r = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const out = [];
  for (let i = 0; i < n; i++) {
    const kind = ['+', '-', '×', '÷', '×'][r(0, 4)];
    let q;
    let a;
    if (kind === '+') {
      const x = r(12, 89);
      const y = r(12, 89);
      q = `${x} + ${y}`;
      a = x + y;
    } else if (kind === '-') {
      const x = r(30, 99);
      const y = r(11, x - 5);
      q = `${x} − ${y}`;
      a = x - y;
    } else if (kind === '×') {
      const x = r(3, 15);
      const y = r(4, 12);
      q = `${x} × ${y}`;
      a = x * y;
    } else {
      const y = r(3, 12);
      a = r(3, 15);
      q = `${a * y} ÷ ${y}`;
    }
    out.push({ q: `${q} = ?`, answers: [String(a)] });
  }
  return out;
}

/** The AI's quiz JSON -> questions, or null if it's unusable. */
function parseAiQuestions(text) {
  const m = /\[[\s\S]*\]/.exec(String(text || ''));
  if (!m) return null;
  let list;
  try {
    list = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const out = list
    .filter((x) => x && typeof x.q === 'string' && (typeof x.a === 'string' || typeof x.a === 'number'))
    .map((x) => ({
      q: x.q.trim().slice(0, 200),
      answers: [String(x.a), ...(Array.isArray(x.alts) ? x.alts.filter((v) => typeof v === 'string' || typeof v === 'number').map(String) : [])].map((v) => v.trim().slice(0, 60)).filter(Boolean),
    }))
    .filter((x) => x.q && x.answers.length)
    .slice(0, 5);
  return out.length >= 3 ? out : null;
}

const AI_PROMPT = (topic) =>
  [
    `Make 5 quick quiz questions about "${topic}" for a student, easy to medium.`,
    'Each answer must be ONE short thing: a number, a name or 1-3 words (no full sentences, no multiple choice).',
    'Reply with ONLY a JSON array, nothing else, like:',
    '[{"q":"Which planet is known as the Red Planet?","a":"Mars","alts":[]},{"q":"How many legs does a spider have?","a":"8","alts":["eight"]}]',
    'Put other accepted spellings or forms in "alts".',
  ].join('\n');

class QuizRace {
  /**
   * @param {object} o
   * @param {(prompt: string) => Promise<string>} [o.askAi]  null when there's no AI brain
   * @param {Scores} o.scores
   * @param {(q) => number} [o.sageMs]  how long Sage takes to "think"
   */
  constructor({ scores, rng = Math.random, sageMs = null, gapMs = 1600 }) {
    this.scores = scores;
    this.rng = rng;
    this.sageMs = sageMs || (() => 6500 + this.rng() * 4000);
    this.gapMs = gapMs;
    this.race = null;
  }

  active() {
    return !!this.race;
  }

  /**
   * Start a race. `push(text)` delivers lines that come later (Sage buzzing in, next question).
   * Returns the first message.
   */
  async start({ topic = '', askAi = null, push }) {
    this.stop(true);
    let questions = null;
    let note = '';
    if (topic && askAi) {
      try {
        questions = parseAiQuestions(await askAi(AI_PROMPT(topic)));
      } catch {
        questions = null;
      }
      if (!questions) note = `(Sage couldn't write questions on ${topic}, so it's maths!) `;
    } else if (topic) note = `(Topic races need the AI brain - Settings → AI Brain. Maths it is!) `;
    if (!questions) {
      questions = mathQuestions(this.rng);
      topic = '';
    }
    this.race = { questions, i: 0, me: 0, sage: 0, push, topic, timer: null };
    this.armSage();
    return `🏁 Quiz race vs Sage${topic ? ` - ${topic}` : ' - mental maths'}! ${note}${questions.length} questions. Type the answer before Sage buzzes in 🦉\n${this.questionText()}`;
  }

  questionText() {
    const r = this.race;
    return `Q${r.i + 1}/${r.questions.length}: ${r.questions[r.i].q}`;
  }

  score() {
    const r = this.race;
    return `Prince ${r.me} – ${r.sage} Sage`;
  }

  armSage() {
    const r = this.race;
    clearTimeout(r.timer);
    const qi = r.i;
    r.timer = setTimeout(() => {
      if (this.race !== r || r.i !== qi) return;
      r.sage++;
      const a = r.questions[qi].answers[0];
      this.next(`🦉 Sage buzzes in: ${a}! ${this.score()}`, (text) => r.push && r.push(text));
    }, this.sageMs(r.questions[qi]));
  }

  /** Move on after a point. `say` delivers the text (reply or push). */
  next(lead, say) {
    const r = this.race;
    r.i++;
    if (r.i >= r.questions.length) {
      const out = `${lead}\n${this.finish()}`;
      say(out);
      return out;
    }
    const out = `${lead}\n${this.questionText()}`;
    say(out);
    this.armSage();
    return out;
  }

  finish() {
    const r = this.race;
    clearTimeout(r.timer);
    this.race = null;
    const d = this.scores.data;
    let line;
    if (r.me > r.sage) {
      d.raceWins++;
      line = `🏆 You beat Sage ${r.me}–${r.sage}! Sage is cleaning his glasses in shame 🦉`;
    } else if (r.me < r.sage) {
      d.raceLosses++;
      line = `🦉 Sage wins ${r.sage}–${r.me} this time. Rematch? Say "quiz race"`;
    } else {
      d.raceDraws++;
      line = `🤝 It's a tie, ${r.me}–${r.sage}! Rematch? Say "quiz race"`;
    }
    this.scores.save();
    return line;
  }

  /** Prince typed something during a race -> the reply. */
  answer(text) {
    const r = this.race;
    if (!r) return null;
    const q = r.questions[r.i];
    if (isRight(text, q.answers)) {
      r.me++;
      let out = '';
      this.next(`✅ ${q.answers[0]} - you got it first! ${this.score()}`, (t) => (out = t));
      return out;
    }
    return `❌ Not quite - try again! (Sage is thinking… 🦉)`;
  }

  /** Ends a race early. Returns a line, or null if none was running. */
  stop(quiet = false) {
    const r = this.race;
    if (!r) return null;
    clearTimeout(r.timer);
    this.race = null;
    return quiet ? null : `Race stopped at ${r.me}–${r.sage}. Say "quiz race" for a new one 🏁`;
  }
}

module.exports = { CatchGame, QuizRace, Scores, parseGameCommand, isRight, mathQuestions, parseAiQuestions, TREATS };
