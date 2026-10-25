// DOM 叠加层：标题 / 状态胶囊 / 字幕 / 端子面板 / 引线标注 / 静音角标 / 图例
// 全部由 update(t) 驱动，保证逐帧捕获时画面是 t 的纯函数。
import * as S from './script.js';

const $ = (sel) => document.querySelector(sel);
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, u) => a + (b - a) * u;
const smooth = (u) => { u = clamp(u); return u * u * (3 - 2 * u); };
const easeOut = (u) => 1 - Math.pow(1 - clamp(u), 3);
/** 进入/退出包络：t0 起淡入 fade，t1 前淡出 */
const env = (t, t0, t1, fade = 0.35) =>
  Math.min(smooth((t - t0) / fade), 1 - smooth((t - (t1 - fade)) / fade));

let rows = [];
const el = {};

/* ---------------- 引线标注的锚点与文案 ---------------- */
// 8.35–9.95 这一段五个标注同时出现（控件巡览），单独给一套排版，避免互相压字
const OV = [8.35, 9.95];
const CALLOUTS = [
  { id: 'key1', anchor: 'key1', dx: -6, dy: -178, ov: [-42, -140], tag: 'KEY1 · press', zh: '中断当前任务', en: 'abort',
    win: [[8.35, 9.95], [27.0, 29.7], [30.0, 31.0]] },
  { id: 'key2', anchor: 'key2', dx: 0, dy: -214, ov: [30, -145], tag: 'KEY2 · press', zh: '发送宏「继续」', en: 'macro: continue',
    win: [[8.35, 9.95], [14.25, 17.1]] },
  { id: 'key3', anchor: 'key3', dx: 10, dy: -178, ov: [20, -130], tag: 'KEY3 · press', zh: '发送宏「不对」', en: 'macro: wrong',
    win: [[8.35, 9.95], [23.8, 26.6]] },
  { id: 'knob', anchor: 'knob', dx: -286, dy: -128, ov: [-175, -205], tag: 'encoder', zh: '滚动 / 按下确认', en: 'scroll · press',
    win: [[8.35, 9.95], [17.75, 20.1]] },
  { id: 'led', anchor: 'led', dx: -132, dy: -150, ov: [-60, -130], tag: 'WS2812', zh: '状态灯', en: 'agent state',
    win: [[8.35, 9.95], [20.6, 23.5]] },
];

/* ---------------- 胶囊文案 ---------------- */
const PILL = {
  offline: { zh: '未连接', en: 'offline', color: '#4a5875' },
  idle: { zh: '已连接', en: 'idle', color: '#6fd0ff' },
  busy: { zh: '运行中', en: 'busy', color: '#ff9552' },
  done: { zh: '完成', en: 'done', color: '#eaf2ff' },
  error: { zh: '已中断', en: 'aborted', color: '#ff6a5a' },
};
const CHIP = { offline: 'idle', idle: 'idle', busy: 'busy', done: '', error: 'err' };
const CHIP_TEXT = { offline: 'offline', idle: 'idle', busy: 'busy', done: 'done', error: 'aborted' };

export async function init() {
  el.title = $('#title');
  el.pill = $('#pill');
  el.pillLed = $('#pill .led');
  el.pillTxt = $('#pill .txt');
  el.pillEn = $('#pill .en');
  el.term = $('#term');
  el.scroll = $('#term .scroll');
  el.body = $('#term .body');
  el.chip = $('#term .chip');
  el.capZh = $('#caption .zh');
  el.capEn = $('#caption .en');
  el.caption = $('#caption');
  el.rings = $('#rings');
  el.mute = $('#mute');
  el.legend = $('#legend');
  el.outro = $('#outro');
  el.svg = $('#callouts svg');
  el.timecode = $('#term .foot .t');

  // 端子内容
  for (const item of S.TRANSCRIPT) {
    const row = document.createElement('div');
    row.className = `row ${item.kind}`;
    const tx = document.createElement('div');
    tx.className = 'tx';
    if (item.tag) tx.innerHTML = `<span class="k">${item.tag}</span>`;
    row.appendChild(tx);
    el.scroll.appendChild(row);
    const html = (item.tag ? `<span class="k">${item.tag}</span>` : '') + item.text;
    rows.push({ item, row, tx, html });
  }

  // 引线标注
  for (const c of CALLOUTS) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('r', '2.5');
    dot.setAttribute('class', 'anchor');
    g.append(line, dot);
    el.svg.appendChild(g);

    const label = document.createElement('div');
    label.className = 'callout';
    label.innerHTML = `<span class="k">${c.tag}</span>${c.zh}<span class="en">${c.en}</span>`;
    document.getElementById('callouts').appendChild(label);
    c._line = line; c._dot = dot; c._label = label; c._g = g;
  }

  // 连接波纹
  el.ringEls = [];
  for (let i = 0; i < 3; i++) {
    const r = document.createElement('div');
    r.className = 'ring';
    el.rings.appendChild(r);
    el.ringEls.push(r);
  }
  return true;
}

