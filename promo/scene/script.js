// 演示脚本：时间轴 / 字幕 / 端子内容 / 旋律
// ---------------------------------------------------------------
// 这里只有一个真相来源：3D 动作、DOM 叠加层、音频合成都从这份数据
// 推导（capture.mjs 会把音符表导出成 render/events.json 给音频用）。

export const DURATION = 37.0;

/** 固件 fx.c 里的旋律，原样搬运（RTTTL） */
export const MELODIES = {
  boot: 'boot:d=16,o=5,b=300:c,e,g,c6,e6,g6',
  confirm: 'confirm:d=8,o=6,b=300:b5,4e6',
  done: 'done:d=16,o=5,b=280:c6,e6,g6,8c7',

  error: 'error:d=4,o=4,b=240:g4,4c#4',
  muted_on: 'muteon:d=8,o=6,b=250:e6,4e6',
  muted_off: 'muteoff:d=8,o=6,b=250:4e6,e6',
  disconnect: 'offline:d=4,o=4,b=200:c4',
};

/* ---------------- RTTTL 解析（对应 firmware/main/fx.c） ----------------
 * 返回 [{ t, dur, f }]，t/dur 单位秒，f 单位 Hz（0 = 休止）。
 * 固件每两个音符之间有 15 ms 断句间隔，这里保留。 */
const SEMITONE = { a: 9, b: 11, c: 0, d: 2, e: 4, f: 5, g: 7 };
const GAP = 0.015;

