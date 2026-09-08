import { VoxelSet, BlockState } from '../voxel/voxels.js';
import { blockColor } from '../blocks/colors.js';

export interface HtmlOptions {
  title: string;
  /** Surrounding world blocks, drawn semi-transparent. */
  context?: VoxelSet;
}

interface Payload {
  title: string;
  palette: Array<{ name: string; color: [number, number, number, number] }>;
  voxels: number[][];
  context: number[][];
  bounds: { min: number[]; max: number[] };
  counts: Array<[string, number]>;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function renderHtml(set: VoxelSet, opts: HtmlOptions): string {
  const paletteIndex = new Map<string, number>();
  const palette: Payload['palette'] = [];
  const idx = (s: BlockState): number => {
    const k = s.toString();
    let i = paletteIndex.get(k);
    if (i === undefined) {
      i = palette.length;
      paletteIndex.set(k, i);
      const c = blockColor(s);
      palette.push({ name: k, color: [c.r, c.g, c.b, c.a] });
    }
    return i;
  };
  const voxels: number[][] = [];
  for (const [p, s] of set.entries()) if (!s.isAir) voxels.push([p[0], p[1], p[2], idx(s)]);
  const context: number[][] = [];
  if (opts.context) for (const [p, s] of opts.context.entries()) if (!s.isAir && !set.has(p[0], p[1], p[2])) context.push([p[0], p[1], p[2], idx(s)]);
  const b = set.bounds() ?? { min: [0, 0, 0], max: [0, 0, 0] };
  const payload: Payload = {
    title: opts.title,
    palette,
    voxels,
    context,
    bounds: { min: [...b.min], max: [...b.max] },
    counts: [...set.counts().entries()].filter(([k]) => !BlockState.parse(k).isAir).sort((a, c) => c[1] - a[1]),
  };
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>
  html, body { margin: 0; height: 100%; background: #1b1d22; color: #e8e8e8; font: 14px system-ui, sans-serif; }
  #bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 8px 12px; background: #262930; }
  #bar label { display: flex; gap: 6px; align-items: center; }
  #wrap { position: relative; height: calc(100% - 46px); }
  canvas { display: block; width: 100%; height: 100%; cursor: grab; }
  #legend { position: absolute; right: 8px; top: 8px; background: rgba(0,0,0,.55); padding: 8px 10px; border-radius: 6px; max-height: 60%; overflow: auto; font-size: 12px; }
  #legend div { display: flex; gap: 6px; align-items: center; margin: 2px 0; }
  #legend i { display: inline-block; width: 12px; height: 12px; border-radius: 2px; border: 1px solid rgba(255,255,255,.3); }
  #info { position: absolute; left: 8px; bottom: 8px; background: rgba(0,0,0,.55); padding: 6px 10px; border-radius: 6px; font-size: 12px; }
  button { background: #3a3f4b; color: #fff; border: 0; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
</style>
</head>
<body>
<div id="bar">
  <strong>${escapeHtml(opts.title)}</strong>
  <button id="rotate">Rotate 90°</button>
  <label>Zoom <input id="zoom" type="range" min="4" max="40" value="14"></label>
  <label>Show up to y <input id="layer" type="range"><span id="layerv"></span></label>
  <label><input id="context" type="checkbox" checked> Surroundings</label>
  <span id="view"></span>
</div>
<div id="wrap">
  <canvas id="c"></canvas>
  <div id="legend"></div>
  <div id="info"></div>
</div>
<script>
const DATA = ${json};
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const VIEWS = ['from south-east', 'from south-west', 'from north-west', 'from north-east'];
let view = 0, zoom = 14, showContext = true, panX = 0, panY = 0, dragging = null;
let minY = DATA.bounds.min[1], maxY = DATA.bounds.max[1];
for (const v of DATA.context) { minY = Math.min(minY, v[1]); }
const layer = document.getElementById('layer');
layer.min = String(DATA.bounds.min[1]); layer.max = String(DATA.bounds.max[1]); layer.value = String(DATA.bounds.max[1]);
document.getElementById('layerv').textContent = layer.value;
function rot(x, z) { for (let i = 0; i < view; i++) { const t = x; x = -z; z = t; } return [x, z]; }
function shade(c, f) { return 'rgb(' + Math.round(c[0] * f) + ',' + Math.round(c[1] * f) + ',' + Math.round(c[2] * f) + ')'; }
function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const W = zoom, H = zoom;
  const cap = Number(layer.value);
  const items = [];
  const solid = new Set();
  const push = (list, alpha) => {
    for (const [x, y, z, i] of list) {
      if (y > cap) continue;
      const [rx, rz] = rot(x, z);
      const c = DATA.palette[i];
      items.push({ x: rx, y, z: rz, c, alpha });
      if (alpha === 1 && c.color[3] === 1) solid.add(rx + ',' + y + ',' + rz);
    }
  };
  push(DATA.voxels, 1);
  if (showContext) push(DATA.context, 0.35);
  items.sort((a, b) => (a.x + a.z) - (b.x + b.z) || a.y - b.y);
  const P = (x, y, z) => [(x - z) * W, (x + z) * (W / 2) - y * H];
  let minX = Infinity, maxX = -Infinity, minPy = Infinity, maxPy = -Infinity;
  for (const it of items) for (const [px, py] of [P(it.x, it.y, it.z), P(it.x + 1, it.y + 1, it.z + 1), P(it.x + 1, it.y, it.z), P(it.x, it.y + 1, it.z + 1)]) {
    minX = Math.min(minX, px); maxX = Math.max(maxX, px); minPy = Math.min(minPy, py); maxPy = Math.max(maxPy, py);
  }
  const ox = w / 2 - (minX + maxX) / 2 + panX, oy = h / 2 - (minPy + maxPy) / 2 + panY;
  const poly = (pts, fill) => { ctx.beginPath(); ctx.moveTo(pts[0][0] + ox, pts[0][1] + oy); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + ox, pts[i][1] + oy); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); if (W >= 10) { ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.stroke(); } };
  for (const it of items) {
    const { x, y, z, c } = it;
    if (c.color[3] === 0) continue;
    const top = !solid.has(x + ',' + (y + 1) + ',' + z), right = !solid.has((x + 1) + ',' + y + ',' + z), left = !solid.has(x + ',' + y + ',' + (z + 1));
    if (!top && !right && !left) continue;
    ctx.globalAlpha = it.alpha * c.color[3];
    if (top) poly([P(x, y + 1, z), P(x + 1, y + 1, z), P(x + 1, y + 1, z + 1), P(x, y + 1, z + 1)], shade(c.color, 1));
    if (right) poly([P(x + 1, y, z), P(x + 1, y, z + 1), P(x + 1, y + 1, z + 1), P(x + 1, y + 1, z)], shade(c.color, 0.78));
    if (left) poly([P(x, y, z + 1), P(x + 1, y, z + 1), P(x + 1, y + 1, z + 1), P(x, y + 1, z + 1)], shade(c.color, 0.6));
  }
  ctx.globalAlpha = 1;
  document.getElementById('view').textContent = 'View ' + VIEWS[view] + ' · north is ' + ['up-left', 'up-right', 'down-right', 'down-left'][view];
  const b = DATA.bounds;
  document.getElementById('info').textContent = 'Bounds (' + b.min.join(', ') + ') to (' + b.max.join(', ') + ') · ' + DATA.voxels.length + ' blocks · drag to pan, wheel to zoom';
}
document.getElementById('legend').innerHTML = DATA.counts.map(([name, n]) => {
  const p = DATA.palette.find((e) => e.name === name);
  const c = p ? p.color : [128, 128, 128, 1];
  return '<div><i style="background:rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')"></i>' + name.replace('minecraft:', '') + ' × ' + n + '</div>';
}).join('');
document.getElementById('rotate').onclick = () => { view = (view + 1) % 4; draw(); };
document.getElementById('zoom').oninput = (e) => { zoom = Number(e.target.value); draw(); };
layer.oninput = () => { document.getElementById('layerv').textContent = layer.value; draw(); };
document.getElementById('context').onchange = (e) => { showContext = e.target.checked; draw(); };
canvas.addEventListener('mousedown', (e) => { dragging = [e.clientX - panX, e.clientY - panY]; });
window.addEventListener('mousemove', (e) => { if (dragging) { panX = e.clientX - dragging[0]; panY = e.clientY - dragging[1]; draw(); } });
window.addEventListener('mouseup', () => { dragging = null; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom = Math.max(4, Math.min(40, zoom + (e.deltaY < 0 ? 2 : -2))); document.getElementById('zoom').value = String(zoom); draw(); }, { passive: false });
window.addEventListener('resize', draw);
draw();
</script>
</body>
</html>
`;
}
