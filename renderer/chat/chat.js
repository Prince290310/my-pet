'use strict';
// Mini chat panel. Every message goes to askPet() in main/ai.js via the main process.

const log = document.getElementById('log');
const form = document.getElementById('composer');
const input = document.getElementById('msg');
const send = document.getElementById('send');

function addMsg(who, text) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.textContent = text;
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
    addMsg('pet', reply);
  } catch (err) {
    typing.remove();
    addMsg('pet', `Something went wrong: ${err.message}`);
  } finally {
    send.disabled = false;
    input.focus();
  }
});

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
      ? `Hey Prince! ${info.petName} here. Kya scene hai? Ask me anything 😼 Try "remind me in 20 min to drink water" or "todo: physics homework".`
      : `Hey Prince! For full chat I need a brain - Settings → AI Brain (free key, 2 minutes). Reminders and your to-do list already work: try "remind me at 6 pm to call Mom" or "todo: physics homework".`
  );
  input.focus();
})();
