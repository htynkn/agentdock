/*
 * ble.test.ts — DeckChannel IPC 客户端单测 (mock child_process.spawn)
 *
 * 覆盖:
 *   - JSONL 协议: scan/connect/writeState/refreshRssi 的请求-响应关联
 *   - 设备事件/连接状态经 IPC 转发
 *   - worker 崩溃: pending 请求了结 + 连接状态复位 + 下次请求重新拉起
 *   - dispose: 结束 stdin + kill + 通知断开
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => fakeSpawn(...args),
}));

import { DeckChannel, type DeckPeripheralInfo } from "../ble.js";

/* ---------------- FakeWorker ---------------- */

class FakeWorker extends EventEmitter {
  stdin = new EventEmitter() as any;
  stdout = new EventEmitter() as any;
  stderr = new EventEmitter() as any;
  exitCode: number | null = null;
  killed = false;
  sent: string[] = [];
  killedSignals: unknown[] = [];

  constructor() {
    super();
    this.stdin.writable = true;
    this.stdin.write = (line: string) => {
      this.sent.push(line);
      return true;
    };
    this.stdin.end = vi.fn();
    this.stdout.setEncoding = vi.fn();
    this.stderr.setEncoding = vi.fn();
  }

  /** worker 收到的请求 (JSON) */
  requests(): any[] {
    return this.sent.map((l) => JSON.parse(l));
  }

  /** 模拟 worker 发消息给主进程 */
  reply(msg: unknown): void {
    this.stdout.emit("data", JSON.stringify(msg) + "\n");
  }

  /** 模拟进程退出 */
  die(): void {
    this.exitCode = 1;
    this.emit("exit", 1, null);
  }

  kill(...args: unknown[]): boolean {
    this.killed = true;
    this.killedSignals.push(args);
    return true;
  }
}

let worker: FakeWorker;

