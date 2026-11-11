/*
 * connect-flow.test.ts — index.ts 连接决策集成测试
 *
 * mock child_process (FakeWorker) + 隔离 HOME, 走真实扩展入口:
 *   - session_start → connectOnce → IPC connect → 结果分支
 *   - 绑定设备不在线且现场仅另一台 → 自动改绑落盘 + 二次连接
 *   - 多台在线 → 提示选择 (面板流程, RPC 模式)
 *   - 失败通知按原因去重, 不随重试刷屏
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => fakeSpawn(...args),
}));

/* ---------------- FakeWorker (与 ble.test.ts 同构) ---------------- */

class FakeWorker extends EventEmitter {
  stdin = new EventEmitter() as any;
  stdout = new EventEmitter() as any;
  stderr = new EventEmitter() as any;
  exitCode: number | null = null;
  sent: string[] = [];

  constructor() {
    super();
    this.stdin.writable = true;
    this.stdin.write = (l: string) => {
      this.sent.push(l);
      return true;
    };
    this.stdin.end = vi.fn();
    this.stdout.setEncoding = vi.fn();
    this.stderr.setEncoding = vi.fn();
  }

  requests(): any[] {
    return this.sent.map((l) => JSON.parse(l));
  }

  reply(msg: unknown): void {
    this.stdout.emit("data", JSON.stringify(msg) + "\n");
  }

  kill(): boolean {
    return true;
  }
}

/* ---------------- 环境隔离 ---------------- */

let home: string;
let configPath: string;
let worker: FakeWorker;

async function loadExtension(): Promise<(pi: any) => void> {
  vi.resetModules();
  worker = new FakeWorker();
  fakeSpawn.mockReset();
  fakeSpawn.mockReturnValue(worker);
  const mod = await import("../index.js");
  return mod.default;
}

function makePi() {
  const handlers: Record<string, (e: unknown, ctx: unknown) => void> = {};
  const pi = {
    on: (ev: string, cb: any) => {
      handlers[ev] = cb;
    },
    registerCommand: vi.fn(),
    sendUserMessage: vi.fn(),
  };
  return { handlers, pi };
}

function makeCtx() {
  return {
    mode: "tui",
    isIdle: () => true,
    abort: vi.fn(),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  };
}

const flush = async (ticks = 6) => {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentdock-flow-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  configPath = join(home, ".pi", "agent", "agentdock.json");
  writeFileSync(
    configPath,
    JSON.stringify({ preferredDevice: "AgentDock-OLD", macros: ["继续", "不对"] }),
    "utf8",
  );
  vi.stubEnv("HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** 驱动 worker 端 "connect" 请求: 扫描发现设备列表, 返回结果 */
function workerReplyConnect(devices: Array<{ name: string; rssi: number }>, result: string): void {
  const req = worker.requests().find((r) => r.op === "connect" && !r.__handled);
  if (!req) throw new Error("没有待处理的 connect 请求");
  req.__handled = true;
  if (result === "not_found") {
    /* 先回扫描可见设备 (模拟 IPC: worker 内部扫描) */
    worker.reply({ type: "log", args: ["未发现设备 (目标不在列表)"] });
  }
  worker.reply({ type: "result", id: req.id, ok: true, result });
}

/** 找到最近一次 scan 请求并回复设备列表 */
function workerReplyScan(devices: Array<{ name: string; rssi: number }>): void {
  const req = worker.requests().filter((r) => r.op === "scan").at(-1);
  if (!req) throw new Error("没有待处理的 scan 请求");
  worker.reply({ type: "result", id: req.id, ok: true, devices });
}

/* ---------------- 测试 ---------------- */

describe("连接决策 (index.ts connectOnce)", () => {
  it("绑定设备不在线且现场仅一台 → 自动改绑落盘并二次连接成功", async () => {
    const ext = await loadExtension();
    const { handlers, pi } = makePi();
    ext(pi);
    const ctx = makeCtx();

    handlers.session_start(undefined, ctx);
    await flush();

    /* 第一轮: connect(OLD) → 扫描只看到 NEW → not_found */
    workerReplyConnect([{ name: "AgentDock-NEW", rssi: -55 }], "not_found");
    await flush();

    /* connectOnce 复查设备列表 (扫描请求) */
    workerReplyScan([{ name: "AgentDock-NEW", rssi: -55 }]);
    await flush();

    /* 自动改绑 → 二次 connect(NEW) → 成功 */
    workerReplyConnect([{ name: "AgentDock-NEW", rssi: -55 }], "ok");
    worker.reply({ type: "connection", connected: true, name: "AgentDock-NEW", rssi: -55 });
    await flush(10);

    expect(JSON.parse(readFileSync(configPath, "utf8")).preferredDevice).toBe("AgentDock-NEW");
    const notified = ctx.ui.notify.mock.calls.map((c: any[]) => String(c[0])).join(" | ");
    expect(notified).toContain("AgentDock-OLD");
    expect(notified).toContain("已自动改绑 AgentDock-NEW");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("agentdock", "🎮 AgentDock-NEW");
  });

  it("连接成功 → 状态行显示设备名", async () => {
    const ext = await loadExtension();
    const { handlers, pi } = makePi();
    ext(pi);
    const ctx = makeCtx();

    handlers.session_start(undefined, ctx);
    await flush();

    workerReplyConnect([{ name: "AgentDock-OLD", rssi: -55 }], "ok");
    worker.reply({ type: "connection", connected: true, name: "AgentDock-OLD", rssi: -55 });
    await flush(10);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("agentdock", "🎮 AgentDock-OLD");
    expect(JSON.parse(readFileSync(configPath, "utf8")).preferredDevice).toBe("AgentDock-OLD");
  });

  it("连接失败通知按原因去重, 不随重试刷屏", async () => {
    vi.useFakeTimers();
    try {
      const ext = await loadExtension();
      const { handlers, pi } = makePi();
      ext(pi);
      const ctx = makeCtx();

      handlers.session_start(undefined, ctx);
      await flush();

      /* 连续多轮失败 */
      for (let i = 0; i < 3; i++) {
        workerReplyConnect([], "failed");
        await flush();
        await vi.advanceTimersByTimeAsync(5500); /* 重连间隔 */
        await flush();
      }

      const failures = ctx.ui.notify.mock.calls.filter((c: any[]) =>
        /连接失败/.test(String(c[0])),
      );
      expect(failures.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("未发现设备 → 单次提示, 不刷屏", async () => {
    vi.useFakeTimers();
    try {
      const ext = await loadExtension();
      const { handlers, pi } = makePi();
      ext(pi);
      const ctx = makeCtx();

      handlers.session_start(undefined, ctx);
      await flush();

      for (let i = 0; i < 3; i++) {
        workerReplyConnect([], "not_found");
        await flush();
        workerReplyScan([]); /* connectOnce 复查: 空 */
        await flush();
        await vi.advanceTimersByTimeAsync(5500);
        await flush();
      }

      const noDevice = ctx.ui.notify.mock.calls.filter((c: any[]) =>
        /未发现 AgentDock/.test(String(c[0])),
      );
      expect(noDevice.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
