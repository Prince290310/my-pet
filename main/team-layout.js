'use strict';

// Fit a large team into rows, leaving the main companion's rectangle clear.
function teamSlots(area, leader, count, size, gap) {
  const columns = Math.max(1, Math.floor((area.width + gap) / (size + gap)));
  const width = columns * size + (columns - 1) * gap;
  const start = area.x + Math.max(0, (area.width - width) / 2);
  const positions = [];
  for (let row = 0; positions.length < count; row++) {
    const y = area.y + area.height - size - row * (size + gap);
    if (y < area.y) break;
    const line = [];
    for (let col = 0; col < columns; col++) {
      const x = start + col * (size + gap);
      const overlaps = x < leader.x + leader.size + gap && x + size + gap > leader.x && y < leader.y + leader.size + gap && y + size + gap > leader.y;
      if (!overlaps) line.push({ x: Math.round(x), y: Math.round(y) });
    }
    line.sort((a, b) => Math.abs(a.x + size / 2 - leader.x - leader.size / 2) - Math.abs(b.x + size / 2 - leader.x - leader.size / 2) || a.x - b.x);
    positions.push(...line);
  }
  return positions.slice(0, count);
}

module.exports = { teamSlots };
