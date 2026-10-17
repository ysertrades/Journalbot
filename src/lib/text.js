'use strict';
/** All visible text of a message, including Components V2 TextDisplays (which have no `content`). */
function extractText(message) {
  if (!message) return '';
  const parts = [];
  if (message.content) parts.push(message.content);
  const walk = (n) => {
    if (!n) return;
    if (n.type === 10 && typeof n.content === 'string') parts.push(n.content);
    (n.components || []).forEach(walk);
  };
  for (const c of message.components || []) walk(typeof c.toJSON === 'function' ? c.toJSON() : c);
  return parts.join('\n');
}
/** Split into <=max chunks on line boundaries */
function chunkText(s, max = 1900) {
  const out = []; let cur = '';
  for (const line of String(s).split('\n')) {
    if ((cur + '\n' + line).length > max && cur) { out.push(cur); cur = line; } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}
module.exports = { extractText, chunkText };
