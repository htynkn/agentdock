// BLE 诊断: 无过滤扫描 12 秒, 打印所有可见设备
// 运行: node scan-test.mjs
import Noble from "@stoprocent/noble";

console.log("noble 初始状态:", Noble.state);

Noble.on("stateChange", (state) => {
  console.log("状态变化:", state);
  if (state === "poweredOn") {
    console.log("开始无过滤扫描 12s ...");
    Noble.startScanning([], false);
    setTimeout(() => {
      console.log("扫描结束");
      Noble.stopScanning();
      process.exit(0);
    }, 12000);
  }
});

Noble.on("discover", (p) => {
  const name = p.advertisement?.localName || "(无名)";
  const uuids = (p.advertisement?.serviceUuids || []).join(",");
  console.log(`发现: ${name}  rssi=${p.rssi}  uuids=${uuids}`);
});

if (Noble.state === "poweredOn") {
  Noble.emit("stateChange", "poweredOn");
}
