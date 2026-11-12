/*
 * ble.ts — 智坞 AgentDock BLE 通道 (IPC 客户端)
 *
 * 职责: 管理 BLE worker 子进程, 转发扫描/连接/写状态请求, 上抛设备事件.
 * noble 实际运行在 ble-worker.mjs 子进程内 —— 原因: noble 在 pi 主进程中
 * 扫描正常但 connectAsync 挂起 (macOS CoreBluetooth 回调路径与 pi 运行时
 * 冲突, pi 1.4.0/1.5.0 均复现; 同样代码在独立 node 进程 1~2s 连上),
 * 子进程隔离后连接稳定, 且 noble 原生层崩溃不再波及 pi.
 *
 * 对外接口与旧版 (进程内 noble) 完全一致, index.ts / panel.ts 无感知.
 * 与固件 deck.c 的 UUID 定义一一对应.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UUID_SVC = "8e7c1a10c0de4b1e9f6a000000000001";
export const NAME_PREFIX = "AgentDock-";

export interface DeckPeripheralInfo {
  name: string;
  rssi: number;
}

type Log = (...args: unknown[]) => void;

/** 请求默认超时: 任何一个 op 卡住都不能让调用方 (面板) 永久挂起 */
const REQUEST_TIMEOUT_MS = 12000;

interface PendingRequest {
  resolve: (v: any) => void;
}

export class DeckChannel {
  private log: Log;
  private worker: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextReqId = 1;
  private stdinBuf = "";
  private _connected = false;
  private _deviceName = "";
  private _rssi: number | null = null;
  private disposed = false;
  private _connecting = false;
  private connListeners = new Set<(connected: boolean) => void>();

  constructor(
    private onEvent: (msg: any) => void,
    private onConnection: (connected: boolean) => void,
    log: Log = (...a) => console.log(...a),
  ) {
    this.log = log;
  }

  get connected(): boolean {
    return this._connected;
  }

  get deviceName(): string {
    return this._deviceName;
  }

  /** 是否有连接尝试进行中 (重连调度用, 避免重叠尝试) */
  get connecting(): boolean {
    return this._connecting;
  }

  /** 缓存的信号强度 (连接时记录, refreshRssi 更新) */
  get rssi(): number | null {
    return this._rssi;
  }

