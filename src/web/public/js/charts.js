'use strict';
/* Small SVG charts for the journal: an equity curve with hover, horizontal PnL bars, an hour heatmap. */
window.Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

  /**
   * points: [{ v, label }] running PnL. Draws the line from $0, the area split green above zero and red
   * below, and a hover cursor with the value.
   */
  function equity(host, points, { height = 220, money = (v) => v } = {}) {
    host.innerHTML = '';
    host.classList.add('chart');
    if (!points.length) { host.innerHTML = '<div class="empty"><span class="em">No trades yet</span><span>The curve starts with your first trade.</span></div>'; return; }
    const W = Math.max(320, host.clientWidth || 600), H = height, pad = { l: 6, r: 6, t: 14, b: 14 };
    const vals = [0, ...points.map((p) => p.v)], lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), rng = hi - lo || 1;
    const X = (i) => pad.l + (i * (W - pad.l - pad.r)) / Math.max(1, vals.length - 1), Y = (v) => pad.t + (1 - (v - lo) / rng) * (H - pad.t - pad.b);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, height: H, preserveAspectRatio: 'none' });
    const last = vals[vals.length - 1], color = last >= 0 ? 'var(--win)' : 'var(--loss)';
    // a smooth line through the points (the same bezier the daily card uses: no overshoot past a neighbour)
    const line = vals.map((v, i) => {
      if (!i) return `M${X(0).toFixed(1)} ${Y(v).toFixed(1)}`;
      const mx = ((X(i - 1) + X(i)) / 2).toFixed(1);
      return `C${mx} ${Y(vals[i - 1]).toFixed(1)} ${mx} ${Y(v).toFixed(1)} ${X(i).toFixed(1)} ${Y(v).toFixed(1)}`;
    }).join(' ');
    const z = Y(0);
    const defs = el('defs');
    const up = el('clipPath', { id: `up${host.id}` }); up.appendChild(el('rect', { x: 0, y: 0, width: W, height: z }));
    const dn = el('clipPath', { id: `dn${host.id}` }); dn.appendChild(el('rect', { x: 0, y: z, width: W, height: H - z }));
    defs.append(up, dn); svg.appendChild(defs);
    const area = `${line} L${X(vals.length - 1)} ${z} L${X(0)} ${z} Z`;
    svg.appendChild(el('path', { d: area, class: 'ar', fill: 'rgba(60,207,122,.1)', 'clip-path': `url(#up${host.id})` }));
    svg.appendChild(el('path', { d: area, class: 'ar', fill: 'rgba(248,113,113,.1)', 'clip-path': `url(#dn${host.id})` }));
    svg.appendChild(el('line', { x1: 0, x2: W, y1: z, y2: z, class: 'zero' }));
    const path = el('path', { d: line, class: 'ln', stroke: color });
    svg.appendChild(path);
    const cur = el('line', { y1: pad.t, y2: H - pad.b, class: 'cursor', opacity: 0 }), dot = el('circle', { r: 5, fill: 'var(--panel)', stroke: color, 'stroke-width': 2.5, opacity: 0 });
    svg.append(cur, dot);
    host.appendChild(svg);
    // the line draws itself in: measured once it is on the page, then the dash slides to zero
    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len}`; path.style.strokeDashoffset = `${len}`;
    requestAnimationFrame(() => requestAnimationFrame(() => { path.style.transition = 'stroke-dashoffset 1.6s cubic-bezier(.22,.8,.2,1)'; path.style.strokeDashoffset = '0'; }));
    const tip = document.createElement('div'); tip.className = 'tip'; host.appendChild(tip);
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * W;
      const i = Math.max(1, Math.min(vals.length - 1, Math.round(((x - pad.l) / (W - pad.l - pad.r)) * (vals.length - 1))));
      const px = X(i), py = Y(vals[i]);
      cur.setAttribute('x1', px); cur.setAttribute('x2', px); cur.setAttribute('opacity', 1);
      dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('opacity', 1);
      const p = points[i - 1];
      tip.innerHTML = `<b>${money(vals[i])}</b><br><span class="muted">${p.label || ''}</span>`;
      tip.style.left = `${(px / W) * 100}%`; tip.style.top = `${(py / H) * 100}%`; tip.classList.add('on');
    });
    svg.addEventListener('pointerleave', () => { cur.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); tip.classList.remove('on'); });
  }

  /** rows: [{ key, pnl, n, winRate }]: a bar per row from the centre, green right, red left */
  function bars(host, rows, { money = (v) => v, label = (r) => r.key, meta = (r) => `${r.n} · ${r.winRate ?? '—'}%` } = {}) {
    if (!rows.length) { host.innerHTML = '<div class="empty"><span>Nothing here yet.</span></div>'; return; }
    const max = Math.max(1, ...rows.map((r) => Math.abs(r.pnl)));
    host.innerHTML = `<div class="bars">${rows.map((r, i) => {
      const w = (Math.abs(r.pnl) / max) * 50, pos = r.pnl >= 0;
      return `<div class="bar-row" title="${esc(meta(r))}"><span class="nm">${esc(String(label(r)))}</span><span class="tr"><i style="left:${pos ? 50 : 50 - w}%;width:${w}%;background:var(--${pos ? 'win' : 'loss'});animation-delay:${i * 40}ms"></i><i style="left:50%;width:1px;background:var(--line3)"></i></span><span class="vv ${pos ? 'win' : 'loss'}">${money(r.pnl)}</span></div>`;
    }).join('')}</div>`;
  }

  /** hours: [{ key: 0..23, n, pnl }]: 24 cells tinted by PnL */
  function hours(host, hrs, { money = (v) => v } = {}) {
    const max = Math.max(1, ...hrs.map((h) => Math.abs(h.pnl)));
    host.innerHTML = `<div class="heat">${hrs.map((h) => {
      const a = h.n ? 0.15 + 0.75 * (Math.abs(h.pnl) / max) : 0;
      const bg = h.n ? `rgba(${h.pnl >= 0 ? '60,207,122' : '248,113,113'},${a.toFixed(2)})` : 'var(--panel3)';
      return `<b style="background:${bg}" title="${String(h.key).padStart(2, '0')}:00 · ${h.n} trade${h.n === 1 ? '' : 's'} · ${esc(money(h.pnl))}"></b>`;
    }).join('')}</div><div class="heat-k"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span></div>`;
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  return { equity, bars, hours, esc };
})();
