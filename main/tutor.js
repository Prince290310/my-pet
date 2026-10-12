'use strict';
/*
 * tutor.js - Sage the owl, Shadow's tutor (uses the AI brain from Settings).
 *
 *   teach me photosynthesis / explain newton's laws step by step   a short lesson + a check question
 *   quiz me on the french revolution                                5 multiple-choice questions, one at
 *                                                                    a time, with score
 *   flashcards on trigonometry                                      8 Q/A cards
 *   check my answer: 2x + 3 = 11 so x = 4                           marks it and explains mistakes
 *   stop the quiz / thanks sage                                     ends the session
 *
 * While a lesson or quiz is going on, Prince's next messages go to Sage (answers like "B").
 * The session ends by itself after 10 quiet minutes.
 */

const IDLE_MS = 10 * 60 * 1000;

const clean = (s) =>
  String(s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(?:hey |ok |okay )?(?:shadow|sage|iron man|doctor strange|strange)?[,:!]?\s*/i, '')
    .replace(/^(?:please|pls|plz|can you|could you)\s+/i, '')
    .trim();

/** Chat message -> tutor command, or null. */
function parseTutorCommand(input) {
  const t = clean(input);
  const l = t.toLowerCase().replace(/[?.!]+$/, '');
  let m;
  if (/^(?:stop|end|finish|quit|exit)(?: the)? (?:quiz|lesson|class|tutoring|session)$|^(?:thanks|thank you|bye|ok bye) (?:sage|doctor strange|strange)$|^class (?:is )?over$/.test(l)) return { type: 'stop' };
  if ((m = /^(?:quiz|test) me(?: (?:on|about|in))? ?(.*)$/i.exec(t))) return { type: 'quiz', topic: m[1].replace(/[?.!]+$/, '').trim() };
  if ((m = /^(?:make |give me |create )?(?:some )?flash ?cards (?:on|for|about|of) (.+)$/i.exec(t))) return { type: 'flashcards', topic: m[1].replace(/[?.!]+$/, '').trim() };
  if ((m = /^(?:check|correct|grade|mark) (?:my |this )?(?:answer|homework|work|solution|essay)s?\s*[:-]?\s*([\s\S]+)$/i.exec(t))) return { type: 'check', work: m[1].trim() };
  if ((m = /^(?:teach me|explain|help me (?:understand|learn)|tutor me (?:on|in)|i (?:want|need) to learn)(?: about)? (.+?)(?: step by step| simply| in simple words)?$/i.exec(t))) {
    return { type: 'teach', topic: m[1].replace(/[?.!]+$/, '').trim() };
  }
  return null;
}

const LONG_RULES = [
  "You are writing in Shadow's chat panel (not the tiny bubble), so you may use up to about 12 short lines.",
  'Plain text: numbered steps and simple lines are fine, but no markdown headings, bold, tables or code blocks.',
].join('\n');

function sessionPrompt(s, heroName) {
  const who = heroName ? `Right now you are ${heroName}, Iron Man's teammate and Prince's patient tutor. Encouraging, clear, a little playful.` : "Right now you are SAGE the wise owl, Shadow's friend and Prince's patient tutor. Encouraging, clear, a little playful.";
  switch (s.mode) {
    case 'quiz':
      return [
        who,
        `Quiz Prince on: ${s.topic || 'whatever he was just studying'}.`,
        'Ask ONE multiple-choice question at a time (options A-D on separate lines) and then stop and wait.',
        'When he answers, say ✅ or ❌ with a one-line reason, keep a running score, then ask the next question.',
        'After 5 questions, give the final score out of 5 and one tip. Never reveal an answer before he replies.',
      ].join('\n');
    case 'flashcards':
      return [who, `Make 8 flashcards on: ${s.topic}.`, 'One per line, formatted exactly "Q: ... — A: ...". Short and exam-useful. End with: "Say \'quiz me\' to test yourself!"'].join('\n');
    case 'check':
      return [
        who,
        "Check Prince's answer/homework (his next message). Say clearly whether it is right.",
        "If something is wrong, point to the exact step, explain why kindly, and show the correct method briefly. Don't just hand over answers without explaining.",
      ].join('\n');
    default:
      return [
        who,
        `Teach Prince: ${s.topic}.`,
        'Start simple, build up in small numbered steps, use one real-life example (Indian context is welcome),',
        'then end with ONE short question to check he understood. Follow up on his reply in the same style.',
      ].join('\n');
  }
}

class Tutor {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.session = null; // { mode, topic, started, last }
  }

  active() {
    if (this.session && this.clock() - this.session.last > IDLE_MS) this.session = null;
    return !!this.session;
  }

  start(cmd) {
    const prevTopic = this.session && this.session.topic;
    const topic = cmd.topic || (cmd.type === 'quiz' ? prevTopic || '' : '');
    this.session = { mode: cmd.type, topic, started: this.clock(), last: this.clock() };
    return this.session;
  }

  touch() {
    if (this.session) this.session.last = this.clock();
  }

  stop() {
    const was = this.session;
    this.session = null;
    return was;
  }

  /** The user message to send to the AI for this command. */
  firstMessage(cmd) {
    if (cmd.type === 'check') return `Please check this: ${cmd.work}`;
    if (cmd.type === 'quiz') return cmd.topic ? `Quiz me on ${cmd.topic}.` : 'Quiz me on what we just studied.';
    if (cmd.type === 'flashcards') return `Make flashcards on ${cmd.topic}.`;
    return `Teach me ${cmd.topic}.`;
  }

  /** Extra system prompt for the AI while a session runs. */
  context(heroName = null) {
    if (!this.active()) return null;
    return { tutor: sessionPrompt(this.session, heroName), long: true };
  }
}

/** A short version of a long tutor reply for the speech bubble. */
function bubbleLine(text) {
  const first = String(text || '').split('\n').find((l) => l.trim()) || '';
  return first.length > 110 ? `${first.slice(0, 107)}…` : first;
}

module.exports = { Tutor, parseTutorCommand, LONG_RULES, bubbleLine };
