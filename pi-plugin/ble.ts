/*
 * ble.ts — 智坞 AgentDock BLE 通道 (noble central)
 *
 * 职责: 扫描/连接/断线重连/特征订阅, 上抛事件给 app 层.
 * 与固件 deck.c 的 UUID 定义一一对应.
 */
import Noble from "@stoprocent/noble";

export const UUID_SVC = "8e7c1a10c0de4b1e9f6a000000000001";
const UUID_EVENT = "8e7c1a10c0de4b1e9f6a000000000002";
const UUID_STATE = "8e7c1a10c0de4b1e9f6a000000000003";

export const NAME_PREFIX = "AgentDock-";

const SCAN_TIMEOUT_MS = 12000;

export interface DeckPeripheralInfo {
  name: string;
  rssi: number;
}

type Log = (...args: unknown[]) => void;

/** 等待蓝牙适配器可用; 返回 false = 不可用 (权限/未开启) */
async function waitForBluetooth(timeoutMs = 8000): Promise<boolean> {
  if (Noble.state === "poweredOn") return true;
  const ok = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => { Noble.removeListener("stateChange", h); resolve(false); }, timeoutMs);
    const h = (s: string) => {
      if (s === "poweredOn") { clearTimeout(timer); Noble.removeListener("stateChange", h); resolve(true); }
    };
    Noble.on("stateChange", h);
  });
  return ok;
}

export class DeckChannel {
  private log: Log;
  private peripheral: any = null;
  private eventChar: any = null;
  private stateChar: any = null;
  private disposed = false;
  private connecting = false;
  private lastRssi: number | null = null;
  private connListeners = new Set<(connected: boolean) => void>();

  constructor(private onEvent: (msg: any) => void, private onConnection: (connected: boolean) => void, log: Log = (...a) => console.log(...a)) {
    this.log = log;
  }

  get connected(): boolean {
    return this.peripheral !== null && this.stateChar !== null;
  }

  get deviceName(): string {
    return this.peripheral?.advertisement?.localName ?? "";
  }