beforeEach(() => {
  worker = new FakeWorker();
  fakeSpawn.mockReset();
  fakeSpawn.mockReturnValue(worker);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeChannel() {
  const events: unknown[] = [];
  const conns: boolean[] = [];
  const logs: string[] = [];
  const ch = new DeckChannel(
    (msg) => events.push(msg),
    (c) => conns.push(c),
    (...a) => logs.push(a.join(" ")),
  );
  return { ch, events, conns, logs };
}

function settle<T>(p: Promise<T>): Promise<T> {
  return p.then(
    (v) => v,
    (e) => e,
  );
}

/* ---------------- 测试 ---------------- */

describe("DeckChannel (IPC 客户端)", () => {
  it("scan: 发送命令并按 id 关联回包, 结果按 RSSI 排序", async () => {
    const { ch } = makeChannel();
    const pending = ch.scan();
    await Promise.resolve();

    const req = worker.requests().at(-1);
    expect(req.op).toBe("scan");
    expect(typeof req.id).toBe("number");

    worker.reply({
      type: "result",
      id: req.id,
      ok: true,
      devices: [
        { name: "AgentDock-B", rssi: -80 },
        { name: "AgentDock-A", rssi: -60 },
      ],
    });
    const devices = await pending;
    expect(devices).toEqual<DeckPeripheralInfo[]>([
      { name: "AgentDock-A", rssi: -60 },
      { name: "AgentDock-B", rssi: -80 },
    ]);
  });

  it("scan: worker 回非法数据/坏行时不崩, 返回空列表", async () => {
    const { ch } = makeChannel();
    const pending = settle(ch.scan());
    await Promise.resolve();
    worker.stdout.emit("data", "not-json\n");
    const req = worker.requests().at(-1);
    worker.reply({ type: "result", id: req.id, ok: true, devices: [{ name: 1, rssi: "x" }] });
    expect(await pending).toEqual([]);
  });

  it("connect: 透传结果 (ok/not_found/failed)", async () => {
    const { ch } = makeChannel();
    for (const result of ["ok", "not_found", "failed"] as const) {
      const pending = ch.connect("AgentDock-A");
      await Promise.resolve();
      const req = worker.requests().at(-1);
      expect(req).toMatchObject({ op: "connect", name: "AgentDock-A" });
      worker.reply({ type: "result", id: req.id, ok: true, result });
      expect(await pending).toBe(result);
    }
  });

  it("连接中再次 connect 直接拒绝 (防重叠尝试)", async () => {
    const { ch } = makeChannel();
    const first = ch.connect("AgentDock-A");
    await Promise.resolve();
    expect(await ch.connect("AgentDock-A")).toBe("failed");
    const req = worker.requests().at(-1);
    worker.reply({ type: "result", id: req.id, ok: true, result: "ok" });
    expect(await first).toBe("ok");
  });

  it("connection 消息驱动 connected/deviceName/rssi 与回调", async () => {
    const { ch, conns } = makeChannel();
    const conn = ch.connect("AgentDock-A");
    await Promise.resolve();
    const req = worker.requests().at(-1);

    worker.reply({ type: "connection", connected: true, name: "AgentDock-A", rssi: -55 });
    expect(ch.connected).toBe(true);
    expect(ch.deviceName).toBe("AgentDock-A");
    expect(ch.rssi).toBe(-55);

    worker.reply({ type: "result", id: req.id, ok: true, result: "ok" });
    await conn;
    expect(conns).toContain(true);

    /* 断开: 状态复位, rssi 清空 */
    const conn2 = ch.connect("AgentDock-A");
    await Promise.resolve();
    worker.reply({ type: "connection", connected: false, name: "", rssi: null });
    expect(ch.connected).toBe(false);
    expect(ch.rssi).toBeNull();
    worker.reply({ type: "result", id: worker.requests().at(-1).id, ok: true, result: "failed" });
    await conn2;
    expect(conns).toContain(false);
  });

  it("event 消息转发给 onEvent 回调; log 消息走日志", async () => {
    const { ch, events, logs } = makeChannel();
    const conn = ch.connect("AgentDock-A");
    await Promise.resolve();
    const req = worker.requests().at(-1);

    worker.reply({ type: "log", args: ["hello", "world"] });
    expect(logs).toContain("hello world");

    worker.reply({ type: "event", msg: { k: "key", id: 1 } });
    expect(events).toContainEqual({ k: "key", id: 1 });

    worker.reply({ type: "result", id: req.id, ok: true, result: "ok" });
    await conn;
  });

  it("onConnectionChange 订阅/退订", async () => {
    const { ch } = makeChannel();
    const seen: boolean[] = [];
    const off = ch.onConnectionChange((c) => seen.push(c));

    const conn = ch.connect("AgentDock-A");
    await Promise.resolve();
    const req = worker.requests().at(-1);
    worker.reply({ type: "connection", connected: true, name: "AgentDock-A", rssi: -50 });
    worker.reply({ type: "result", id: req.id, ok: true, result: "ok" });
    await conn;
    expect(seen).toEqual([true]);

    off();
    const conn2 = ch.connect("AgentDock-A");
    await Promise.resolve();
    worker.reply({ type: "connection", connected: false, name: "" });
    worker.reply({ type: "result", id: worker.requests().at(-1).id, ok: true, result: "failed" });
    await conn2;
    expect(seen).toEqual([true]); /* 退订后不再收到 */
  });

  it("worker 崩溃: pending 了结为失败, 下次请求重新拉起新进程", async () => {
    const { ch } = makeChannel();
    const pending = settle(ch.connect("AgentDock-A"));
    await Promise.resolve();

    worker.die();
    expect(await pending).toBe("failed");
    expect(ch.connected).toBe(false);

    /* 下一次请求拉起全新 worker */
    const scan2 = ch.scan();
    await Promise.resolve();
    expect(fakeSpawn).toHaveBeenCalledTimes(2);
    const req = worker.requests().at(-1);
    worker.reply({ type: "result", id: req.id, ok: true, devices: [] });
    expect(await scan2).toEqual([]);
  });

  it("dispose: 发送 dispose、结束 stdin、kill、广播断开", async () => {
    const { ch, conns } = makeChannel();
    const conn = ch.connect("AgentDock-A");
    await Promise.resolve();
    const req = worker.requests().at(-1);
    worker.reply({ type: "connection", connected: true, name: "AgentDock-A", rssi: -50 });
    worker.reply({ type: "result", id: req.id, ok: true, result: "ok" });
    await conn;

    ch.dispose();
    expect(worker.requests().some((r) => r.op === "dispose")).toBe(true);
    expect(worker.stdin.end).toHaveBeenCalled();
    expect(worker.killed).toBe(true);
    expect(ch.connected).toBe(false);
    expect(conns.at(-1)).toBe(false);
  });

  it("worker 主动连上后又退出 → 触发断开回调", async () => {
    const { ch, conns } = makeChannel();
    const conn = ch.connect("AgentDock-A");
    await Promise.resolve();
    const req = worker.requests().at(-1);
    worker.reply({ type: "connection", connected: true, name: "AgentDock-A", rssi: -50 });
    worker.reply({ type: "result", id: req.id, ok: true, result: "ok" });
    await conn;
    expect(ch.connected).toBe(true);

    worker.die();
    expect(ch.connected).toBe(false);
    expect(conns.at(-1)).toBe(false);
  });

  it("refreshRssi: 回包数值更新缓存并返回; 异常沿用缓存", async () => {
    const { ch } = makeChannel();
    const conn = ch.connect("AgentDock-A");
    await Promise.resolve();
    const req = worker.requests().at(-1);
    worker.reply({ type: "connection", connected: true, name: "AgentDock-A", rssi: -50 });
    worker.reply({ type: "result", id: req.id, ok: true, result: "ok" });
    await conn;

    const r1 = ch.refreshRssi();
    await Promise.resolve();
    const req2 = worker.requests().at(-1);
    expect(req2.op).toBe("refreshRssi");
    worker.reply({ type: "result", id: req2.id, ok: true, value: -42 });
    expect(await r1).toBe(-42);
    expect(ch.rssi).toBe(-42);

    /* worker 失败 → 沿用缓存 */
    const r2 = ch.refreshRssi();
    await Promise.resolve();
    worker.reply({ type: "result", id: worker.requests().at(-1).id, ok: false });
    expect(await r2).toBe(-42);
  });

  it("writeState: 未连接时不拉起 worker", async () => {
    const { ch } = makeChannel();
    await ch.writeState("busy");
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  /* 回归: 曾经在这里挂死 —— worker 不回 result, 而面板 await 了这个请求,
   * /dock 的 while 循环卡住后命令永不返回, 表现就是「用着用着打不开」 */
  it("writeState/writeSettings: 只发不等, 不依赖 worker 回包", async () => {
    const { ch } = makeChannel();
    const p = ch.scan();
    await Promise.resolve();
    worker.reply({ type: "result", id: worker.requests().at(-1).id, ok: true, devices: [] });
    await p;

    /* 同步返回布尔值: 调用方不会因为等回包而挂住 */
    expect(ch.writeState("busy")).toBe(true);
    expect(ch.writeSettings(70, 30)).toBe(true);
    expect(worker.requests().slice(-2).map((r) => r.op)).toEqual(["writeState", "writeSettings"]);
  });

  it("请求超时: worker 一直不回包也会 resolve, 不永久挂起", async () => {
    vi.useFakeTimers();
    try {
      const { ch } = makeChannel();
      const p = ch.scan(1000);
      await vi.advanceTimersByTimeAsync(1000 + 12000 + 100);
      await expect(p).resolves.toEqual([]); /* 超时 → ok=false → 空列表 */
    } finally {
      vi.useRealTimers();
    }
  });

  it("writeSettings: 已连接时下发亮度/音量, 未连接时不拉起 worker", async () => {
    const { ch } = makeChannel();
    await ch.writeSettings(80, 40);
    expect(fakeSpawn).not.toHaveBeenCalled();

    void ch.scan(); // 拉起 worker
    await Promise.resolve();
    worker.reply({ type: "result", id: worker.requests().at(-1).id, ok: true, devices: [] });

    ch.writeSettings(80, 40);
    expect(worker.requests().at(-1)).toMatchObject({
      op: "writeSettings",
      brightness: 80,
      volume: 40,
    });
  });

  it("spawn 参数: node + worker 路径, cwd 为插件目录", async () => {
    const { ch } = makeChannel();
    const p = ch.scan();
    await Promise.resolve();
    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = fakeSpawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe(process.execPath);
    expect(String(args[0])).toContain("ble-worker.mjs");
    expect(opts).toMatchObject({ env: process.env });

    const req = worker.requests().at(-1);
    worker.reply({ type: "result", id: req.id, ok: true, devices: [] });
    await p;
  });
});
