/*
 * ble-worker.mjs — BLE 子进程 worker (noble central)
 *
 * 为什么是子进程: noble 在 pi 主进程内扫描正常但 connectAsync 挂起
 * (macOS CoreBluetooth 经 xpc-connection 的回调路径与 pi 的模块加载
 * 运行时冲突, 1.4.0/1.5.0 均复现); 同样的代码在独立 node 进程内
 * 1~2s 即连上。因此 BLE 全部逻辑搬到本 worker, 主进程只走 IPC。
 *
 * 协议 (stdin/stdout, 每行一个 JSON):
 *   主 → worker: { "op": "scan", "id": 1, "ms": 8000 }
 *              | { "op": "connect", "id": 2, "name": "AgentDock-XX" }
 *              | { "op": "writeState", "state": "busy" }
 *              | { "op": "writeSettings", "brightness": 80, "volume": 60 }
 *              | { "op": "refreshRssi", "id": 3 }
 *              | { "op": "dispose" }
 *   worker → 主: { "type": "log", "args": [...] }
 *              | { "type": "event", "msg": {...} }               (设备事件)
 *              | { "type": "connection", "connected": bool, "name": "..." }
 *              | { "type": "result", "id": 1, "ok": true, "devices": [...] }
 *              | { "type": "result", "id": 2, "ok": true, "result": "ok" }
 *
 * worker 与固件 deck.c 的 UUID 定义一一对应。
 */
import Noble from "@stoprocent/noble";

const UUID_SVC = "8e7c1a10c0de4b1e9f6a000000000001";
const UUID_EVENT = "8e7c1a10c0de4b1e9f6a000000000002";
const UUID_STATE = "8e7c1a10c0de4b1e9f6a000000000003";
const NAME_PREFIX = "AgentDock-";
const SCAN_CACHE_MS = 3000;
const CONNECT_TIMEOUT_MS = 10000;
const GATT_TIMEOUT_MS = 10000;
const SUBSCRIBE_TIMEOUT_MS = 5000;

/* ---- 基础设施 ---- */

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const log = (...args) => send({ type: "log", args: args.map(String) });

function raceTimeout(p, ms) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
}

async function waitForBluetooth(timeoutMs = 8000) {
  if (Noble.state === "poweredOn") return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      Noble.removeListener("stateChange", h);
      resolve(false);
    }, timeoutMs);
    const h = (s) => {
      if (s === "poweredOn") {
        clearTimeout(timer);
        Noble.removeListener("stateChange", h);
        resolve(true);
      }
    };
    Noble.on("stateChange", h);
  });
}

/* ---- 连接状态 ---- */

let peripheral = null;
let eventChar = null;
let stateChar = null;
let disposed = false;
let connecting = false;
let lastRssi = null;
let scanCache = null;

const deviceName = () => peripheral?.advertisement?.localName ?? "";

function disposeLink() {
  eventChar = null;
  stateChar = null;
  lastRssi = null;
  if (peripheral) {
    try { peripheral.removeAllListeners("disconnect"); } catch {}
    try { peripheral.disconnect(); } catch {}
    peripheral = null;
  }
}

function emitConnection(connected) {
  send({ type: "connection", connected, name: connected ? deviceName() : "", rssi: lastRssi });
}

/* ---- 扫描 ---- */

async function scan(ms = 8000) {
  const cached = scanCache;
  if (cached && Date.now() - cached.at < SCAN_CACHE_MS) return cached.devices;
  if (!(await waitForBluetooth())) {
    log("蓝牙不可用: 检查系统蓝牙开关, 以及终端 App 的蓝牙权限 (系统设置→隐私与安全→蓝牙)");
    return [];
  }
  Noble.startScanning([], false);
  const found = new Map();
  const onDiscover = (p) => {
    const name = p.advertisement?.localName ?? "";
    if (!name.startsWith(NAME_PREFIX)) return;
    const prev = found.get(name);
    if (!prev || p.rssi > prev.rssi) {
      /* 缓存外设对象: connect 直接对它发起连接, 不再二次扫描
       * (macOS 重启扫描后 duplicate filter 常不再上报同一外设) */
      found.set(name, { name, rssi: p.rssi, peripheral: p });
    }
  };
  Noble.on("discover", onDiscover);
  await new Promise((r) => setTimeout(r, ms));
  Noble.removeListener("discover", onDiscover);
  Noble.stopScanning();
  const devices = [...found.values()]
    .map(({ name, rssi }) => ({ name, rssi }))
    .sort((a, b) => b.rssi - a.rssi);
  scanCache = { at: Date.now(), devices, peripherals: [...found.values()] };
  return devices;
}

