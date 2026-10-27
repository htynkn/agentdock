/*
 * 智坞 AgentDock ↔ pi coding agent 扩展 (入口)
 *
 * 结构:
 *   index.ts  — pi 集成: 生命周期 / 状态机 / /deck 命令 / 动作分发
 *   ble.ts    — BLE 通道 (扫描/连接/订阅/重连)
 *   panel.ts  — /deck 可视化管理面板
 *   config.ts — 配置持久化 (~/.pi/agent/agentdock.json)
 *
 * 加载: pi --extension <本目录>/index.ts
 * 使用: pi 内输入 /deck 打开管理面板 (设备选择/宏配置/灯效测试)
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { DeckChannel } from "./ble.js";
import { loadConfig, saveConfig, type DeckConfig } from "./config.js";
import { showPanel, type PanelAction } from "./panel.js";
import { DeckScroller } from "./scroll.js";

/* 状态回稳延时: done 白闪 / error 红闪播放完后再刷新为真实状态 */
const TRANSIENT_MS = 3000;
/* 断线重连间隔 */
const RECONNECT_MS = 5000;

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
  let reconnectTimer: NodeJS.Timeout | null = null;
  let busy = false;
  let transientUntil = 0;        // done/error 特效期间不覆盖 LED
  let lastCtx: ExtensionContext | null = null;

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
    } else if (msg.k === "enc") {
      const ok = scroller.scrollByInput(Number(msg.v) || 0, log);
      if (!ok) log(`旋钮滚动 ${msg.v} (TUI 滚动不可用, 需 fullscreen 模式)`);
    } else {
      log("未知事件:", JSON.stringify(msg));
    }
  }

  /* ---------- pi → 设备 (LED 状态机) ---------- */
  function refreshState(): void {
    if (Date.now() < transientUntil) return;
    void channel.writeState(busy ? "busy" : "idle");
  }

  function onConnectionChanged(connected: boolean): void {
    updateStatusLine();
    if (connected) {
      transientUntil = 0;
      void channel.writeState(busy ? "busy" : "idle");
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
    refreshState();
  });

  pi.on("agent_settled", (_e, ctx) => {
    lastCtx = ctx;
    busy = false;
    void channel.writeState("done");
    transientUntil = Date.now() + TRANSIENT_MS;
    setTimeout(refreshState, TRANSIENT_MS);
  });

  pi.on("tool_result", (event, ctx) => {
    lastCtx = ctx;
    if (!event.isError) return;
    transientUntil = Date.now() + TRANSIENT_MS;
    void channel.writeState("error");
    setTimeout(refreshState, TRANSIENT_MS);
  });

  /* ---------- /deck 命令 ---------- */
  pi.registerCommand("dock", {
    description: "智坞 AgentDock 管理面板 (设备选择/宏配置/灯效测试)",
    handler: async (_args, ctx) => {
      await runPanel(ctx);
    },
  });

  async function runPanel(ctx: ExtensionContext): Promise<void> {
    lastCtx = ctx;
    let running = true;
    while (running) {
      /* 传函数而非快照: 面板重绘时实时读取, 面板停留期间状态变化也能反映 */
      const action: PanelAction | null = await showPanel(ctx, channel, config, () => ({
        busy,
        scrollAvailable: scroller.available,
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

        case "test-led":
          if (!channel.connected) {
            ctx.ui.notify("设备未连接", "warning");
          } else {
            await channel.writeState(action.state);
            ctx.ui.notify(`已发送测试状态: ${action.state}`);
            setTimeout(refreshState, TRANSIENT_MS);
          }
          break;

        case "reconnect":
          ctx.ui.notify("重连中 ...");
          channel.dispose();
          await connectWithRetry(ctx, true);
          break;
      }
    }
  }

  /* ---------- 连接管理 ---------- */
  async function connectOnce(ctx: ExtensionContext): Promise<boolean> {
    const result = await channel.connect(config.preferredDevice);
    if (result === "ok") return true;
    if (result === "not_found") {
      // 未绑定且发现多台 → 进面板选择; 其余情况静默重试
      const devices = await channel.scan();
      if (devices.length > 1) {
        ctx.ui.notify(`发现 ${devices.length} 台 AgentDock, 请选择`, "warning");
        await runPanel(ctx);
        return channel.connected;
      }
      log("未发现设备, 稍后重试");
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
    if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
    channel.dispose();
    scroller.detach();
    log("资源已清理");
  });
}
