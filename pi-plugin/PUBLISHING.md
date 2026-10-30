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

## 4. Subsequent releases: push a tag

After 0.1.0 exists on npm and the Trusted Publisher is configured (see
section 5), releasing is one action:

```bash
git tag pi-plugin-v0.1.1
git push origin pi-plugin-v0.1.1
```

That is it. The workflow derives the version from the tag, writes it into
`package.json`, runs `typecheck` + `test` + `check:pack`, and publishes with
provenance. No local `npm version`, no `npm publish`, no OTP.

Before tagging, move the `Unreleased` entries in `CHANGELOG.md` under the new
version heading and commit that on `master`.

A prerelease tag such as `pi-plugin-v0.2.0-beta.1` is published under the `next`
dist-tag, so `pi install npm:agentdock-pi-plugin` keeps resolving to `latest`
until a stable version is tagged.

`npm version patch|minor|major` still works if you prefer it: `pi-plugin/.npmrc`
sets `tag-version-prefix=pi-plugin-v`, so it creates the same tag form and
`git push --follow-tags` releases it.

Semantic versioning: bump `minor` for extension API changes or new runtime
dependencies, `major` for protocol or configuration breakage. Before 1.0 a
breaking change may land in a `minor` release, but say so in `CHANGELOG.md` and
the release notes.

## 5. Automated releases (Trusted Publishing)

`.github/workflows/release-pi-plugin.yml` publishes on every `pi-plugin-v*` tag
(and on manual `workflow_dispatch`, which publishes the version already in
`package.json`). It authenticates through npm Trusted Publishing (OIDC), so
there is no `NPM_TOKEN` secret and no OTP, and npm attaches a provenance
statement automatically.

One-time setup — **after the first manual publish**, because npm only offers
Trusted Publisher settings for packages that already exist:

1. npm package page → **Settings → Trusted Publisher → GitHub Actions**
2. Repository: `htynkn/agentdock`, workflow filename: `release-pi-plugin.yml`,
   environment: leave empty.

The job needs npm CLI >= 11.5.1 (`npm install --global npm@11`) and Node >= 22.14.
Until the Trusted Publisher is set up, tag-triggered runs fail at the publish
step.

### Why the `pi-plugin-v` prefix

This repository versions several things independently (firmware, hardware
revisions, the `promo` package). A bare `v0.1.1` tag does not say which of them
it belongs to, and with `v*` every firmware or hardware tag would trigger an npm
publish of the plugin — either a red run or, worse, a version nobody intended.

To publish on plain `v*` tags anyway, change the `on.push.tags` filter to `v*`
and drop `tag-version-prefix` from `pi-plugin/.npmrc`. Only do that if the whole
repository shares one release cadence.

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
| Release workflow fails with `E404` / OIDC error | Trusted Publisher not configured yet (it can only be added after the first manual publish), or the workflow filename does not match the npm settings |
| Tag-triggered run published the wrong version | Fixed by design: the workflow overwrites `package.json`'s version with the tag's. Check the "Resolve version from tag" step output |
| `E403 You cannot publish over the previously published versions` | That tag's version already exists on npm; use a new tag |
