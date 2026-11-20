/*
 * state-machine.test.ts — index.ts 的 agent 状态机 / 声音提醒
 *
 * 覆盖 v0.4 的三个体验修复 (每个都对应一次真实吐槽):
 *   1. error 太敏感: 一两次工具报错不亮红灯, 连续多次 + 观察窗才提示一次
 *   2. 需要人处理时要有声音: ui_prompt_start → attention 状态, 无人响应补提醒
 *   3. 瞬态灯效之后回到哪由设备决定: done/error 带 then, 不再靠插件定时器抢状态
 *
 * mock child_process (FakeWorker) + 隔离 HOME, 走真实扩展入口.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  /** 只取某一类 op (按到达顺序) */
  ops(op: string): any[] {
    return this.requests().filter((r) => r.op === op);
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

const flush = async (ticks = 8) => {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentdock-state-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  configPath = join(home, ".pi", "agent", "agentdock.json");
  vi.stubEnv("HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** 启动扩展并让连接成功 (避免后台重连定时器干扰假时钟) */
async function boot(): Promise<{
  handlers: Record<string, (e: unknown, ctx: unknown) => void>;
  pi: any;
  ctx: any;
}> {
  const ext = await loadExtension();
  const { handlers, pi } = makePi();
  ext(pi);
  const ctx = makeCtx();
  handlers.session_start(undefined, ctx);
  await flush();
  const connect = worker.ops("connect").at(-1);
  worker.reply({ type: "result", id: connect.id, ok: true, result: "ok" });
  worker.reply({ type: "connection", connected: true, name: "AgentDock-TEST", rssi: -55 });
  await flush();
  /* 清掉连接阶段的写状态 (session_start 会补推 busy/idle) */
  worker.sent.length = 0;
  return { handlers, pi, ctx };
}

const isError = { isError: true };
const isOk = { isError: false };

describe("error 去抖 (error 太敏感的修复)", () => {
  it("单次/两次工具报错不亮红灯", async () => {
    const { handlers } = await boot();
    handlers.agent_start(undefined, makeCtx());
    handlers.tool_result(isError, makeCtx());
    handlers.tool_result(isError, makeCtx());
    await vi.waitFor(() => expect(worker.ops("writeState").length).toBe(1));

    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(8000);
      expect(worker.ops("writeState").map((r) => r.state)).toEqual(["busy"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("连续 3 次 + 观察窗后提示一次 error, 并回到 busy", async () => {
    vi.useFakeTimers();
    try {
      const { handlers } = await boot();
      handlers.agent_start(undefined, makeCtx());
      for (let i = 0; i < 3; i++) handlers.tool_result(isError, makeCtx());
      await vi.advanceTimersByTimeAsync(2400);
      expect(worker.ops("writeState").map((r) => r.state)).not.toContain("error");

      await vi.advanceTimersByTimeAsync(200);
      const errors = worker.ops("writeState").filter((r) => r.state === "error");
      expect(errors).toHaveLength(1);
      /* 瞬态灯效结束后回到 busy (agent 还在跑), 不是 idle */
      expect(errors[0]).toMatchObject({ state: "error", then: "busy" });

      /* 同一轮不重复提示 */
      for (let i = 0; i < 5; i++) handlers.tool_result(isError, makeCtx());
      await vi.advanceTimersByTimeAsync(5000);
      expect(worker.ops("writeState").filter((r) => r.state === "error")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("观察窗内出现一次成功 → 取消提示 (agent 自己缓过来了)", async () => {
    vi.useFakeTimers();
    try {
      const { handlers } = await boot();
      handlers.agent_start(undefined, makeCtx());
      for (let i = 0; i < 3; i++) handlers.tool_result(isError, makeCtx());
      await vi.advanceTimersByTimeAsync(1000);
      handlers.tool_result(isOk, makeCtx());
      await vi.advanceTimersByTimeAsync(8000);
      expect(worker.ops("writeState").map((r) => r.state)).not.toContain("error");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("settle 状态", () => {
  it("正常完成 → done (then=idle), 设备闪完回待命", async () => {
    const { handlers } = await boot();
    handlers.agent_start(undefined, makeCtx());
    handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, makeCtx());
    handlers.agent_settled({ aborted: false }, makeCtx());
    await flush();

    const last = worker.ops("writeState").at(-1);
    expect(last).toMatchObject({ state: "done", then: "idle" });
  });

  it("自己按 KEY1 打断 → 静默回 idle", async () => {
    const { handlers } = await boot();
    handlers.agent_start(undefined, makeCtx());
    handlers.agent_end({ messages: [{ role: "assistant", stopReason: "aborted" }] }, makeCtx());
    handlers.agent_settled({ aborted: true }, makeCtx());
    await flush();

    const last = worker.ops("writeState").at(-1);
    expect(last.state).toBe("idle");
    expect(last.then).toBeUndefined();
  });

  it("provider 报错 (agent_end 的 stopReason=error) → error (then=idle)", async () => {
    const { handlers } = await boot();
    handlers.agent_start(undefined, makeCtx());
    handlers.agent_end({ messages: [{ role: "assistant", stopReason: "error" }] }, makeCtx());
    handlers.agent_settled({ aborted: false }, makeCtx());
    await flush();

    const last = worker.ops("writeState").at(-1);
    expect(last).toMatchObject({ state: "error", then: "idle" });
  });

  it("运行中已经红过 → 收尾静默回 idle (不重复闪, 也不给完成音)", async () => {
    vi.useFakeTimers();
    try {
      const { handlers } = await boot();
      handlers.agent_start(undefined, makeCtx());
      for (let i = 0; i < 3; i++) handlers.tool_result(isError, makeCtx());
      await vi.advanceTimersByTimeAsync(2600);
      expect(worker.ops("writeState").filter((r) => r.state === "error")).toHaveLength(1);

      handlers.agent_end({ messages: [{ role: "assistant", stopReason: "stop" }] }, makeCtx());
      handlers.agent_settled({ aborted: false }, makeCtx());
      await vi.advanceTimersByTimeAsync(0);

      const last = worker.ops("writeState").at(-1);
      expect(last.state).toBe("idle");
      expect(worker.ops("writeState").filter((r) => r.state === "error")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("3 连错后立刻收尾 (没到观察窗) → 收尾补一次 error", async () => {
    const { handlers } = await boot();
    handlers.agent_start(undefined, makeCtx());
    for (let i = 0; i < 3; i++) handlers.tool_result(isError, makeCtx());
    handlers.agent_settled({ aborted: false }, makeCtx());
    await flush();

    const last = worker.ops("writeState").at(-1);
    expect(last).toMatchObject({ state: "error", then: "idle" });
  });
});

describe("需要人处理 (attention)", () => {
  it("ui_prompt_start → attention, 结束后回到 busy", async () => {
    const { handlers } = await boot();
    handlers.agent_start(undefined, makeCtx());
    handlers.ui_prompt_start({ kind: "confirm", title: "允许执行?" }, makeCtx());
    await flush();
    expect(worker.ops("writeState").at(-1).state).toBe("attention");

    handlers.ui_prompt_end({ kind: "confirm" }, makeCtx());
    await flush();
    expect(worker.ops("writeState").at(-1).state).toBe("busy");
  });

  it("无人响应时每 20s 补提醒, 共 3 次", async () => {
    vi.useFakeTimers();
    try {
      const { handlers } = await boot();
      handlers.agent_start(undefined, makeCtx());
      handlers.ui_prompt_start({ kind: "input" }, makeCtx());
      await vi.advanceTimersByTimeAsync(0);
      const attentionCount = () =>
        worker.ops("writeState").filter((r) => r.state === "attention").length;
      expect(attentionCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(20000);
      expect(attentionCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(20000);
      expect(attentionCount()).toBe(3);
      /* 有上限: 再久也不继续吵 */
      await vi.advanceTimersByTimeAsync(120000);
      expect(attentionCount()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("处理完 (ui_prompt_end) 后不再补提醒", async () => {
    vi.useFakeTimers();
    try {
      const { handlers } = await boot();
      handlers.ui_prompt_start({ kind: "select" }, makeCtx());
      handlers.ui_prompt_end({ kind: "select" }, makeCtx());
      const before = worker.ops("writeState").length;
      await vi.advanceTimersByTimeAsync(120000);
      expect(worker.ops("writeState").length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("等人处理期间工具报错不抢状态", async () => {
    vi.useFakeTimers();
    try {
      const { handlers } = await boot();
      handlers.agent_start(undefined, makeCtx());
      handlers.ui_prompt_start({ kind: "confirm" }, makeCtx());
      for (let i = 0; i < 4; i++) handlers.tool_result(isError, makeCtx());
      await vi.advanceTimersByTimeAsync(10000);
      const states = worker.ops("writeState").map((r) => r.state);
      expect(states).not.toContain("error");
      expect(states.at(-1)).toBe("attention");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("设备设置快照 (cfg)", () => {
  it("三类音量 + 静音写回本地配置, 供面板显示", async () => {
    const { handlers } = await boot();
    handlers.agent_start(undefined, makeCtx());
    worker.reply({ type: "event", msg: { k: "cfg", b: 70, m: 1, s: [90, 40, 20] } });
    await flush();

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved).toMatchObject({
      brightness: 70,
      keyVolume: 90,
      knobVolume: 40,
      agentVolume: 20,
      muted: true,
    });
  });

  it("旧固件只报 b/v 时不破坏已有音量", async () => {
    const { handlers } = await boot();
    handlers.agent_start(undefined, makeCtx());
    worker.reply({ type: "event", msg: { k: "cfg", b: 55, v: 30 } });
    await flush();

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.brightness).toBe(55);
    /* 默认值: 100 / 60 / 100 */
    expect(saved).toMatchObject({ keyVolume: 100, knobVolume: 60, agentVolume: 100 });
  });
});
