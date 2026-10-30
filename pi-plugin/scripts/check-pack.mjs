/*
 * Validates the npm tarball contents — catches a files whitelist that drops the
 * extension entry point, or development files that leak into the package.
 * Usage: npm run check:pack
 */
import { execFileSync } from "node:child_process";

/* Files that must be in the tarball (package.json is always included by npm) */
const REQUIRED = [
  "package.json",
  "index.ts", // pi.extensions entry point
  "ble.ts",
  "panel.ts",
  "config.ts",
  "scroll.ts",
  "README.md",
  "LICENSE",
];

/* Files that must not be in the tarball (development-only) */
const FORBIDDEN = [/^test\//, /\.test\.ts$/, /\.tgz$/, /^tsconfig\.json$/, /^vitest\.config\.ts$/, /^scan-test\.mjs$/, /^scripts\//, /^node_modules\//];

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "inherit"],
});
const [pack] = JSON.parse(raw);
const files = pack.files.map((f) => f.path).sort();

const missing = REQUIRED.filter((f) => !files.includes(f));
const leaked = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));

console.log(files.map((f) => `  ${f}`).join("\n"));

if (missing.length > 0) {
  console.error(`\n✗ tarball is missing required files: ${missing.join(", ")}`);
  process.exit(1);
}
if (leaked.length > 0) {
  console.error(`\n✗ tarball contains files that must not be published: ${leaked.join(", ")}`);
  process.exit(1);
}

console.log(`\n✓ tarball ok: ${pack.name}@${pack.version}, ${files.length} files, ${pack.size} bytes`);
