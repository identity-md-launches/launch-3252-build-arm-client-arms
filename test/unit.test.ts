import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toBytes, type Hex } from "viem";
import { NOT_APPLICABLE, UNKNOWN, encodeAnswer, encodeLabel, decodeAnswer, validateAnswer, commitValues } from "../src/keys.js";
import { SaltStore, commitmentHash } from "../src/salts.js";
import { validateAgentOutput, agentEnv, registerSecretEnv } from "../src/agent.js";
import { formSpec } from "../src/form.js";
import { scoreAgent } from "../src/score.js";
import { loadPrivateKey } from "../src/wallet.js";
import { runOnce } from "../src/run.js";
import { writeFileSync, chmodSync } from "node:fs";

test("encoding matches the form text", () => {
  assert.equal(NOT_APPLICABLE, "0x28575e92a3b198336a7503200227145621e324a17f09b0968af4ccdee4a4845b");
  assert.equal(UNKNOWN, "0x7536cfa9e26dddfa3a7092eb599a3171dc4f26094b58d0e47bddf70679ecb7f6");
  assert.equal(encodeLabel("YES"), "0x5945530000000000000000000000000000000000000000000000000000000000");
  assert.equal(encodeLabel("NO"), "0x4e4f000000000000000000000000000000000000000000000000000000000000");
  assert.equal(encodeAnswer("0x0cc4cab99c475973f658a64814b8b020e7f32e30"), "0x0000000000000000000000000cc4cab99c475973f658a64814b8b020e7f32e30");
  assert.equal(encodeAnswer("0x0000000000000000000000000000000000000000"), `0x${"00".repeat(32)}`);
  for (const a of ["YES", "ALL", "LIFETIME_TOTAL", "NOT_APPLICABLE", "UNKNOWN", "0x0cc4cab99c475973f658a64814b8b020e7f32e30"]) assert.equal(decodeAnswer(encodeAnswer(a)).toLowerCase(), a.toLowerCase());
  assert.throws(() => validateAnswer(9, "MAYBE")); assert.throws(() => validateAnswer(2, "YES")); validateAnswer(13, "SOME");
});

test("form id formula", () => {
  const s = formSpec("o/r", "a".repeat(40), "forms/control-map-v1.txt", readFileSync("forms/control-map-v1.txt"));
  assert.equal(s.keyCount, 13); assert.equal(s.textHash, keccak256(readFileSync("forms/control-map-v1.txt")));
  assert.match(s.uri, /^https:\/\/raw\.githubusercontent\.com\/o\/r\/a{40}\/forms\//);
  assert.throws(() => formSpec("o/r", "main", "x", new Uint8Array()));
});

const ARM = "0x00000000000000000000000000000000000000a1";
test("salts: persisted, 0600, stable across restart, reveal matches commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "salts-")); const f = join(dir, "s.json");
  const vals: Hex[] = [encodeLabel("YES"), UNKNOWN];
  const id = SaltStore.id(11155111, "0x0cc4cab99c475973f658a64814b8b020e7f32e30", 7n, ARM);
  const r1 = new SaltStore(f).prepare(id, 7n, ARM, vals, "e");
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const r2 = new SaltStore(f).prepare(id, 7n, ARM, [encodeLabel("NO"), UNKNOWN]); // "restart" recomputed different values
  assert.deepEqual(r2, r1);
  assert.equal(commitmentHash(7n, ARM, r2.values, r2.salt), r1.hash);
  new SaltStore(f).mark(id, "committed", "0xabc");
  assert.equal(new SaltStore(f).get(id)!.stage, "committed");
  assert.notEqual(new SaltStore(f).prepare(SaltStore.id(1, "0x1", 7n, ARM), 7n, ARM, vals).salt, r1.salt);
});