/* ---- 连接 ---- */

async function connectPeripheral(d) {
  try {
    /* connectAsync 成功时 resolve 的是 undefined (noble promisify 语义),
     * 必须 .then(() => true) 归一化, 否则 "连接成功"会被 !ok 误判为超时,
     * 紧接着的 disconnectAsync 把刚建立的连接取消 —— 表现为永远连不上 */
    const ok = await raceTimeout(d.connectAsync().then(() => true), CONNECT_TIMEOUT_MS);
    if (!ok) {
      log(`connectAsync 超时 (>${CONNECT_TIMEOUT_MS}ms), 取消挂起连接`);
      void d.disconnectAsync?.().catch(() => {});
      return null;
    }
    return d;
  } catch (e) {
    log("connectAsync 拒绝:", e?.message ?? e);
    return null;
  }
}

async function findAndConnect(name) {
  /* 回退路径: allowDuplicates=true, 保证重启扫描后能重新上报已知外设 */
  Noble.startScanning([], true);
  try {
    const p = await new Promise((resolve) => {
      const timer = setTimeout(() => { cleanup(); resolve(null); }, 8000);
      const onDiscover = async (d) => {
        if (d.advertisement?.localName !== name) return;
        cleanup();
        Noble.stopScanning();
        const p = await connectPeripheral(d);
        resolve(p);
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

async function connect(preferredName) {
  if (connecting) return "failed";
  connecting = true;
  /* 显式 connect 复活通道 (与 dispose 后重连的语义一致) */
  disposed = false;
  try {
    disposeLink();
    const devices = await scan();
    if (disposed) return "failed";
    let target;
    if (preferredName) {
      const hit = scanCache?.peripherals?.find((d) => d.name === preferredName);
      target = hit ?? devices.find((d) => d.name === preferredName);
    } else if (devices.length >= 1) {
      /* 未指定: 唯一设备或最强信号 (多台时 /deck 可改绑) */
      const hit = scanCache?.peripherals?.[0];
      target = hit ?? devices[0];
    }
    if (!target) {
      log(`未发现设备 (${devices.length ? "目标不在列表" : "列表为空"})`);
      return "not_found";
    }
    const name = target.name;
    log(`连接 ${name} (rssi ${target.rssi}) ...`);
    /* 优先直连扫描缓存的外设对象 (已验证的可靠路径), 失败回退重扫 */
    let p = target.peripheral ? await connectPeripheral(target.peripheral) : null;
    if (!p) p = await findAndConnect(name);
    if (!p) {
      log("GAP 连接失败 (8s 内未重新发现设备或连接被拒)");
      return "failed";
    }

    peripheral = p;
    lastRssi = typeof target.rssi === "number" ? target.rssi : null;
    /* noble 缓存同一外设的对象实例, 重连须清旧监听, 否则事件重复投递 */
    p.removeAllListeners("disconnect");
    p.once("disconnect", () => {
      if (disposed) return;
      log("设备断开");
      disposeLink();
      emitConnection(false);
    });

    log("发现服务/特征 ...");
    const gatt = await raceTimeout(
      p.discoverSomeServicesAndCharacteristicsAsync([], [UUID_EVENT, UUID_STATE]),
      GATT_TIMEOUT_MS,
    );
    if (!gatt) {
      log(`GATT 发现超时 (>${GATT_TIMEOUT_MS}ms)`);
      disposeLink();
      return "failed";
    }
    const { services, characteristics } = gatt;
    log("services:", (services ?? []).map((s) => s.uuid).join(","),
        "chars:", (characteristics ?? []).map((c) => c.uuid).join(","));
    const byUuid = (u) =>
      (characteristics ?? []).find((c) => c.uuid.replace(/-/g, "").toLowerCase() === u);
    eventChar = byUuid(UUID_EVENT);
    stateChar = byUuid(UUID_STATE);
    if (!eventChar || !stateChar) {
      log("GATT 特征缺失");
      disposeLink();
      return "failed";
    }
    eventChar.removeAllListeners("data");
    eventChar.on("data", (raw) => {
      try {
        send({ type: "event", msg: JSON.parse(raw.toString("utf8")) });
      } catch {
        log("非法事件报文:", raw.toString("hex"));
      }
    });
    const sub = await raceTimeout(eventChar.subscribeAsync().then(() => true), SUBSCRIBE_TIMEOUT_MS);
    if (!sub) {
      log(`特征订阅超时 (>${SUBSCRIBE_TIMEOUT_MS}ms)`);
      disposeLink();
      return "failed";
    }
    log(`已连接 ${name}`);
    emitConnection(true);
    return "ok";
  } catch (e) {
    log("连接异常:", e?.message ?? e);
    disposeLink();
    return "failed";
  } finally {
    connecting = false;
  }
}

/* ---- 其他操作 ---- */

async function refreshRssi() {
  if (!peripheral || typeof peripheral.updateRssiAsync !== "function") return lastRssi;
  try {
    const v = await Promise.race([
      peripheral.updateRssiAsync(),
      new Promise((r) => setTimeout(() => r(null), 1500)),
    ]);
    if (typeof v === "number") lastRssi = v;
  } catch { /* 读取失败沿用缓存值 */ }
  return lastRssi;
}

async function writeState(state) {
  if (!stateChar) return;
  try {
    await stateChar.writeAsync(Buffer.from(JSON.stringify({ t: "s", st: state }), "utf8"), false);
  } catch (e) {
    log("状态写入失败:", e?.message ?? e);
  }
}

/** 亮度/音量 (0~100): 设备侧落 NVS, 立即生效 */
async function writeSettings(brightness, volume) {
  if (!stateChar) return;
  try {
    await stateChar.writeAsync(
      Buffer.from(JSON.stringify({ t: "cfg", b: brightness, v: volume }), "utf8"),
      false,
    );
  } catch (e) {
    log("设置写入失败:", e?.message ?? e);
  }
}

/* ---- 命令循环 ---- */

/* WORKER_DIRECT=1: 跳过 stdin 协议, 直接跑一次 scan+connect (诊断模式,
 * 与纯脚本对照可分离 "worker 代码" 与 "stdin 协议循环" 两个变量) */
const DIRECT = process.env.WORKER_DIRECT === "1";

let stdinBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (DIRECT) return;
  stdinBuf += chunk;
  let idx;
  while ((idx = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, idx).trim();
    stdinBuf = stdinBuf.slice(idx + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      log("非法请求:", line.slice(0, 120));
      continue;
    }
    void handle(req);
  }
});

if (DIRECT) {
  const t0 = Date.now();
  log("[direct] 开始直连测试");
  const r = await connect("");
  log(`[direct] connect → ${r} (${Date.now() - t0}ms)`);
  if (r === "ok") {
    await new Promise((r2) => setTimeout(r2, 1500));
    log("[direct] 保持连接 1.5s 后退出");
  }
  process.exit(0);
}

async function handle(req) {
  try {
    switch (req.op) {
      case "scan": {
        const devices = await scan(req.ms ?? 8000);
        send({ type: "result", id: req.id, ok: true, devices });
        break;
      }
      case "connect": {
        const result = await connect(req.name ?? "");
        send({ type: "result", id: req.id, ok: true, result });
        break;
      }
      case "writeState":
        await writeState(req.state);
        break;
      case "writeSettings":
        await writeSettings(req.brightness, req.volume);
        break;
      case "refreshRssi": {
        const value = await refreshRssi();
        send({ type: "result", id: req.id, ok: true, value });
        break;
      }
      case "dispose":
        disposed = true;
        try { Noble.stopScanning(); } catch {}
        disposeLink();
        send({ type: "result", id: req.id, ok: true });
        break;
      default:
        send({ type: "result", id: req.id, ok: false, error: `未知 op: ${req.op}` });
    }
  } catch (e) {
    send({ type: "result", id: req.id, ok: false, error: e?.message ?? String(e) });
  }
}

/* 诊断演化说明: 本模块曾是子进程方案的设计起点, 主进程 (ble.ts) 通过
 * spawn 启动本文件, 协议见文件头注释。 */
