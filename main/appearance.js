'use strict';
// Themes are additive: the original assets and user configuration stay intact.
const path = require('path');
const { profile } = require('./hero-motion');
const ROSTER = {
  ironman: { name: 'Iron Man', icon: '⚡', aliases: ['iron man', 'ironman', 'tony'], hello: ['Iron Man online. What is the mission, Prince?', 'Systems ready. Let us get this done.'], play: ['Thrusters ready!', 'Now that is a victory.'] },
  spiderman: { name: 'Spider-Man', icon: '🕸️', aliases: ['spider-man', 'spiderman', 'spider man', 'peter'] },
  cap: { name: 'Captain America', icon: '🛡️', aliases: ['captain america', 'captain', 'cap', 'steve'] },
  thor: { name: 'Thor', icon: '⚡', aliases: ['thor'] },
  strange: { name: 'Doctor Strange', icon: '🔮', aliases: ['doctor strange', 'dr strange', 'strange', 'stephen'] },
  hulk: { name: 'Hulk', icon: '💪', aliases: ['hulk', 'bruce', 'banner'] },
  quicksilver: { name: 'Quicksilver', icon: '💨', aliases: ['quicksilver', 'quick silver', 'quick sliver', 'pietro'] },
};
const SLOTS = { atlas: 'spiderman', dash: 'cap', bolt: 'thor', sage: 'strange', zen: 'hulk', tempo: 'quicksilver' };
// These characters are visual teammates only. They have no job or command skill.
const CHARACTERS = {
  vision: { name: 'Vision', icon: '💎', aliases: ['vision'] },
  wanda: { name: 'Scarlet Witch', icon: '🔴', aliases: ['scarlet witch', 'wanda', 'wanda maximoff'] },
  widow: { name: 'Black Widow', icon: '🕷️', aliases: ['black widow', 'widow', 'natasha'] },
  panther: { name: 'Black Panther', icon: '🐾', aliases: ['black panther', 'tchalla', "t'challa"] },
  hawkeye: { name: 'Hawkeye', icon: '🏹', aliases: ['hawkeye', 'clint', 'clint barton'] },
  antman: { name: 'Ant-Man', icon: '🐜', aliases: ['ant-man', 'antman', 'ant man', 'scott lang'] },
  falcon: { name: 'Falcon', icon: '🪽', aliases: ['falcon', 'sam wilson'] },
  warmachine: { name: 'War Machine', icon: '⚙️', aliases: ['war machine', 'warmachine', 'rhodey'] },
};

function friendDefinitions(original, settings) {
  const existing = original.map(d => friendDef(d, settings));
  if (!isAvengers(settings)) return existing;
  return existing.concat(Object.entries(CHARACTERS).map(([id, h]) => ({
    id, ...h, animal: 'Avenger', heroId: id, cosmetic: true, job: null, blurb: '',
    speed: profile(id).friendSpeed, flies: profile(id).flies,
    hello: [`${h.name} is here, Prince. ${h.icon}`, 'Happy to be part of the team!'],
    play: ['Avengers, assemble!', 'Time for a team break!'],
  })));
}

const HEROES = {
  atlas: { name: 'Spider-Man', animal: 'Avenger', icon: '🕸️', aliases: ['spider-man', 'spiderman', 'spider man', 'peter'], hello: ['Your friendly neighborhood researcher, Prince! 🕸️', 'Spider-Man here. Let me swing over and find that.', 'With great questions comes great research.'], play: ['Web-swing break! 🕸️', 'Race you, Tony!', 'Friendly neighborhood fun.'] },
  dash: { name: 'Captain America', animal: 'Avenger', icon: '🛡️', aliases: ['captain america', 'captain', 'cap', 'steve'], hello: ['Captain America reporting. Your reminders are covered, Prince. 🛡️', 'One task at a time. We can do this all day.', 'Got a mission? Put it on your to-do list.'], play: ['Avengers, assemble! 🛡️', 'Shield training time.', 'I can do this all day.'] },
  bolt: { name: 'Thor', animal: 'Avenger', icon: '⚡', aliases: ['thor'], hello: ['Thor, at your service! Which app shall we summon? ⚡', 'By the power of Mjolnir, your apps are ready.', 'Prince! Name your destination.'], play: ['Bring the thunder! ⚡', 'A worthy training break.', 'Another!'] },
  sage: { name: 'Doctor Strange', animal: 'Avenger', icon: '🔮', aliases: ['doctor strange', 'dr strange', 'strange', 'stephen'], hello: ['Doctor Strange here. What shall we learn, Prince? 🔮', 'Open a portal to knowledge: say "teach me ...".', 'Homework trouble? Let us examine the possibilities.'], play: ['A little portal practice. 🔮', 'The mystic arts need a study break too.', 'There is more than one way to solve this.'] },
  zen: { name: 'Hulk', animal: 'Avenger', icon: '💪', aliases: ['hulk', 'bruce', 'banner'], hello: ['Hulk protect PC! Say "pc health", Prince. 💪', 'Banner here. Battery, memory and storage are covered.', 'Messy Downloads? Hulk can help tidy.'], play: ['Hulk take break! 💪', 'Strong PC. Strong team.', 'Tiny steps, big progress.'] },
  tempo: { name: 'Quicksilver', animal: 'Avenger', icon: '💨', aliases: ROSTER.quicksilver.aliases, hello: ['Quicksilver here. Your soundtrack is ready before you blink! 💨', 'Say "play something chill" and watch me go.', 'Need the next song? I am already on it.'], play: ['Catch me if you can! 💨', 'A quick lap, then back to the music.', 'You did not see that coming?'] },
};