  /** 订阅连接状态变化 (面板等 UI 用); 返回退订函数 */
  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connListeners.add(cb);
    return () => {
      this.connListeners.delete(cb);
    };
  }

  private emitConnection(connected: boolean): void {
    this.onConnection(connected);
    for (const cb of this.connListeners) {
      try {
        cb(connected);
      } catch {
        /* 监听器异常不影响连接流程 */
      }
    }
  }

  /* ---------------- worker 进程管理 ---------------- */

  private workerPath(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "ble-worker.mjs");
  }

  private ensureWorker(): ChildProcess {
    if (this.worker && !this.worker.killed && this.worker.exitCode === null) {
      return this.worker;
    }
    const child = spawn(process.execPath, [this.workerPath()], {
      cwd: dirname(this.workerPath()),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.worker = child;
    this.disposed = false;

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.stdinBuf += chunk;
      let idx: number;
      while ((idx = this.stdinBuf.indexOf("\n")) >= 0) {
        const line = this.stdinBuf.slice(0, idx).trim();
        this.stdinBuf = this.stdinBuf.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          this.log("worker 输出无法解析:", line.slice(0, 120));
          continue;
        }
        this.handleWorkerMessage(msg);
      }
    });

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      /* worker 崩溃时的堆栈等诊断信息 */
      this.log("[worker-stderr]", chunk.trimEnd());
    });

    child.on("exit", (code, signal) => {
      if (this.worker === child) this.worker = null;
      /* 进程退出 = 通道死亡, 未决请求全部了结, 连接状态归位 */
      for (const [id, p] of this.pending) {
        p.resolve({ __workerDead: true });
        this.pending.delete(id);
      }
      if (this._connected || this._connecting) {
        this._connected = false;
        this._connecting = false;
        this.emitConnection(false);
      }
      if (!this.disposed) {
        this.log(`worker 退出 (code=${code} signal=${signal})`);
      }
    });

    return child;
  }

  private handleWorkerMessage(msg: any): void {
    switch (msg.type) {
      case "log":
        this.log(...(msg.args ?? []));
        break;
      case "event":
        try {
          this.onEvent(msg.msg);
        } catch {
          /* 上抛层异常不影响通道 */
        }
        break;
      case "connection":
        this._connected = !!msg.connected;
        this._deviceName = msg.connected ? String(msg.name ?? "") : "";
        this._rssi = msg.connected
          ? (typeof msg.rssi === "number" ? msg.rssi : this._rssi)
          : null;
        this.emitConnection(this._connected);
        break;
      default:
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
        /* 其余未知消息忽略 */
        break;
    }
  }

  /** 发送请求并等待 result 消息 (按 id 关联) */
  /** 发送请求但不等待结果 (fire-and-forget: 写状态/写设置) */
  private send(op: string, extra: Record<string, unknown> = {}): boolean {
    const child = this.ensureWorker();
    const stdin = child.stdin;
    if (!stdin || !stdin.writable) return false;
    try {
      stdin.write(JSON.stringify({ op, ...extra }) + "\n");
      return true;
    } catch (e) {
      this.log("worker 写入失败:", e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  /**
   * 发送请求并等待 result 消息 (按 id 关联).
   *
   * 必须带超时: worker 不回包 (旧版 writeState 就不回) 或已经卡住时,
   * 裸等 pending 会让调用方永久挂起 —— /dock 面板的 while 循环由这种 await
   * 驱动, 一旦挂住整个命令就不再返回, 表现就是「/dock 用着用着打不开」。
   */
  private request(
    op: string,
    extra: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<any> {
    const child = this.ensureWorker();
    const stdin = child.stdin;
    if (!stdin || !stdin.writable) {
      return Promise.resolve({ ok: false, error: "worker stdin 不可用" });
    }
    const id = this.nextReqId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.log(`worker 请求超时 (${op}, ${timeoutMs}ms)`);
          resolve({ ok: false, error: `${op} 超时` });
        }
      }, timeoutMs);
      timer.unref?.(); // 超时守卫不应拖住进程退出
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
      try {
        stdin.write(JSON.stringify({ op, id, ...extra }) + "\n");
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  }

  /* ---------------- 公共 API (与旧版进程内 noble 保持一致) ---------------- */

  /** 扫描所有 AgentDock 设备 (不连接), 返回按信号强度排序的列表 */
  async scan(timeoutMs = 8000): Promise<DeckPeripheralInfo[]> {
    /* 扫描本身要 timeoutMs, 再加分析与回包余量 */
    const res = await this.request("scan", { ms: timeoutMs }, timeoutMs + REQUEST_TIMEOUT_MS);
    if (!res.ok || res.__workerDead) return [];
    const devices: DeckPeripheralInfo[] = (res.devices ?? [])
      .filter((d: any) => typeof d?.name === "string" && typeof d?.rssi === "number")
      .map((d: any) => ({ name: d.name, rssi: d.rssi }));
    return devices.sort((a, b) => b.rssi - a.rssi);
  }

  /**
   * 连接指定设备 (或唯一发现的设备). 成功后自动订阅并回调 onConnection(true).
   * 期间已有连接则先断开.
   */
  async connect(preferredName: string): Promise<"ok" | "not_found" | "failed"> {
    if (this._connecting) return "failed";
    this._connecting = true;
    try {
      const res = await this.request("connect", { name: preferredName ?? "" }, 30000);
      if (!res.ok || res.__workerDead) return "failed";
      const result = res.result;
      if (result !== "ok" && result !== "not_found" && result !== "failed") {
        return "failed";
      }
      return result;
    } finally {
      this._connecting = false;
    }
  }

  /** 主动读取已连接设备的 RSSI; 失败/超时返回缓存值 (无缓存 = null) */
  async refreshRssi(timeoutMs = 1500): Promise<number | null> {
    const res = await this.request("refreshRssi", {}, timeoutMs + 3000);
    if (!res.ok || res.__workerDead) return this._rssi;
    return typeof res.value === "number" ? (this._rssi = res.value) : this._rssi;
  }

  /**
   * 向 STATE char 写 agent 状态 (驱动设备 LED).
   *
   * 只发不等: worker 侧写入成功后已无需回包, 而后台任务没必要为了一个 notify
   * 阻塞面板 —— 这是「/dock 打不开」那个死锁的根源.
   */
  writeState(state: string): boolean {
    if (!this.worker) return false; /* 未连接时静默跳过 (与旧行为一致) */
    return this.send("writeState", { state });
  }

  /** 向 STATE char 写亮度/音量 (0~100, 设备侧落 NVS 并立即生效); 同样只发不等 */
  writeSettings(brightness: number, volume: number): boolean {
    if (!this.worker) return false;
    return this.send("writeSettings", { brightness, volume });
  }

  dispose(): void {
    this.disposed = true;
    const child = this.worker;
    this.worker = null;
    this._connected = false;
    this._connecting = false;
    if (child) {
      const stdin = child.stdin;
      if (stdin && stdin.writable) {
        try {
          stdin.write(JSON.stringify({ op: "dispose" }) + "\n");
          stdin.end();
        } catch {
          /* worker 可能已退出 */
        }
      }
      child.kill();
      for (const [, p] of this.pending) p.resolve({ __workerDead: true });
      this.pending.clear();
    }
    this.emitConnection(false);
  }
}
