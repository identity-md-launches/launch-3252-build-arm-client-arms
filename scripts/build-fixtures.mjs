// Compile test/fixtures/contracts/Planted.sol with solc 0.8.26 into test/fixtures/planted.json (committed, so tests need no compiler).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const solc = process.env.SOLC ?? "solc";
const src = "test/fixtures/contracts/Planted.sol";
const input = { language: "Solidity", sources: { "Planted.sol": { content: readFileSync(src, "utf8") } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } } };
const out = JSON.parse(execFileSync(solc, ["--standard-json"], { input: JSON.stringify(input), maxBuffer: 1 << 26 }).toString());
const errs = (out.errors ?? []).filter((e) => e.severity === "error");
if (errs.length) { console.error(errs.map((e) => e.formattedMessage).join("\n")); process.exit(1); }
const res = {};
for (const [name, c] of Object.entries(out.contracts["Planted.sol"])) res[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
writeFileSync("test/fixtures/planted.json", JSON.stringify(res));
console.log(`compiled ${Object.keys(res).length} contracts`);