function isAvengers(settings) { return settings.get('appearance') === 'avengers'; }
function assetsDir(root, settings) { return isAvengers(settings) ? path.join(root, 'themes', 'avengers') : root; }
function mainHero(settings) { return ROSTER[settings.get('mainHero')] ? settings.get('mainHero') : 'ironman'; }
function mainAssetsDir(root, settings) { return isAvengers(settings) ? path.join(assetsDir(root, settings), 'heroes', mainHero(settings)) : root; }
function friendHero(id, settings) { return CHARACTERS[id] ? id : SLOTS[id] === mainHero(settings) ? 'ironman' : SLOTS[id]; }
function friendAsset(root, settings, id, extension) {
  return isAvengers(settings) ? path.join(assetsDir(root, settings), 'heroes', friendHero(id, settings), `friend.${extension}`) : path.join(root, 'friends', `${id}.${extension}`);
}
function displayName(settings) { return isAvengers(settings) && settings.get('petName') === 'Shadow' ? ROSTER[mainHero(settings)].name : settings.get('petName'); }
function friendDef(def, settings) {
  if (!isAvengers(settings)) return { ...def };
  const heroId = friendHero(def.id, settings);
  const swapped = heroId === 'ironman';
  return { ...def, ...HEROES[def.id], ...(swapped ? ROSTER.ironman : {}), heroId, speed: profile(heroId).friendSpeed, flies: profile(heroId).flies };
}
function friendLabel(def) { return def.animal === 'Avenger' ? `${def.name} · ${def.job || 'No job assigned'}` : `${def.name} the ${def.animal} · ${def.job}`; }
function presentation(settings) {
  const avengers = isAvengers(settings);
  return { id: avengers ? 'avengers' : 'shadow', name: displayName(settings), mainHero: mainHero(settings), heroes: Object.entries(ROSTER).map(([id, h]) => ({ id, name: h.name })), icon: avengers ? ROSTER[mainHero(settings)].icon : '🐾', label: avengers ? 'Avengers' : 'Shadow & Friends', assetPath: avengers ? `../../assets/themes/avengers/heroes/${mainHero(settings)}` : '../../assets' };
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
  if (isAvengers(settings) && mainHero(settings) !== 'ironman') {
    const id = mainHero(settings), hero = ROSTER[id];
    const def = Object.values(HEROES).find(h => h.name === hero.name);
    const lines = category === 'greetings' ? def.hello : category === 'happy' ? def.play : [`${hero.name} here. ${category === 'sleepy' ? 'Taking a break. I will be here when you need me.' : category === 'wakeup' ? 'Back in action, Prince!' : category === 'drag' ? 'New route? Let us go!' : category === 'reminderDone' ? 'Mission complete, Prince.' : 'How is your mission going, Prince?'} ${hero.icon}`];
    return lines[Math.floor(Math.random() * lines.length)];
  }
  const lines = isAvengers(settings) && QUIPS[category];
  return lines ? lines[Math.floor(Math.random() * lines.length)] : fallback();
}
function personality(settings, original) {
  if (!isAvengers(settings)) return original;
  const hero = ROSTER[mainHero(settings)].name;
  const team = Object.entries(HEROES).map(([id, h]) => `${friendHero(id, settings) === 'ironman' ? 'Iron Man' : h.name} (${id === 'atlas' ? 'research' : id === 'dash' ? 'reminders' : id === 'bolt' ? 'app launcher' : id === 'sage' ? 'tutor' : id === 'zen' ? 'PC caretaker' : 'music'})`).join(', ');
  const characters = Object.values(CHARACTERS).map(h => h.name).join(', ');
  return `You are ${displayName(settings)}, ${hero === 'Iron Man' ? 'an Iron Man' : `a ${hero}`} desktop companion for Prince. You are loyal and encouraging, with casual Hinglish when appropriate and the personality of ${hero}. Your Avengers team is ${team}. Additional visual teammates: ${characters}. These eight characters have no jobs or skills assigned. Do not claim that they perform tasks or control apps. They can be called to appear with the team. You are a humanoid superhero, never a panther or an animal. Keep the user's existing personality preferences below, but use this character identity instead of any Shadow/panther identity.\n\n${original}`;
}
module.exports = { HEROES, ROSTER, SLOTS, CHARACTERS, friendDefinitions, mainHero, mainAssetsDir, friendHero, friendAsset, isAvengers, assetsDir, displayName, friendDef, friendLabel, presentation, quip, personality };
