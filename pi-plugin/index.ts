/*
 * 智坞 AgentDock ↔ pi coding agent 扩展 (入口)
 *
 * 结构:
 *   index.ts  — pi 集成: 生命周期 / 状态机 / /dock 命令 / 动作分发
 *   ble.ts    — BLE 通道 (扫描/连接/订阅/重连)
 *   panel.ts  — /dock 可视化管理面板
 *   config.ts — 配置持久化 (~/.pi/agent/agentdock.json)
 *
 * 加载: pi --extension <本目录>/index.ts
 * 使用: pi 内输入 /dock 打开管理面板 (设备选择/宏配置/声音/灯效测试)
 *
 * 状态机要点 (v0.4):
 *   - 设备负责「瞬态灯效 + 之后回到哪」: 发 {"t":"s","st":"done","then":"idle"},
 *     设备闪完自动回 then。插件不再用定时器抢状态, 也就不会出现
 *     「红灯闪一下又跳成别的颜色」。
 *   - error 去抖: 单次/两次工具报错是 agent 的正常试错, 不亮红灯。连续
 *     ERROR_STREAK_THRESHOLD 次以上、且经过 ERROR_HOLD_MS 观察窗仍未恢复,
 *     才提示一次; 任意一次成功立刻清零并取消待报的 error。
 *   - 需要人处理 (ui_prompt_start → ask_user_question / 选择框等) 是独立状态:
 *     琥珀双脉冲灯 + 专门提示音, 并在无人响应时按 ATTENTION_REMIND_MS 重提醒,
 *     最多 ATTENTION_REMIND_TIMES 次。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DeckChannel } from "./ble.js";
import {
  clampPct,
  loadConfig,
  saveConfig,
  soundVolumes,
  type DeckConfig,
  type SoundVolumes,
} from "./config.js";
import { showPanel, type PanelAction } from "./panel.js";
import { DeckScroller } from "./scroll.js";

/** 连续出错多少次才值得亮红灯 (1~2 次是正常试错, agent 自己会缓过来) */
const ERROR_STREAK_THRESHOLD = 3;
/** 达到阈值后再等这么久, 期间有成功就作废 (避免「刚亮红就恢复」的闪烁) */
const ERROR_HOLD_MS = 2500;
/** 需要人处理时: 首次立刻提醒, 之后每 20s 补一次, 共 3 次 */
const ATTENTION_REMIND_MS = 20000;
const ATTENTION_REMIND_TIMES = 3;
/** 断线重连间隔 */
const RECONNECT_MS = 5000;

type AgentOutcome = "completed" | "aborted" | "error";

