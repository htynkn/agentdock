# AgentDock 宣传片（promo）

用 three.js 渲染的 3D 产品短片：真实外壳 STL + 叠加 UI（pi 终端、引线标注、状态胶囊），
37 秒、中英双语，所有交互动作与 `firmware/main/fx.c`、`input.c` 的行为一一对应。

## 产物

```
out/agentdock-promo-1440p.mp4    2560×1440 · 30fps · h264 + AAC（母版）
out/agentdock-promo-1080p.mp4    1920×1080 · 30fps（分享用）
out/agentdock-promo-poster.png   1920×1080 海报帧
out/agentdock-promo.gif          480px / 10fps 预览
```

## 一条命令重出片

```bash
cd promo
npm install                      # three + playwright（首次）
./build.sh --capture             # 渲染 4K 帧序列 + 合成音轨 + 出片
./build.sh                       # 已有帧序列时，只重新编码
```

`--capture` 里两步都耗时：

| 步骤 | 命令 | 说明 |
|---|---|---|
| 帧序列 | `node capture.mjs --fps 30 --dpr 2 --out render/frames` | Playwright 逐帧调 `__renderAt(t)`，3840×2160 约 1.1 s/帧，1110 帧 ≈ 20 min |
| 音轨 | `uv run --with numpy python audio.py` | 读 `render/events.json`（按键/旋钮/旋律的绝对时间）合成 48 kHz 立体声 |

## 目录

```
prep_meshes.py    从 hardware/enclosure 的 CAD 导出 base/lid/pcb/keycap/knob STL
scene/
  index.html      1920×1080 画布 + UI 叠层（DOM，非 3D 文字）
  script.js       单一事实源：时间轴 DURATION、RTTTL 旋律、按键/旋钮/MUTE、字幕、终端逐行脚本
  main.js         three.js 场景：PBR 材质、LED 状态机（照抄 fx.c）、相机 SHOTS、bloom + 调色
  overlay.js      纯函数 update(t)：字幕、标注、终端滚动、状态胶囊
capture.mjs       Playwright 逐帧截图（--stills 可只出几张关键帧来预览）
serve.mjs         静态服务器（capture 内部起，也可单独 `node serve.mjs` 手看）
audio.py          numpy 合成音轨（蜂鸣器加法合成 / 按键 / 旋钮 detent / 环境铺底 / 卷积混响）
build.sh          出片脚本（音轨归一 + 1440p/1080p + 海报 + GIF）
```

## 关键约定（改片子时注意）

- **`renderAt(t)` 必须是 t 的纯函数**，否则逐帧截图的进度无法断点续渲。
- **时序都写在 `scene/script.js`**：改时间点只需改这里；`main.js` 的相机 `SHOTS`
  用绝对时间对齐这些事件，`audio.py` 则读 `capture.mjs` 导出的 `events.json`，
  所以**改完时间轴必须重跑 capture 才能让音画同步**。
- **LED 亮度按峰值通道归一**（`updateLED`），保持色相不过曝成白色，靠 bloom 出光晕。
- 外壳颜色（`lidMat` / `baseMat`）、灯光、bloom 强度都在 `main.js` 顶部；
  整体构图用 `CAM_ZOOM` 统一收缩，单镜头距离在 `SHOTS` 的 `d` 上微调。
