'use strict';
// "Catch the treat": draws the falling treats main.js/games.js sends ~30x a second. This window is
// see-through and ignores the mouse completely - clicks go to whatever is underneath.

const canvas = document.getElementById('layer');
const ctx = canvas.getContext('2d');
const score = document.getElementById('score');
const left = document.getElementById('left');
let last = null;

function resize() {
  canvas.width = Math.round(window.innerWidth * devicePixelRatio);
  canvas.height = Math.round(window.innerHeight * devicePixelRatio);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
}
window.addEventListener('resize', resize);
resize();

function draw(s) {
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '34px "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", sans-serif';
  for (const t of s.treats) ctx.fillText(t.emoji, t.x, t.y);
  ctx.font = 'bold 22px "Segoe UI", sans-serif';
  for (const p of s.pops) {
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#150f22';
    ctx.strokeText(p.text, p.x, p.y);
    ctx.fillStyle = p.bad ? '#ff6b6b' : '#ffe066';
    ctx.fillText(p.text, p.x, p.y);
  }
  score.textContent = s.score;
  left.textContent = s.left;
}

window.game.onState((s) => {
  last = s;
  draw(s);
});

// self-test peeks at what is drawn
window.__gameTest = { last: () => last };