export default function agentDeckExtension(pi: ExtensionAPI) {
  const config: DeckConfig = loadConfig();

  /* TUI 模式下裸写 stderr 会破坏界面渲染 — 仅 RPC/CLI 等非交互模式输出日志,
   * TUI 中重要事件经 setStatus / notify 呈现 */
  let tuiMode = false;
  const log = (...args: unknown[]) => {
    if (!tuiMode) console.error("[agentdock]", ...args);
  };

  const channel = new DeckChannel(
    (msg) => handleDeviceEvent(msg),
    (connected) => onConnectionChanged(connected),
    log,
  );

  const scroller = new DeckScroller();
  let disposed = false;
  let panelOpen = false;         // /dock 面板重入保护 (模态循环只允许一份)
  /* 设备侧设置缓存 (来自连接时的 cfg 快照, 面板显示用; 设备 NVS 是真源) */
  let deviceMuted = config.muted;
  let deviceSounds: SoundVolumes = soundVolumes(config);
  let reconnectTimer: NodeJS.Timeout | null = null;
  let lastCtx: ExtensionContext | null = null;

  /* ---------- agent 状态机 ---------- */
  let busy = false;
  /** 本轮连续工具报错次数 (任意一次成功即清零) */
  let errorStreak = 0;
  /** 本轮是否已经亮过红灯 (恢复前不重复提示) */
  let errorReported = false;
  let errorTimer: NodeJS.Timeout | null = null;
  /** agent 正在等人操作 (ui_prompt_start...ui_prompt_end) */
  let attentionOpen = false;
  let attentionTimers: NodeJS.Timeout[] = [];
  /** 最近一次 agent 循环的结束原因 (由 agent_end 记录, agent_settled 消费) */
  let lastOutcome: AgentOutcome | undefined;

  /* 同键去重: 连接层理论上有监听器叠加风险（ble.ts 已修复），
   * 这里再兜底过滤 300ms 内的重复同键事件，避免一次按压触发多条消息 */
  const DEDUP_MS = 300;
  let lastKey: { id: number; at: number } | null = null;

  /* ---------- 设备 → pi ---------- */
  function handleDeviceEvent(msg: any): void {
    if (msg.k === "key") {
      const now = Date.now();
      if (lastKey && lastKey.id === msg.id && now - lastKey.at < DEDUP_MS) {
        log(`重复事件已忽略: KEY${msg.id} (${now - lastKey.at}ms 内)`);
        return;
      }
      lastKey = { id: msg.id, at: now };
      switch (msg.id) {
        case 1: { // KEY1: 打断
          log("设备请求: 打断");
          if (!lastCtx) return;
          if (lastCtx.isIdle()) {
            if (tuiMode) lastCtx.ui.notify("AgentDock: agent 空闲, 无需打断");
            return;
          }
          lastCtx.abort();
          break;
        }
        case 2: { // KEY2: 宏
          const text = config.macros[msg.idx ?? 0] ?? config.macros[0];
          if (!text) return void log(`宏[${msg.idx}] 未配置`);
          log(`设备请求: 宏 → ${text}`);
          void pi.sendUserMessage(text, busy ? { deliverAs: "steer" } : {});
          break;
        }
        case 3: { // KEY3: 宏 2
          const text = config.macros[1] ?? config.macros[0];
          log(`设备请求: 宏2 → ${text}`);
          void pi.sendUserMessage(text, busy ? { deliverAs: "steer" } : {});
          break;
        }
        case 4: // 旋钮按压: 固定"继续" (轻推语义)
          log("设备请求: 继续");
          void pi.sendUserMessage("继续", busy ? { deliverAs: "steer" } : {});
          break;
        default:
          log("未知按键 id:", msg.id);
      }
    } else if (msg.k === "cfg") {
      /* 设备上报的真实设置 (连接后立即推一次, KEY1 长按静音后也会推)
       * → 同步本地缓存供面板显示。设备 NVS 是唯一真源, 这里只跟随. */
      const brightness = clampPct(msg.b, config.brightness);
      const incoming = Array.isArray(msg.s) ? msg.s : null;
      const sounds: SoundVolumes =
        incoming && incoming.length >= 3
          ? [
              clampPct(incoming[0], config.keyVolume),
              clampPct(incoming[1], config.knobVolume),
              clampPct(incoming[2], config.agentVolume),
            ]
          : soundVolumes(config);
      const muted = typeof msg.m === "number" ? msg.m !== 0 : deviceMuted;
      const changed =
        brightness !== config.brightness ||
        sounds[0] !== config.keyVolume ||
        sounds[1] !== config.knobVolume ||
        sounds[2] !== config.agentVolume ||
        muted !== config.muted;
      if (changed) {
        config.brightness = brightness;
        config.keyVolume = sounds[0];
        config.knobVolume = sounds[1];
        config.agentVolume = sounds[2];
        config.muted = muted;
        saveConfig(config);
      }
      deviceMuted = muted;
      deviceSounds = sounds;
      log(
        `设备设置: 亮度 ${brightness}% · 按键 ${sounds[0]}% · 旋钮 ${sounds[1]}%` +
          ` · agent ${sounds[2]}%${muted ? " · 总静音" : ""}`,
      );
    } else if (msg.k === "enc") {
      const ok = scroller.scrollByInput(Number(msg.v) || 0, log);
      if (!ok) log(`旋钮滚动 ${msg.v} (TUI 滚动不可用, 需 fullscreen 模式)`);
    } else {
      log("未知事件:", JSON.stringify(msg));
    }
  }

  /* ---------- pi → 设备 (LED 状态机 + 提示音) ---------- */
  const baseState = (): string => (busy ? "busy" : "idle");

  /** 推持久状态; then = 瞬态灯效 (done/error/demo) 播完后回到哪 (交给设备处理) */
  function pushState(state: string, then?: string): void {
    void channel.writeState(state, then);
  }

  function clearErrorTimer(): void {
    if (errorTimer) {
      clearTimeout(errorTimer);
      errorTimer = null;
    }
  }

  function clearAttentionReminders(): void {
    for (const t of attentionTimers) clearTimeout(t);
    attentionTimers = [];
  }

  /** 无人响应时补提醒: 重发 attention, 设备会重播提示音 (灯效状态不变) */
  function scheduleAttentionReminders(): void {
    clearAttentionReminders();
    for (let i = 1; i < ATTENTION_REMIND_TIMES; i++) {
      attentionTimers.push(
        setTimeout(() => {
          if (!attentionOpen) return;
          log("需要人处理, 再次提醒");
          pushState("attention");
        }, i * ATTENTION_REMIND_MS),
      );
    }
  }

  /** 从 agent_end 的消息里判断本次循环怎么结束的 (error / aborted / completed) */
  function outcomeOfMessages(messages: unknown): AgentOutcome {
    if (!Array.isArray(messages)) return "completed";
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as any;
      if (m?.role !== "assistant") continue;
      if (m.stopReason === "error") return "error";
      if (m.stopReason === "aborted") return "aborted";
      return "completed";
    }
    return "completed";
  }

  function onConnectionChanged(connected: boolean): void {
    updateStatusLine();
    if (connected) {
      /* 设备刚连上会先把自己置为 idle, 这里补推当前真实状态 */
      pushState(attentionOpen ? "attention" : baseState());
    }
  }

  function updateStatusLine(): void {
    lastCtx?.ui.setStatus(
      "agentdock",
      channel.connected ? `🎮 ${channel.deviceName}` : "🎮 AgentDock 未连接",
    );
  }

  pi.on("agent_start", (_e, ctx) => {
    lastCtx = ctx;
    busy = true;
    errorStreak = 0;
    errorReported = false;
    lastOutcome = undefined;
    clearErrorTimer();
    if (!attentionOpen) pushState("busy");
  });

  pi.on("agent_end", (event, ctx) => {
    lastCtx = ctx;
    lastOutcome = outcomeOfMessages(event.messages);
  });

  /* 工具报错只是「试错」, 不是「失败」: 连续多次且迟迟不恢复才提示,
   * 避免 agent 自己修好的一次报错就闪红灯 */
  pi.on("tool_result", (event, ctx) => {
    lastCtx = ctx;
    if (!event.isError) {
      errorStreak = 0;
      errorReported = false;
      clearErrorTimer();
      return;
    }
    if (attentionOpen) return; // 等人处理中, 状态由 attention 接管
    errorStreak++;
    if (errorReported || errorTimer || errorStreak < ERROR_STREAK_THRESHOLD) return;
    errorTimer = setTimeout(() => {
      errorTimer = null;
      if (attentionOpen || !busy || errorStreak < ERROR_STREAK_THRESHOLD) return;
      errorReported = true;
      log(`连续 ${errorStreak} 次工具报错, 红灯提示`);
      pushState("error", baseState());
    }, ERROR_HOLD_MS);
  });

  pi.on("agent_settled", (event, ctx) => {
    lastCtx = ctx;
    busy = false;
    clearErrorTimer();
    clearAttentionReminders();
    attentionOpen = false;
    const outcome: AgentOutcome = event.aborted ? "aborted" : (lastOutcome ?? "completed");
    /** 本轮是否真的失败: 循环以 error 结束, 或者连续报错还没得到一次成功 */
    const failed = outcome === "error" || (!errorReported && errorStreak >= ERROR_STREAK_THRESHOLD);
    const alerted = errorReported;   // 运行中已经红过一次
    lastOutcome = undefined;
    errorReported = false;
    errorStreak = 0;

    if (outcome === "aborted") {
      pushState("idle"); // 自己按 KEY1 打断的, 不吵人
    } else if (outcome === "error") {
      pushState("error", "idle"); // 真失败: 红闪 + 出错音
    } else if (failed) {
      pushState("error", "idle"); // 连错 + 没来得及提示: 收尾补一次
    } else if (alerted) {
      pushState("idle"); // 已经红过了, 收尾不再重复闪 (避免红→白→蓝的跳色)
    } else {
      pushState("done", "idle"); // 白闪 + 完成音
    }
  });

  /* agent 卡在等人操作 (ask_user_question / 选择框 / 输入框):
   * 这是唯一需要「主动叫人」的时刻 —— 琥珀双脉冲 + 专门提示音 + 补提醒 */
  pi.on("ui_prompt_start", (event, ctx) => {
    lastCtx = ctx;
    /* /dock 面板自己就是模态 UI, 用户就在眼前, 不再提醒 */
    if (panelOpen || attentionOpen) return;
    attentionOpen = true;
    clearErrorTimer();
    log(`需要人处理 (${event.kind}${event.title ? `: ${event.title}` : ""})`);
    pushState("attention");
    scheduleAttentionReminders();
  });

  pi.on("ui_prompt_end", (_e, ctx) => {
    lastCtx = ctx;
    if (!attentionOpen) return;
    attentionOpen = false;
    clearAttentionReminders();
    pushState(baseState());
  });

  /* ---------- /dock 命令 ---------- */
  pi.registerCommand("dock", {
    description: "智坞 AgentDock 管理面板 (设备选择/宏配置/声音/灯效测试)",
    handler: async (_args, ctx) => {
      await runPanel(ctx);
    },
  });

  async function runPanel(ctx: ExtensionContext): Promise<void> {
    /* 防重入: 面板是模态循环, 并发跑两份会让按键流串到另一个实例上 */
    if (panelOpen) {
      ctx.ui.notify("面板已打开", "warning");
      return;
    }
    panelOpen = true;
    lastCtx = ctx;
    try {
      while (true) {
        /* 传函数而非快照: 面板重绘时实时读取, 面板停留期间状态变化也能反映 */
        const action: PanelAction | null = await showPanel(ctx, channel, config, () => ({
          busy,
          scrollAvailable: scroller.available,
          muted: deviceMuted,
          sounds: deviceSounds,
        }));
        if (!action || action.kind === "exit") break;

        switch (action.kind) {
          case "bind-device":
            config.preferredDevice = action.name;
            saveConfig(config);
            ctx.ui.notify(`已绑定 ${action.name}, 重连中 ...`);
            channel.dispose();
            await connectWithRetry(ctx, true);
            break;

          case "edit-macro":
            config.macros[action.index] = action.text;
            saveConfig(config);
            ctx.ui.notify(`宏已保存: ${action.text}`);
            break;

          case "test-led": {
            if (!channel.connected) {
              ctx.ui.notify("设备未连接", "warning");
            } else {
              /* done/error/demo 是瞬态: 告诉设备播完回到当前真实状态。
               * 只发不等 —— 等回包会把面板循环挂死 */
              const then =
                action.state === "done" || action.state === "error" || action.state === "demo"
                  ? baseState()
                  : undefined;
              channel.writeState(action.state, then);
              ctx.ui.notify(`已发送测试状态: ${action.state}`);
            }
            break;
          }

          case "settings":
            config.brightness = action.brightness;
            config.keyVolume = action.sounds[0];
            config.knobVolume = action.sounds[1];
            config.agentVolume = action.sounds[2];
            config.muted = action.muted;
            saveConfig(config);
            deviceMuted = action.muted;
            deviceSounds = [...action.sounds] as SoundVolumes;
            /* 面板里每改一档已实时下发, 这里再补一次幂等写入 (并兼容非 TUI 回退路径) */
            if (channel.connected) {
              channel.writeConfig({
                brightness: action.brightness,
                muted: action.muted,
                sounds: action.sounds,
              });
              ctx.ui.notify(
                `已应用: 亮度 ${action.brightness}% · 按键 ${action.sounds[0]}%` +
                  ` · 旋钮 ${action.sounds[1]}% · agent ${action.sounds[2]}%` +
                  `${action.muted ? " · 总静音" : ""}`,
              );
            } else {
              ctx.ui.notify("设备未连接: 设置已记为默认值, 连上后以设备当前值为准", "warning");
            }
            break;

          case "reconnect":
            ctx.ui.notify("重连中 ...");
            channel.dispose();
            await connectWithRetry(ctx, true);
            break;
        }
      }
    } finally {
      /* 异常也要释放, 否则 /dock 从此永远报「面板已打开」 */
      panelOpen = false;
    }
  }

  /* ---------- 连接管理 ---------- */
  /* 同一失败原因只提示一次, 避免重试循环刷屏; 连接成功后复位 */
  let lastFailReason = "";
  function notifyFailure(ctx: ExtensionContext, reason: string, message: string): void {
    if (reason === lastFailReason) return;
    lastFailReason = reason;
    ctx.ui.notify(message, "warning");
  }

  async function connectOnce(ctx: ExtensionContext): Promise<boolean> {
    const result = await channel.connect(config.preferredDevice);
    if (result === "ok") {
      lastFailReason = "";
      return true;
    }
    if (result === "not_found") {
      const devices = await channel.scan();
      if (devices.length === 1 && devices[0].name !== config.preferredDevice) {
        /* 绑定设备不在线, 现场只有另一台 → 自动改绑并落盘。
         * 固件按 MAC 后缀命名, 换板/重烧后名字会变; 若不改绑,
         * 会永远静默重试 —— 「能扫到设备却连不上」的根因 */
        const old = config.preferredDevice || "(未绑定)";
        config.preferredDevice = devices[0].name;
        saveConfig(config);
        ctx.ui.notify(`绑定设备 ${old} 不在线, 已自动改绑 ${devices[0].name}`, "warning");
        const retry = await channel.connect(config.preferredDevice);
        if (retry === "ok") {
          lastFailReason = "";
          return true;
        }
        return false;
      }
      if (devices.length > 1) {
        ctx.ui.notify(`发现 ${devices.length} 台 AgentDock, 请选择`, "warning");
        await runPanel(ctx);
        return channel.connected;
      }
      notifyFailure(ctx, "no-device", "未发现 AgentDock 设备, 每 5s 后台重试 (设备 LED 心跳=未连接)");
    } else {
      notifyFailure(ctx, "connect-failed", "AgentDock 连接失败, 每 5s 重试 (详情见日志)");
    }
    return false;
  }

  async function connectWithRetry(ctx: ExtensionContext, notifyFail: boolean): Promise<void> {
    if (await connectOnce(ctx)) return;
    if (notifyFail) ctx.ui.notify("本次未连上, 将在后台每 5s 重试 (LED 心跳=未连接)", "warning");
    scheduleReconnect(ctx);
  }

  function scheduleReconnect(ctx: ExtensionContext): void {
    if (disposed || reconnectTimer || channel.connected) return;
    reconnectTimer = setInterval(() => {
      if (channel.connected) {
        clearInterval(reconnectTimer!);
        reconnectTimer = null;
        return;
      }
      /* 一次连接尝试 (扫描+GATT) 可能超过重连间隔, 重叠时直接跳过本轮,
       * 避免 connect() 被 connecting 锁拒绝而误报「连接失败」 */
      if (channel.connecting) return;
      void connectOnce(ctx);
    }, RECONNECT_MS);
  }

  /* ---------- 生命周期 ---------- */
  pi.on("session_start", (_e, ctx) => {
    lastCtx = ctx;
    tuiMode = ctx.mode === "tui";
    disposed = false;
    /* 捕获内部 TUI 实例供旋钮滚动 (widget 渲染空组件, 0 行不可见) */
    if (tuiMode) {
      try {
        ctx.ui.setWidget("agentdock-scroll", (tui) => {
          scroller.attach(tui);
          return {
            render: () => [],
            invalidate: () => {},
            dispose: () => scroller.detach(),
          };
        }, { placement: "belowEditor" });
      } catch (e) {
        log("滚动 widget 注册失败:", e);
      }
    }
    updateStatusLine();
    void connectWithRetry(ctx, false);
  });

  pi.on("session_shutdown", () => {
    disposed = true;
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
    clearErrorTimer();
    clearAttentionReminders();
    attentionOpen = false;
    channel.dispose();
    scroller.detach();
    log("资源已清理");
  });
}
