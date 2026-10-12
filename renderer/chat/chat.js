'use strict';
// Mini chat panel. Every message goes to askPet() in main/ai.js via the main process.

const log = document.getElementById('log');
const form = document.getElementById('composer');
const input = document.getElementById('msg');
const send = document.getElementById('send');

function addMsg(who, text, sources = []) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.textContent = text;
  if (sources.length) {
    // web search sources - open in your browser
    const box = document.createElement('div');
    box.className = 'sources';
    for (const s of sources) {
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'source';
      a.textContent = `🔗 ${s.title}`;
      a.title = s.url;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        window.chat.openLink(s.url);
      });
      box.appendChild(a);
    }
    el.appendChild(box);
  }
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  addMsg('me', text);
  send.disabled = true;
  const typing = addMsg('pet typing', '...');
  try {
    const reply = await window.chat.ask(text);
    typing.remove();
    addMsg('pet', reply.text, reply.sources || []);
  } catch (err) {
    typing.remove();
    addMsg('pet', `Something went wrong: ${err.message}`);
  } finally {
    send.disabled = false;
    input.focus();
  }
});

// Sage buzzing in during a quiz race, and other lines that arrive on their own
window.chat.onPush((m) => m && m.text && addMsg('pet', m.text));

document.getElementById('close').addEventListener('click', () => window.chat.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.chat.close();
});

(async () => {
  const info = await window.chat.info();
  document.getElementById('name').textContent = info.petName.toUpperCase();
  document.getElementById('brain').textContent = info.ready ? `brain: ${info.provider.split(' - ')[0]}` : 'no brain yet · Settings → AI Brain';
  document.title = `Chat with ${info.petName}`;
  addMsg(
    'pet',
    info.ready
      ? `Hey Prince! ${info.petName} here. Kya scene hai? Ask me anything 😼 Try "remind me in 20 min to drink water", "maths exam on 20 nov chapters 1-8" or "catch the treat" for a break.`
      : `Hey Prince! For full chat I need a brain - Settings → AI Brain (free key, 2 minutes). Reminders and your to-do list already work: try "remind me at 6 pm to call Mom" or "todo: physics homework".`
  );
  input.focus();
})();
