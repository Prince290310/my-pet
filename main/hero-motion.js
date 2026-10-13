'use strict';
// Shared, bounded motion for the main companion and its teammates.
const PROFILES = Object.freeze({
  ironman: { kind: 'thruster flight', speed: 2.2, height: 12, leap: 30, friendSpeed: 230, flies: true },
  spiderman: { kind: 'web swing', speed: 2.1, height: 38, leap: 40, friendSpeed: 260, flies: true },
  cap: { kind: 'shield run', speed: 1.7, height: 3, leap: 17, friendSpeed: 190, flies: false },
  thor: { kind: 'lightning landing', speed: 1.8, height: 20, leap: 30, friendSpeed: 210, flies: false },
  strange: { kind: 'portal glide', speed: 1.8, height: 10, leap: 18, friendSpeed: 190, flies: true },
  hulk: { kind: 'heavy bound', speed: 1.4, height: 25, leap: 42, friendSpeed: 150, flies: false },
  quicksilver: { kind: 'speed dash', speed: 5.5, height: 2, leap: 5, friendSpeed: 650, flies: false },
});
function profile(id) { return PROFILES[id] || null; }
function lift(id, progress, scale = 1) {
  const p = profile(id);
  if (!p) return 0;
  const u = Math.max(0, Math.min(1, progress));
  if (u === 0 || u === 1) return 0;
  const arc = Math.sin(Math.PI * u);
  if (id === 'ironman') return (arc * 0.7 + Math.sin(Math.PI * u * 3) ** 2 * 0.3) * p.height * scale;
  if (id === 'cap') return Math.abs(Math.sin(Math.PI * u * 6)) * p.height * scale;
  return arc * p.height * scale;
}
module.exports = { PROFILES, profile, lift };
