# Publishing to npm

`pi-plugin` is published as source: pi loads the TypeScript through jiti, so
there is no build step and `npm publish` ships the tarball as is.

## 1. Prerequisites

1. **An npm account**: <https://www.npmjs.com/signup>. The name
   `agentdock-pi-plugin` returns 404 on the public registry, so it is available.
2. **Two-factor auth**: npm requires it for publishing. Use an authenticator app
   and pass the 6-digit code with `--otp` when publishing.
3. **The right registry.** The default on this machine points at an internal mirror:

   ```bash
   npm config get registry
   # http://r.npm.sankuai.com
   ```

   Publishing there would make the package unreachable for
   `pi install npm:agentdock-pi-plugin`. Either pass
   `--registry https://registry.npmjs.com/` explicitly on every command, or bind
   a scope to the public registry once (`npm config set @htynkn:registry
   https://registry.npmjs.com/`). The package name has no scope, so it cannot be
   routed per package — always pass `--registry` when publishing by hand.

   `package-lock.json` already resolves against the public registry (the
   "Check lockfile registry" CI step enforces this), so no lockfile change is
   needed.

## 2. What the repository already sets up

`pi-plugin/package.json` carries everything publishing needs:

| Field | Purpose |
| --- | --- |
| `private` removed | npm refuses to publish otherwise |
| `files` | Ships only `index.ts / ble.ts / panel.ts / config.ts / scroll.ts / README.md / LICENSE` (~15 kB, no tests, no tsconfig) |
| `pi.extensions: ["./index.ts"]` | pi package manifest; the extension loads automatically after install |
| `keywords: ["pi-package", ...]` | Makes the package discoverable in the <https://pi.dev/packages> gallery |
| `peerDependencies` + `peerDependenciesMeta.optional` | `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are supplied by the pi host. Declared with `"*"`; must not live in `dependencies`, or pi warns about duplicate runtime modules |
| `dependencies: {"@stoprocent/noble"}` | Real runtime dependency (native BLE binding), installed with the package |
| `repository.directory: "pi-plugin"` | Correct source link from the npm page in this monorepo |
| `license` + `LICENSE` | MIT |
| `publishConfig.access: public` | Guards against publishing as private |
| `prepublishOnly` | Runs `typecheck` + `test` + `check:pack` before publishing and aborts on failure |

`npm run check:pack` (`scripts/check-pack.mjs`) inspects `npm pack --dry-run
--json` and fails if a required file is missing or a development file leaks into
the tarball.

## 3. First release

```bash
# 1. Log in to the public registry (prompts for a one-time password)
npm login --registry https://registry.npmjs.com/
npm whoami --registry https://registry.npmjs.com/

# 2. Local self-check: types + 45 unit tests + tarball contents
cd pi-plugin
npm ci --ignore-scripts
npm run typecheck && npm test && npm run check:pack

# 3. Publish
npm publish --registry https://registry.npmjs.com/ --otp=<6-digit code>

# 4. Verify
npm view agentdock-pi-plugin version --registry https://registry.npmjs.com/
```

After that, anyone can install it:

```bash
pi install npm:agentdock-pi-plugin        # personal scope (~/.pi/agent/settings.json)
pi install -l npm:agentdock-pi-plugin     # project scope (.pi/settings.json)
pi -e npm:agentdock-pi-plugin             # one-off trial, nothing written to settings
```

Record the release with a tag:

```bash
git tag pi-plugin-v0.1.0
git push origin pi-plugin-v0.1.0
```

## 4. Subsequent releases

```bash
cd pi-plugin
# move the Unreleased entries in CHANGELOG.md under a new version heading,
# then bump and publish
npm version patch|minor|major
npm publish --registry https://registry.npmjs.com/ --otp=<code>
git push --follow-tags
```

`npm version` rewrites `version` and creates a `vX.Y.Z` git tag; rename it to the
`pi-plugin-vX.Y.Z` form the release workflow expects:

```bash
git tag -d v0.1.1 && git tag pi-plugin-v0.1.1
```

Semantic versioning: bump `minor` for extension API changes or new runtime
dependencies, `major` for protocol or configuration breakage. Before 1.0 a
breaking change may land in a `minor` release, but say so in `CHANGELOG.md` and
the release notes.

## 5. Automated releases (Trusted Publishing)

`.github/workflows/release-pi-plugin.yml` publishes on every `pi-plugin-v*` tag.
It authenticates through npm Trusted Publishing (OIDC), so no `NPM_TOKEN` secret
is stored, and npm attaches a provenance statement automatically.

One-time setup:

1. npm package page → **Settings → Trusted Publisher → GitHub Actions**
2. Repository: `htynkn/agentdock`, workflow filename: `release-pi-plugin.yml`,
   environment: leave empty.

The workflow verifies that the tag matches `package.json`, then runs
`typecheck`, `test`, `check:pack` and `npm publish --provenance`. It needs npm CLI
>= 11.5.1 (`npm install --global npm@11` in the job) and Node >= 22.14.

Day-to-day flow:

```bash
cd pi-plugin
npm version minor
git tag -d v0.2.0 && git tag pi-plugin-v0.2.0
git push --follow-tags
```

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `403 You do not have permission to publish` | Name taken, or logged in to the wrong registry (`npm config get registry`) |
| `402 Payment Required` | Trying to publish a private package; `publishConfig.access` is already `public` |
| `EOTP` / `one-time password required` | Pass `--otp=<code>` |
| `Cannot find module '@stoprocent/noble'` after install | The native build was skipped (e.g. `--ignore-scripts`); run `npm rebuild @stoprocent/noble` |
| noble install fails on Linux | Missing Bluetooth headers: `sudo apt install libbluetooth-dev` (Debian/Ubuntu) |
| `@earendil-works/pi-tui` fails to resolve | Never put it in `dependencies`; the host maps it. A physical copy creates duplicate instances and triggers a pi warning |
| `pi install` succeeds but no extension loads | Check `pi.extensions` is `./index.ts` and the file is in the tarball (`npm run check:pack`) |
| Release workflow fails with `E404` / OIDC error | Trusted Publisher not configured, or the workflow filename does not match the npm settings |
