// Bundles the CLI (with viem) into dist/arms.mjs, which is committed so the tool runs without npm install.
// With --tests, also bundles test/*.test.ts into test/.build/ for `node --test`.
import { build } from "esbuild";
import { readdirSync } from "node:fs";
const common = { bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "warning", banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } };
await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/arms.mjs", banner: { js: `#!/usr/bin/env node\n${common.banner.js}` } });
await build({ ...common, entryPoints: ["live/live-run.ts"], outfile: "dist/live-run.mjs" });
if (process.argv.includes("--tests")) {
  const tests = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);
  await build({ ...common, entryPoints: tests, outdir: "test/.build", outExtension: { ".js": ".mjs" } });
}
console.log("built");