test("restart between commit and reveal: run keeps the stored salt and reveals what was committed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-")); const store = new SaltStore(join(dir, "salts.json"));
  const cfg: any = { chainId: 11155111, arms: "0x0cc4cab99c475973f658a64814b8b020e7f32e30", saltsFile: join(dir, "salts.json"), pollSeconds: 1 };
  let phase = 2, committed = false, calls = 0;
  const lines: string[] = [];
  const fake: any = {
    pub: { getBlockNumber: async () => 100n, getContractEvents: async () => [{ args: { arm: ARM, jobId: 5n } }], simulateContract: async () => ({}), estimateContractGas: async () => 1n },
    job: async () => ({ phase, tieBreaker: "0x0", deadline: 2n ** 60n, target: "0x1", atBlock: 1n, targetChainId: 11155111n, disputedMask: 0 }),
    entry: async () => ({ committed, revealed: false, commitHash: new SaltStore(cfg.saltsFile).get(SaltStore.id(11155111, cfg.arms, 5n, ARM))?.hash ?? "0x" }), now: async () => 1n,
  };
  const answer = async () => { calls++; return { values: [encodeLabel("YES"), ...Array(12).fill(UNKNOWN)] as Hex[], evidencePath: "", digest: "d".repeat(64), reader: {} as any, problems: [] }; };
  const o: any = { send: false, account: { address: ARM }, targetRpc: () => "", answer, log: (s: string) => lines.push(s) };
  const st = join(dir, "state.json");
  await runOnce(cfg, fake, o, store, st);
  const rec1 = store.get(SaltStore.id(11155111, cfg.arms, 5n, ARM))!;
  assert.equal(rec1.stage, "prepared"); assert.ok(lines.some((l) => l.includes(rec1.hash)), "commit plan uses the stored hash");
  // process "restarts" with a fresh store: no recomputation produces a different salt
  await runOnce(cfg, fake, o, new SaltStore(cfg.saltsFile), st);
  assert.equal(new SaltStore(cfg.saltsFile).get(SaltStore.id(11155111, cfg.arms, 5n, ARM))!.salt, rec1.salt);
  committed = true; phase = 3; lines.length = 0;
  await runOnce(cfg, fake, o, new SaltStore(cfg.saltsFile), st);
  const rec2 = new SaltStore(cfg.saltsFile).get(SaltStore.id(11155111, cfg.arms, 5n, ARM))!;
  assert.equal(rec2.stage, "committed");
  assert.ok(lines.join("\n").includes(rec1.salt), "reveal plan carries the stored salt");
  lines.length = 0; (fake.entry as any) = async () => ({ committed: true, revealed: false, commitHash: "0x" + "ab".repeat(32) });
  await runOnce(cfg, fake, o, new SaltStore(cfg.saltsFile), st);
  assert.ok(lines.some((l) => l.includes("refusing to reveal")), "a mismatching on-chain commit is never revealed");
  assert.equal(commitmentHash(5n, ARM, rec2.values, rec2.salt), rec1.hash);
});

test("agent output: missing/invalid/no-evidence answers become UNKNOWN, never guesses", () => {
  const ev = (k: number) => ({ key: k, kind: "fact", file: "A.sol", line: 3, note: "" });
  const r = validateAgentOutput({ answers: { "8": "YES", "9": "MAYBE", "10": "NONE", "11": "NO" }, evidence: [ev(8), ev(9), ev(11)] });
  assert.equal(r.values[0], encodeLabel("YES")); assert.equal(r.values[1], UNKNOWN); assert.equal(r.values[2], UNKNOWN); assert.equal(r.values[3], encodeLabel("NO")); assert.equal(r.values[5], UNKNOWN);
  assert.ok(r.problems.length >= 4);
});

test("scoring bar: 18/20 and no key 8/9 miss", () => {
  const exp: any = {}, got: any = {};
  for (let i = 0; i < 20; i++) { exp[`c${i}`] = { "8": "NO", "9": "NO", "10": "N", "11": "NO", "12": "NO", "13": "N" }; got[`c${i}`] = { ...exp[`c${i}`] }; }
  assert.ok(scoreAgent(got, exp).pass);
  got.c0["13"] = "ALL"; got.c1["11"] = "YES"; assert.ok(scoreAgent(got, exp).pass);
  got.c2["12"] = "YES"; assert.equal(scoreAgent(got, exp).pass, false);
  got.c2["12"] = "NO"; got.c3["9"] = "YES"; assert.equal(scoreAgent(got, exp).pass, false);
});