/* ---------------- 端子：逐行点亮 + 打字流 ---------------- */
let lastRowsKey = '';

function updateTerminal(t) {
  for (const r of rows) {
    const { item } = r;
    const on = t >= item.t;
    if (!on) {
      if (r.row.style.display !== 'none') { r.row.style.display = 'none'; r.tx.innerHTML = ''; }
      continue;
    }
    if (r.row.style.display === 'none') r.row.style.display = 'flex';

    const streaming = item.stream && t < item.t + item.stream;
    let text = r.html;
    if (streaming) {
      // 纯文本行才做打字流（含 HTML 的行不裁剪）
      const plain = r.html.replace(/<[^>]+>/g, '');
      const n = Math.floor(clamp((t - item.t) / item.stream) * plain.length);
      text = plain.slice(0, n);
    }
    const html = streaming ? `${text}<span class="caret"></span>` : text;
    if (r.tx._html !== html) { r.tx.innerHTML = html; r.tx._html = html; }
  }

  // 滚动：底部跟随 + 旋钮上翻（演示「回看」），随后回到底部
  const bodyH = el.body.clientHeight;
  const contentH = el.scroll.scrollHeight;
  const base = Math.max(0, contentH - bodyH + 22);

  let turned = 0;
  for (const e of S.ENCODER) {
    if (t < e.t) continue;
    turned += e.v * 46 * easeOut((t - e.t) / 0.16);
  }
  const decay = 1 - smooth((t - 19.55) / 1.0);
  turned *= decay;
  const maxOffset = Math.max(0, contentH - bodyH);
  const offset = clamp(base - turned, 0, Math.max(0, maxOffset));

  el.scroll.style.transform = `translateY(${-offset}px)`;
  const scrollActive = turned > 1;
  el.scroll.parentElement.style.setProperty('--sb', scrollActive ? '1' : '0');
}

