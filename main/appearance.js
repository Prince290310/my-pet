'use strict';
// Themes are additive: the original assets and user configuration stay intact.
const path = require('path');

const HEROES = {
  atlas: { name: 'Spider-Man', animal: 'Avenger', icon: '🕸️', aliases: ['spider-man', 'spiderman', 'spider man', 'peter'], hello: ['Your friendly neighborhood researcher, Prince! 🕸️', 'Spider-Man here. Let me swing over and find that.', 'With great questions comes great research.'], play: ['Web-swing break! 🕸️', 'Race you, Tony!', 'Friendly neighborhood fun.'] },
  dash: { name: 'Captain America', animal: 'Avenger', icon: '🛡️', aliases: ['captain america', 'captain', 'cap', 'steve'], hello: ['Captain America reporting. Your reminders are covered, Prince. 🛡️', 'One task at a time. We can do this all day.', 'Got a mission? Put it on your to-do list.'], play: ['Avengers, assemble! 🛡️', 'Shield training time.', 'I can do this all day.'] },
  bolt: { name: 'Thor', animal: 'Avenger', icon: '⚡', aliases: ['thor'], hello: ['Thor, at your service! Which app shall we summon? ⚡', 'By the power of Mjolnir, your apps are ready.', 'Prince! Name your destination.'], play: ['Bring the thunder! ⚡', 'A worthy training break.', 'Another!'] },
  sage: { name: 'Doctor Strange', animal: 'Avenger', icon: '🔮', aliases: ['doctor strange', 'dr strange', 'strange', 'stephen'], hello: ['Doctor Strange here. What shall we learn, Prince? 🔮', 'Open a portal to knowledge: say "teach me ...".', 'Homework trouble? Let us examine the possibilities.'], play: ['A little portal practice. 🔮', 'The mystic arts need a study break too.', 'There is more than one way to solve this.'] },
  zen: { name: 'Hulk', animal: 'Avenger', icon: '💪', aliases: ['hulk', 'bruce', 'banner'], hello: ['Hulk protect PC! Say "pc health", Prince. 💪', 'Banner here. Battery, memory and storage are covered.', 'Messy Downloads? Hulk can help tidy.'], play: ['Hulk take break! 💪', 'Strong PC. Strong team.', 'Tiny steps, big progress.'] },
  tempo: { name: 'Star-Lord', animal: 'Avenger', icon: '🎧', aliases: ['star-lord', 'starlord', 'star lord', 'quill'], hello: ['Star-Lord on the decks! Say "play something chill". 🎧', 'Your next awesome mix is one command away.', 'Say "next song". I have the soundtrack covered.'], play: ['Dance-off! 🎧', 'Awesome mix time.', 'Nobody saves the day without a soundtrack.'] },
};

function isAvengers(settings) { return settings.get('appearance') === 'avengers'; }
function assetsDir(root, settings) { return isAvengers(settings) ? path.join(root, 'themes', 'avengers') : root; }
function displayName(settings) { return isAvengers(settings) && settings.get('petName') === 'Shadow' ? 'Iron Man' : settings.get('petName'); }
function friendDef(def, settings) { return isAvengers(settings) ? { ...def, ...HEROES[def.id] } : { ...def }; }
function friendLabel(def) { return def.animal === 'Avenger' ? `${def.name} · ${def.job}` : `${def.name} the ${def.animal} · ${def.job}`; }
function presentation(settings) {
  const avengers = isAvengers(settings);
  return { id: avengers ? 'avengers' : 'shadow', name: displayName(settings), icon: avengers ? '⚡' : '🐾', label: avengers ? 'Avengers' : 'Shadow & Friends', assetPath: avengers ? '../../assets/themes/avengers' : '../../assets' };
}
const QUIPS = {
  greetings: ['Iron Man online. What is the mission, Prince? ⚡', 'Suit ready. Brain ready. Your move, Prince.', 'Hey Prince. Ready to build something brilliant?'],
  idle: ['Hydration check, Prince. Even geniuses need water.', 'One task at a time. That is how we save the day.', 'Systems looking good. How is your mission going?'],
  wakeup: ['Reactor online. Back in action, Prince.', 'Powering up. What did I miss?'],
  sleepy: ['Switching the suit to standby. Wake me when you need me.', 'Even the arc reactor needs a quiet moment.'],
  happy: ['Now that is a victory. Nice work, Prince! ⚡', 'Teamwork looks good on us.'],
  drag: ['Easy on the armor, Prince!', 'New flight path? I like it.'],
  reminderDone: ['Mission complete. On to the next one, Prince.', 'Checked off. That is progress.'],
};
function quip(settings, category, fallback) {
  const lines = isAvengers(settings) && QUIPS[category];
  return lines ? lines[Math.floor(Math.random() * lines.length)] : fallback();
}
function personality(settings, original) {
  if (!isAvengers(settings)) return original;
  return `You are ${displayName(settings)}, an Iron Man desktop companion for Prince. You are witty, inventive, loyal and encouraging, with casual Hinglish when appropriate. Your Avengers team is Spider-Man (research), Captain America (reminders), Thor (app launcher), Doctor Strange (tutor), Hulk (PC caretaker), and Star-Lord (music). You are a humanoid armored superhero, never a panther or an animal. Keep the user's existing personality preferences below, but use this character identity instead of any Shadow/panther identity.\n\n${original}`;
}
module.exports = { HEROES, isAvengers, assetsDir, displayName, friendDef, friendLabel, presentation, quip, personality };