test("key loading never echoes the key", () => {
  const dir = mkdtempSync(join(tmpdir(), "k-")); const f = join(dir, "k");
  writeFileSync(f, "not-a-key-SECRETVALUE", { mode: 0o600 });
  try { loadPrivateKey({ file: f }); assert.fail(); } catch (e: any) { assert.ok(!String(e.message).includes("SECRETVALUE")); }
  writeFileSync(f, "0x" + "11".repeat(32)); chmodSync(f, 0o644);
  assert.throws(() => loadPrivateKey({ file: f }), /chmod 600/);
  assert.throws(() => loadPrivateKey({ env: "ARMS_NOPE_UNSET" }), /empty or unset/);
  assert.throws(() => loadPrivateKey(undefined), /no key source/);
});

test("agent output: Key 10 follows Key 9 and Key 13 needs an identified power", () => {
  const ev = [8, 9, 10, 11, 12, 13].map((k) => ({ key: k, kind: "fact", file: "A.sol", line: 1, note: "" }));
  const r = validateAgentOutput({ answers: { "8": "NO", "9": "NO", "10": "NONE", "11": "NO", "12": "NO", "13": "NONE" }, evidence: ev });
  assert.equal(r.values[2], NOT_APPLICABLE); assert.equal(r.values[5], NOT_APPLICABLE); assert.equal(r.problems.length, 2);
  const u = validateAgentOutput({ answers: { "8": "YES", "9": "UNKNOWN", "10": "NONE", "11": "NO", "12": "NO", "13": "ALL" }, evidence: ev });
  assert.equal(u.values[2], UNKNOWN); assert.equal(u.values[5], UNKNOWN);
  const ok = validateAgentOutput({ answers: { "8": "YES", "9": "YES", "10": "NONE", "11": "NO", "12": "NO", "13": "SOME" }, evidence: ev });
  assert.deepEqual(ok.problems, []); assert.equal(ok.values[5], encodeLabel("SOME"));
});

test("commit refuses a values file the contract could not accept at reveal", () => {
  const all = Array.from({ length: 13 }, (_, i) => i + 1);
  const good = ["NO", "NOT_APPLICABLE", "NOT_APPLICABLE", "0x0cc4cab99c475973f658a64814b8b020e7f32e30", "NO_CODE", "NOT_APPLICABLE", "NOT_APPLICABLE", "NO", "NO", "NOT_APPLICABLE", "NO", "NO", "NOT_APPLICABLE"];
  assert.equal(commitValues(good, all).length, 13);
  assert.throws(() => commitValues(good.slice(0, 12), all), /13 values required/);
  const bad = [...good]; bad[1] = "YES"; assert.throws(() => commitValues(bad, all), /key 2 needs an address/);
  assert.equal(commitValues(["YES"], [9]).length, 1, "tie-breaker commits only the disputed keys");
});

test("agent environment: no key, RPC-URL or explorer-key variable reaches the agent", () => {
  const parent = { PATH: "/bin", HOME: "/h", ARM_KEY: "0x" + "ab".repeat(32), FUNDER_KEY: "x", RPC_SECRET: "u", ESCAN: "e", ANTHROPIC_API_KEY: "a", RANDOM: "r" };
  registerSecretEnv("FUNDER_KEY");
  const cfg: any = { key: { env: "ARM_KEY" }, rpcUrlEnv: "RPC_SECRET", etherscanKeyEnv: "ESCAN", skillPath: "skills/control-map-source/SKILL.md", agent: { passEnv: ["ANTHROPIC_API_KEY", "ARM_KEY", "FUNDER_KEY"] } };
  const env = agentEnv(cfg, "/tmp/job", parent);
  for (const n of ["ARM_KEY", "FUNDER_KEY", "RPC_SECRET", "ESCAN", "RANDOM"]) assert.equal(env[n], undefined, n);
  assert.equal(env.PATH, "/bin"); assert.equal(env.ANTHROPIC_API_KEY, "a"); assert.equal(env.ARMS_JOB_DIR, "/tmp/job");
});
