// Make one job directory per planted contract so an operator can run an agent with the skill and score it:
//   node scripts/score-jobs.mjs OUTDIR            # creates OUTDIR/<contract>/task.json + sources
//   (run the agent in each dir, then collect answers)  node dist/arms.mjs score <collected.json> test/fixtures/expected.json
// collected.json: { "<contract name>": { "8": "YES", ... "13": "NONE" }, ... }  (see scripts/collect-answers.mjs)
import { mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const out = process.argv[2]; if (!out) { console.error("usage: node scripts/score-jobs.mjs OUTDIR"); process.exit(2); }
const exp = JSON.parse(readFileSync("test/fixtures/expected.json", "utf8"));
for (const [name, e] of Object.entries(exp)) {
  const dir = join(out, name); mkdirSync(join(dir, "sources"), { recursive: true });
  copyFileSync("test/fixtures/contracts/Planted.sol", join(dir, "sources/Planted.sol"));
  const keys = Array.from({ length: 7 }, (_, i) => ({ key: i + 1, answer: e[String(i + 1)] }));
  writeFileSync(join(dir, "task.json"), JSON.stringify({ note: "local fixture: the file Planted.sol holds every planted contract; the entry contract is named in 'entryContract'", entryContract: name, description: e.desc, readerKeys: keys, sources: [{ address: name, dir: join(dir, "sources"), files: [{ path: "Planted.sol" }] }] }, null, 2));
}
console.log(`wrote ${Object.keys(exp).length} job dirs to ${out}`);
