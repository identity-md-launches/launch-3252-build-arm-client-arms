// Collect OUTDIR/<contract>/answers.json (written by the agent) into one file for `arms score`.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [dir, outFile] = process.argv.slice(2);
const exp = JSON.parse(readFileSync("test/fixtures/expected.json", "utf8"));
const all = {};
for (const name of Object.keys(exp)) { const f = join(dir, name, "answers.json"); all[name] = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).answers ?? {} : {}; }
writeFileSync(outFile, JSON.stringify(all, null, 1)); console.log(`collected ${Object.keys(all).length} -> ${outFile}`);
