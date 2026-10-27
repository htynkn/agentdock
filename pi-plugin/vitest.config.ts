import { defineConfig } from "vitest/config";

/*
 * 单测跑在 node 环境: 被测模块里带 .js 扩展名的 TS 相对导入
 * (如 ./config.js → config.ts) 由 vitest 内置解析处理, 与 pi 的 jiti 行为一致.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // 不加载真实 BLE 原生模块的副作用
    pool: "forks",
  },
});