export function parseRtttl(rtttl, start = 0) {
  const [, header, body] = rtttl.split(':');
  const def = { d: 4, o: 5, b: 63 };
  for (const item of header.split(',')) {
    const [k, v] = item.split('=');
    if (k && v) def[k.trim()] = parseInt(v, 10);
  }
  const quarter = 60 / def.b;
  const notes = [];
  let t = start;
  for (const raw of body.split(',')) {
    const tok = raw.trim();
    if (!tok) continue;
    const m = /^(\d*)([a-gpA-GP])(#?)(\.?)(\d?)$/.exec(tok);
    if (!m) continue;
    const dur = m[1] ? parseInt(m[1], 10) : def.d;
    const letter = m[2].toLowerCase();
    const sharp = m[3] === '#';
    const dotted = m[4] === '.';
    const oct = m[5] ? parseInt(m[5], 10) : def.o;
    const secs = (quarter * 4) / dur * (dotted ? 1.5 : 1);
    const f = letter === 'p' ? 0
      : 440 * Math.pow(2, (SEMITONE[letter] + (sharp ? 1 : 0) + (oct - 4) * 12) / 12);
    notes.push({ t, dur: secs, f });
    t += secs + GAP;
  }
  return notes;
}

/* ---------------- 固件状态机时间轴 ---------------- */
// 与 pi 扩展一致：连接 = idle；agent_start = busy；settled = done/error
export const STATES = [
  { t: 5.05, st: 'idle' },   // BLE 连接成功（固件在通道激活时补推 idle）
  { t: 8.60, st: 'busy' },   // agent_start
  { t: 20.60, st: 'done' },  // 第一轮结束
  { t: 23.80, st: 'busy' },  // 收到「不对」后继续跑
  { t: 30.20, st: 'error' }, // 中断（演示里用红灯表示 abort）
  { t: 33.40, st: 'idle' },
];

// 按键物理动作：物理按下 → 抬起
export const PRESSES = [
  { id: 2, down: 14.15, up: 14.36 },
  { id: 3, down: 23.75, up: 23.96 },
  { id: 1, down: 27.00, up: 28.10, hold: true },  // 长按 800 ms → 静音
  { id: 1, down: 30.00, up: 30.22 },              // 短按 → abort
];

// 旋钮：每次 detent 一步（+1 = 顺时针）
export const ENCODER = [
  { t: 17.35, v: 1 }, { t: 17.55, v: 1 }, { t: 17.75, v: 1 },
  { t: 18.35, v: -1 },
];

export const MUTE = [{ t: 27.80, on: true }];

// 蜂鸣器播放（同时驱动 3D 声波涟漪）
export const SOUNDS = [
  { t: 0.60, name: 'boot' },
  { t: 5.05, name: 'confirm' },
  { t: 14.15, name: 'confirm' },
  { t: 20.60, name: 'done' },
  { t: 23.75, name: 'confirm' },
  { t: 30.00, name: 'error' },
  { t: 27.80, name: 'muted_on' },
];

/* ---------------- 字幕（中英对照） ---------------- */
export const CAPTIONS = [
  { t0: 1.00, t1: 5.00, zh: '一台给 pi 用的<b>桌面控制器</b>', en: 'a <b>desktop controller</b> for the pi coding agent' },
  { t0: 5.05, t1: 8.55, zh: '蓝牙自动连接 · 设备灯进入 <b>idle</b> 蓝色', en: 'auto-connects over BLE — LED settles to <b>idle blue</b>' },
  { t0: 8.60, t1: 14.10, zh: '任务运行中：<b>绿灯呼吸</b>，不用切窗口看进度', en: 'while the agent runs the LED <b>breathes green</b>' },
  { t0: 14.15, t1: 17.30, zh: 'KEY2 短按 → 发送宏「<b>继续</b>」', en: 'short press <b>KEY2</b> → sends the macro <b>继续</b>' },
  { t0: 17.35, t1: 20.55, zh: '转旋钮 → 上下<b>滚动</b> pi 输出，转速快时半页步进', en: 'turn the knob to <b>scroll</b> the transcript' },
  { t0: 20.60, t1: 23.70, zh: '完成：<b>白光双闪</b>，抬头就知道跑完了', en: 'done → <b>double white flash</b>' },
  { t0: 23.75, t1: 26.95, zh: 'KEY3 短按 → 宏「<b>不对</b>」，以 steer 送进当前任务', en: 'short press <b>KEY3</b> → steers 不对 into the running task' },
  { t0: 27.00, t1: 29.90, zh: '长按 KEY1 0.8 s → <b>静音</b>蜂鸣器，设置写进 NVS', en: 'hold <b>KEY1</b> 0.8 s → mutes the buzzer, persisted in NVS' },
  { t0: 30.00, t1: 33.35, zh: '短按 KEY1 → <b>中断</b>当前任务，红灯三连闪', en: 'short press <b>KEY1</b> → <b>aborts</b> the run, triple red flash' },
];

/* ---------------- 端子面板内容 ---------------- */
// kind: sys | user | md | tool | ok | err
export const TRANSCRIPT = [
  { t: 5.30, kind: 'sys', text: 'BLE 已连接 · AgentDock-A1B2 · 无配对' },
  { t: 5.75, kind: 'user', text: '把 README 的键位表挪进 Controls 一节', tag: 'you' },
  { t: 6.25, kind: 'md', text: '先看一下现在的结构…' },
  { t: 6.95, kind: 'tool', text: 'read  <span class="f">README.md</span> · 312 行' },
  { t: 7.55, kind: 'tool', text: 'grep  <span class="f">"## Controls"</span> · 1 处' },
  { t: 8.10, kind: 'tool', text: 'edit  <span class="f">README.md</span> +26 −7' },
  { t: 8.95, kind: 'md', text: '键位表已合并进 Controls；接下来把旋钮的三档加速滚动写清楚。', stream: 3.4 },
  { t: 12.60, kind: 'tool', text: 'edit  <span class="f">README.md</span> +12 −0' },
  { t: 13.40, kind: 'md', text: '还差一张 /dock 面板的说明，我继续补。', stream: 1.2 },
  { t: 14.20, kind: 'user', text: '继续', tag: 'KEY2' },
  { t: 14.70, kind: 'md', text: '收到，先把面板各字段列成表格。', stream: 1.0 },
  { t: 15.90, kind: 'tool', text: 'edit  <span class="f">README.md</span> +9 −2' },
  { t: 16.70, kind: 'tool', text: 'run   <span class="f">npm run typecheck</span> · ok' },
  { t: 18.60, kind: 'md', text: '表格补完了，顺手把旋钮段落重排。', stream: 1.4 },
  { t: 20.70, kind: 'ok', text: '✓ 完成 · 18.6 s · 3 处修改' },
  { t: 23.80, kind: 'user', text: '不对', tag: 'KEY3' },
  { t: 24.20, kind: 'md', text: '这版表格丢了示例，我改回去。', stream: 1.1 },
  { t: 25.10, kind: 'tool', text: 'edit  <span class="f">README.md</span> −9' },
  { t: 27.85, kind: 'sys', text: '蜂鸣器静音 · 已写入 NVS' },
  { t: 28.70, kind: 'md', text: '重新整理中…' },
  { t: 30.05, kind: 'err', text: '■ 已中断 · aborted by KEY1' },
];