/* ---------------- 主更新 ---------------- */
export function update(t, ctx) {
  const { anchors, state, deviceCenter } = ctx;
  const st = state;

  /* 标题 */
  const titleOn = env(t, 0.95, 33.2, 0.7);
  el.title.style.opacity = titleOn.toFixed(3);
  el.title.style.transform = `translateY(${(1 - smooth((t - 0.95) / 0.8)) * 10}px)`;

  /* 状态胶囊 */
  const pillOn = env(t, 4.0, 33.2, 0.5);
  el.pill.style.opacity = pillOn.toFixed(3);
  const p = PILL[t >= 5.05 ? st : 'offline'];
  el.pillTxt.textContent = p.zh;
  el.pillEn.textContent = p.en;
  el.pillLed.style.background = p.color;
  el.pillLed.style.boxShadow = `0 0 12px 2px ${p.color}88`;
  el.pill.style.transform = `translateY(${(1 - smooth((t - 4.0) / 0.6)) * -8}px)`;

  /* 端子面板 */
  const termOn = env(t, 5.0, 33.2, 0.55);
  el.term.style.opacity = termOn.toFixed(3);
  el.term.style.transform =
    `translateX(${(1 - smooth((t - 5.0) / 0.75)) * 26}px) translateY(${(1 - smooth((t - 5.0) / 0.75)) * 10}px)`;
  if (t >= 5.0) updateTerminal(t);

  el.chip.className = `chip ${CHIP[st]}`;
  el.chip.textContent = t >= 5.05 ? CHIP_TEXT[st] : 'waiting';
  el.timecode.textContent = '';

  /* 字幕 */
  const cap = S.CAPTIONS.find((c) => t >= c.t0 && t <= c.t1);
  if (cap) {
    el.capZh.innerHTML = cap.zh;
    el.capEn.innerHTML = cap.en;
    const a = Math.min(smooth((t - cap.t0) / 0.3), 1 - smooth((t - (cap.t1 - 0.3)) / 0.3));
    el.caption.style.opacity = clamp(a).toFixed(3);
    el.caption.style.transform = `translateY(${(1 - smooth((t - cap.t0) / 0.45)) * 12}px)`;
  } else {
    el.caption.style.opacity = '0';
  }

  /* 引线标注：先算位置，再做一次屏幕空间避让（俯视全景时四个标注会挤在一起） */
  const live = [];
  for (const c of CALLOUTS) {
    const a = anchors[c.anchor];
    if (!a) continue;
    const on = c.win.reduce((m, [t0, t1]) =>
      Math.max(m, Math.min(smooth((t - t0) / 0.45), 1 - smooth((t - (t1 - 0.45)) / 0.45))), 0);
    const ovOn = c.ov && t >= OV[0] && t <= OV[1];
    live.push({ c, a, on, lx: a.x + (ovOn ? c.ov[0] : c.dx), ly: a.y + (ovOn ? c.ov[1] : c.dy) });
  }
  // 按 x 排序后逐个上推，直到和已落位的标注既不重叠（卡片 200×64）
  live.sort((p, q) => p.lx - q.lx);
  for (let i = 0; i < live.length; i++) {
    const b = live[i];
    if (b.on < 0.01) continue;
    for (let j = 0; j < i; j++) {
      const a2 = live[j];
      if (a2.on < 0.01) continue;
      if (Math.abs(a2.lx - b.lx) < 200 && Math.abs(a2.ly - b.ly) < 70) {
        // 上方还有空间就上移一行，否则下移（避免被顶端钳位后再次重叠）
        b.ly = b.ly - 74 >= 205 ? a2.ly - 74 : a2.ly + 74;
      }
    }
    b.ly = Math.max(b.ly, 205);         // 别顶到左上角标题/副标题
  }
  for (const { c, a, on, lx, ly } of live) {
    c._label.style.opacity = on.toFixed(3);
    c._label.style.left = `${lx}px`;
    c._label.style.top = `${ly}px`;
    c._label.style.transform = `translate(-50%, -50%) translateY(${(1 - on) * 8}px)`;
    c._label.style.display = on < 0.002 ? 'none' : 'block';

    c._line.setAttribute('x1', a.x); c._line.setAttribute('y1', a.y);
    c._line.setAttribute('x2', lx); c._line.setAttribute('y2', ly - 30);
    c._dot.setAttribute('cx', a.x); c._dot.setAttribute('cy', a.y);
    const o = on * 0.75;
    c._line.style.opacity = o;
    c._dot.style.opacity = o;
  }

  /* BLE 连接波纹 */
  for (let i = 0; i < el.ringEls.length; i++) {
    const r = el.ringEls[i];
    const d0 = 5.02 + i * 0.42;
    const u = (t - d0) / 1.9;
    if (u < 0 || u > 1) { r.style.opacity = 0; continue; }
    const s = 60 + 620 * easeOut(u);
    r.style.left = `${deviceCenter.x}px`;
    r.style.top = `${deviceCenter.y}px`;
    r.style.width = `${s}px`;
    r.style.height = `${s * 0.62}px`;
    r.style.opacity = (Math.sin(Math.PI * clamp(u)) * 0.8).toFixed(3);
  }

  /* 静音角标 */
  const muteOn = S.MUTE[0]
    ? Math.min(smooth((t - S.MUTE[0].t) / 0.4), 1 - smooth((t - 29.9) / 0.45)) : 0;
  el.mute.style.opacity = muteOn.toFixed(3);
  el.mute.style.left = `${deviceCenter.x + 128}px`;
  el.mute.style.top = `${deviceCenter.y - 128}px`;
  el.mute.style.transform = `translate(-50%, -50%) scale(${lerp(0.86, 1, easeOut(muteOn))})`;

  /* 结尾图例 / repo */
  const legendOn = smooth((t - 33.55) / 0.6);
  el.legend.style.opacity = legendOn.toFixed(3);
  el.legend.style.transform = `translateX(-50%) translateY(${(1 - legendOn) * 16}px)`;
  const outroOn = smooth((t - 33.75) / 0.6);
  el.outro.style.opacity = outroOn.toFixed(3);
  el.outro.style.transform = `translateY(${(1 - outroOn) * 10}px)`;
}