  /** 缓存的信号强度 (连接时记录, refreshRssi 更新) */
  get rssi(): number | null {
    return this.lastRssi;
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

  /** 主动读取已连接设备的 RSSI; 失败/超时返回缓存值 (无缓存 = null) */
  async refreshRssi(timeoutMs = 1500): Promise<number | null> {
    const p: any = this.peripheral;
    if (!p || typeof p.updateRssiAsync !== "function") return this.lastRssi;
    try {
      const v = await Promise.race([
        p.updateRssiAsync(),
        new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
      ]);
      if (typeof v === "number") {
        this.lastRssi = v;
        return v;
      }
    } catch {
      /* 读取失败沿用缓存值 */
    }
    return this.lastRssi;
  }

  /** 扫描所有 AgentDock 设备 (不连接), 返回按信号强度排序的列表 */
  async scan(timeoutMs = 8000): Promise<DeckPeripheralInfo[]> {
    if (!(await waitForBluetooth())) {
      this.log("蓝牙不可用: 检查系统蓝牙开关, 以及终端 App 的蓝牙权限 (系统设置→隐私与安全→蓝牙)");
      return [];
    }
    Noble.startScanning([], false);
    const found = new Map<string, DeckPeripheralInfo>();
    const onDiscover = (p: any) => {
      const name: string = p.advertisement?.localName ?? "";
      if (!name.startsWith(NAME_PREFIX)) return;
      const prev = found.get(name);
      if (!prev || p.rssi > prev.rssi) {
        found.set(name, { name, rssi: p.rssi });
      }
    };
    Noble.on("discover", onDiscover);
    await new Promise((r) => setTimeout(r, timeoutMs));
    Noble.removeListener("discover", onDiscover);
    Noble.stopScanning();
    return [...found.values()].sort((a, b) => b.rssi - a.rssi);
  }

  /**
   * 连接指定设备 (或唯一发现的设备). 成功后自动订阅并回调 onConnection(true).
   * 期间已有连接则先断开.
   */
  async connect(preferredName: string): Promise<"ok" | "not_found" | "failed"> {
    if (this.connecting) return "failed";
    this.connecting = true;
    try {
      this.disposeLink();
      const devices = await this.scan();
      if (this.disposed) return "failed";
      let target: DeckPeripheralInfo | undefined;
      if (preferredName) {
        target = devices.find((d) => d.name === preferredName);
      } else if (devices.length === 1) {
        target = devices[0];
      } else if (devices.length > 1) {
        target = devices[0];   // 多设备未指定: 取信号最强的, /deck 可改绑
      }
      if (!target) {
        this.log(`未发现设备 (${devices.length ? "目标不在列表" : "列表为空"})`);
        return "not_found";
      }
      this.log(`连接 ${target.name} (rssi ${target.rssi}) ...`);
      const p: any = await this.findAndConnect(target.name);
      if (!p) {
        this.log("GAP 连接失败 (findAndConnect 返回空)");
        return "failed";
      }

      this.peripheral = p;
      this.lastRssi = typeof target.rssi === "number" ? target.rssi : null;
      /* noble 会缓存同一外设/特征的对象实例。重连时若不先清空旧监听器，
       * disconnect / data 监听会逐次叠加 → 一次按键事件被重复投递 N 次
       * （重连过几次就重复几份）。这是“按一下发多条消息”的根因。 */
      p.removeAllListeners("disconnect");
      p.once("disconnect", () => {
        if (this.disposed) return;
        this.log("设备断开");
        this.disposeLink();
        this.emitConnection(false);
      });

      this.log("发现服务/特征 ...");
      const { services, characteristics } = await p.discoverSomeServicesAndCharacteristicsAsync(
        [], [UUID_EVENT, UUID_STATE]
      );
      this.log("services:", services?.map((s: any) => s.uuid).join(","),
               "chars:", characteristics?.map((c: any) => c.uuid).join(","));
      const byUuid = (u: string) => characteristics.find((c: any) => c.uuid.replace(/-/g, "").toLowerCase() === u);
      this.eventChar = byUuid(UUID_EVENT);
      this.stateChar = byUuid(UUID_STATE);
      if (!this.eventChar || !this.stateChar) {
        this.log("GATT 特征缺失");
        this.disposeLink();
        return "failed";
      }
      this.eventChar.removeAllListeners("data");
      this.eventChar.on("data", (raw: Buffer) => {
        try {
          this.onEvent(JSON.parse(raw.toString("utf8")));
        } catch {
          this.log("非法事件报文:", raw.toString("hex"));
        }
      });
      await this.eventChar.subscribeAsync();
      this.log(`已连接 ${target.name}`);
      this.emitConnection(true);
      return "ok";
    } catch (e) {
      this.log("连接异常:", e instanceof Error ? e.message : e);
      this.disposeLink();
      return "failed";
    } finally {
      this.connecting = false;
    }
  }

  private async findAndConnect(name: string): Promise<any> {
    Noble.startScanning([], false);
    try {
      const p: any = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); resolve(null); }, 8000);
        const onDiscover = async (d: any) => {
          if (d.advertisement?.localName !== name) return;
          cleanup();
          Noble.stopScanning();
          try {
            await d.connectAsync();
            resolve(d);
          } catch (e) { reject(e); }
        };
        const cleanup = () => {
          clearTimeout(timer);
          Noble.removeListener("discover", onDiscover);
        };
        Noble.on("discover", onDiscover);
      });
      return p;
    } catch {
      Noble.stopScanning();
      return null;
    }
  }

  /** 向 STATE char 写 agent 状态 (驱动设备 LED) */
  async writeState(state: string): Promise<void> {
    if (!this.stateChar) return;
    try {
      await this.stateChar.writeAsync(Buffer.from(JSON.stringify({ t: "s", st: state }), "utf8"), false);
    } catch (e) {
      this.log("状态写入失败:", e);
    }
  }

  private disposeLink(): void {
    this.eventChar = null;
    this.stateChar = null;
    this.lastRssi = null;
    if (this.peripheral) {
      try { this.peripheral.removeAllListeners("disconnect"); } catch {}
      try { this.peripheral.disconnect(); } catch {}
      this.peripheral = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    Noble.stopScanning();
    this.disposeLink();
  }
}
