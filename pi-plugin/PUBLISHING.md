# 发布到 npm

`pi-plugin` 以源码形式发布：pi 用 jiti 直接加载 TypeScript，所以不需要构建步骤，
`npm publish` 就是发布 tarball。

## 一、发布前需要准备的东西

1. **npm 账号**（免费）：<https://www.npmjs.com/signup>
   包名 `agentdock-pi-plugin` 在公共 registry 上查询结果为 404，可用。
2. **2FA**：npm 现在强制要求发布者开启 two-factor auth（推荐 authenticator app，
   发布时输入 6 位 OTP）。
3. **确认 Example 用的 registry**。本机当前配置是美团内网源：

   ```bash
   npm config get registry
   # http://r.npm.sankuai.com
   ```

   往内网源发布是没人能通过 `pi install npm:agentdock-pi-plugin` 装到的。
   两种做法任选其一：

   - 每条命令显式加 `--registry https://registry.npmjs.com/`；
   - 或者给该包单独指定 registry（推荐，一次配置长期有效）：

     ```bash
     npm config set @htynkn:registry https://registry.npmjs.com/   # scoped 包
     # 非 scoped 包无法按包名单独路由，建议发布时始终带 --registry 参数
     ```

   `package-lock.json` 里的 `resolved` 已经是公共源（CI 里的
   "Check lockfile registry" 步骤会强制校验），所以发布前不用改 lockfile。

## 二、已在仓库中做好的准备

`pi-plugin/package.json` 现在包含发布所需的全部字段：

| 字段 | 作用 |
| --- | --- |
| `private` 已删除 | 否则 npm 拒绝发布 |
| `files` | 只发 `index.ts / ble.ts / panel.ts / config.ts / scroll.ts / README.md / LICENSE`（约 15 kB，不含测试与 tsconfig） |
| `pi.extensions: ["./index.ts"]` | pi 包清单，安装后自动加载该扩展 |
| `keywords: ["pi-package", ...]` | 进入 <https://pi.dev/packages> 画廊发现列表 |
| `peerDependencies` + `peerDependenciesMeta.optional` | `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 由 pi 宿主提供（声明为 `"*"`，不得放进 `dependencies`，否则会被 pi 告警） |
| `dependencies: {"@stoprocent/noble"}` | 真实运行时依赖（native BLE 绑定），随包安装 |
| `repository.directory: "pi-plugin"` | monorepo 子目录，npm 页面能正确链接到源码 |
| `license` + `LICENSE` | MIT，从仓库根目录复制 |
| `publishConfig.access: public` | 防止误发成私有 |
| `prepublishOnly` | 发布前自动跑 `typecheck` + `test`，失败即中止 |

## 三、首次发布

```bash
# 1. 登录公共 registry（会提示输入 OTP）
npm login --registry https://registry.npmjs.com/
npm whoami --registry https://registry.npmjs.com/

# 2. 本地自检：类型检查 + 45 个单测 + 打包清单
cd pi-plugin
npm ci --ignore-scripts
npm run typecheck && npm test
npm pack --dry-run --registry https://registry.npmjs.com/

# 3. 发布
npm publish --registry https://registry.npmjs.com/ --otp=<6位验证码>

# 4. 验证
npm view agentdock-pi-plugin version --registry https://registry.npmjs.com/
```

发布成功后，任何人都可以：

```bash
pi install npm:agentdock-pi-plugin        # 个人 scope（~/.pi/agent/settings.json）
pi install -l npm:agentdock-pi-plugin     # 项目 scope（.pi/settings.json）
pi -e npm:agentdock-pi-plugin             # 单次试用，不写入 settings
```

打 tag 记录这次发布：

```bash
git tag pi-plugin-v0.1.0
git push origin pi-plugin-v0.1.0
```

## 四、后续版本

```bash
cd pi-plugin
npm run typecheck && npm test
npm version patch|minor|major   # 自动改 version 并打 git tag（package scope 下 tag 为 v0.1.1）
npm publish --registry https://registry.npmjs.com/ --otp=<code>
git push --follow-tags
```

语义化建议：pi 扩展 API 变动或需要重新装依赖时升 `minor`，协议/配置不兼容时升
`major`（1.0 之前可以在 `minor` 里做破坏性变更，但要在 CHANGELOG/Release notes 写清楚）。

## 五、可选：用 GitHub Actions 自动发布（recommended）

用 npm 的 Trusted Publishing（OIDC，无需保存 token，自动附带 provenance 证明）：

1. npm 包页面 → **Settings → Trusted Publisher → GitHub Actions**，填
   `htynkn/agentdock`、workflow 文件名 `release-pi-plugin.yml`、environment 留空。
2. 添加 `.github/workflows/release-pi-plugin.yml`：

```yaml
name: Release pi-plugin

on:
  push:
    tags: ["pi-plugin-v*"]

permissions:
  contents: read
  id-token: write # Trusted Publishing 必需

jobs:
  publish:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: pi-plugin
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          registry-url: https://registry.npmjs.com
          cache: npm
          cache-dependency-path: pi-plugin/package-lock.json
      - run: npm install --global npm@11
      - run: npm ci --ignore-scripts --no-audit --no-fund
      - run: npm run typecheck && npm test
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }} # Trusted Publishing 时可删除
```

标签发布流程就变成：`git tag pi-plugin-v0.1.1 && git push origin pi-plugin-v0.1.1`。

## 六、常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `403 You do not have permission to publish` | 包名被占用，或没登录到公共 registry（检查 `npm config get registry`） |
| `402 Payment Required` | 试图发布成私有 scope 包，`publishConfig.access` 已设为 `public` |
| `EOTP` / `one-time password required` | 加 `--otp=<code>` |
| 用户安装后 BLE 报错 `Cannot find module '@stoprocent/noble'` | 安装时跳过了构建脚本（如 `--ignore-scripts`）；让用户在 `pi install` 前直接用 `npm rebuild @stoprocent/noble` 重装该 native 依赖 |
| Linux 上安装 noble 失败 | 缺蓝牙头文件：`sudo apt install libbluetooth-dev`（Debian/Ubuntu） |
| 读不到 `@earendil-works/pi-tui` | 一定不要把它写进 `dependencies`；宿主会做模块映射，写进 `dependencies` 会产生重复实例并触发 pi 告警 |
| 发布后 `pi install` 找不到扩展 | 检查 `pi.extensions` 路径是否为 `./index.ts`，以及 `files` 是否把该文件打进去（`npm pack --dry-run` 可验证） |
