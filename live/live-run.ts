#!/usr/bin/env node
// LIVE RUN on Sepolia from one funded wallet. Dry run unless --send.
//   node dist/live-run.mjs --config arms.config.json --key-file ~/funder.key [--send]
// Steps: register form -> make 3 arm + 1 challenger wallets (wallets/, git-ignored) -> fund -> bond 500 ARMT each + serve at 1e18
//        -> job 1 honest (post, draw, commit, reveal, settle) -> job 2 (all drawn arms agree on a wrong key-index-8 value,
//        challenge with the right value, pay the oracle fee in imdTEST, wait for the real IMD ruling, resolve) -> report.md
import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, parseEther, formatEther, type Account, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { loadConfig, rpcUrlOf } from "../src/config.js";
import { Chain, execute, plans, fmt, parseTokens, jsonSafe, type TxOutcome, type TxPlan } from "../src/chain.js";
import { accountFrom } from "../src/wallet.js";
import { formSpec } from "../src/form.js";
import { answerJob } from "../src/pipeline.js";
import { SaltStore } from "../src/salts.js";
import { encodeAnswer, encodeLabel, decodeAnswer, UNKNOWN } from "../src/keys.js";
import { imdRequestCheck } from "../src/oracle.js";
import { armsAbi, courtAbi, erc20Abi, PHASES, RULINGS } from "../src/abi.js";

const { values: o } = parseArgs({ strict: false, options: {
  config: { type: "string", default: "arms.config.json" }, "key-file": { type: "string" }, "key-env": { type: "string" },
  send: { type: "boolean", default: false }, wallets: { type: "string", default: "wallets" }, report: { type: "string", default: "report.md" },
  target: { type: "string", default: "0x56bcf2a5f47710649a4091219ef0b56e2d1b58bf" }, // imdTEST on Sepolia, verified on Sourcify
  "honest-file": { type: "string" }, // optional JSON {"8":..,"13":..}: keys 8-13 to use instead of running the agent
  "ruling-timeout-min": { type: "string", default: "180" }, "eth-per-arm": { type: "string", default: "0.05" }, "eth-challenger": { type: "string", default: "0.08" },
} });
const send = !!o.send;
const S = (v: unknown) => v as string;
const ARM_BOND = parseTokens("500"), FEE = parseTokens("1");
const log = (s = "") => console.log(s);
const rep: string[] = [];
const hashes: { label: string; hash: string; gasUsed?: string }[] = [];
const mismatches: string[] = [];

async function main() {
  const cfg = loadConfig(S(o.config));
  const chain = new Chain(cfg, rpcUrlOf(cfg));
  if (cfg.chainId !== 11155111) throw new Error("live run is for Sepolia (11155111)");
  const keySrc = S(o["key-file"]) || S(o["key-env"]) ? { file: S(o["key-file"]), env: S(o["key-env"]) } : cfg.key;
  const funder = accountFrom(keySrc);
  const wdir = S(o.wallets); const stateFile = join(wdir, "live-state.json");
  const state: any = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
  const saveState = () => { if (send) { mkdirSync(wdir, { recursive: true }); writeFileSync(stateFile, JSON.stringify(state, null, 1)); } };
  log(`LIVE RUN on Sepolia — ${send ? "SENDING" : "DRY RUN (nothing is sent; pass --send)"}\nfunder ${funder.address}`);

  // ---- preflight: contracts, form, balances ----
  const spec = formSpec(cfg.form.repo, cfg.form.commit, cfg.form.path, readFileSync("forms/control-map-v1.txt"));
  const published = new Uint8Array(await (await fetch(spec.uri)).arrayBuffer());
  if (Buffer.compare(Buffer.from(published), readFileSync("forms/control-map-v1.txt")) !== 0) throw new Error(`published form at ${spec.uri} differs from forms/control-map-v1.txt; refusing to register`);
  const court = { intake: await chain.court<Address>("intake"), asset: await chain.court<Address>("feeAsset"), fee: await chain.court<bigint>("fee"), action: await chain.court<Hex>("action"), signer: await chain.court<Address>("oracleSigner") };
  const callbackGas = await chain.read<bigint>(court.intake, [{ type: "function", name: "callbackGas", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }] as any, "callbackGas");
  const caps: any = await (await fetch("https://api.imd.fun/requests/capabilities")).json();
  const net = caps.onchain?.chains?.find((c: any) => c.chainId === 11155111);
  const act = net?.actions?.find((a: any) => a.action === "oracle.request");
  if (!net) mismatches.push("capabilities API lists no Sepolia network"); else {
    if (net.intake.toLowerCase() !== court.intake.toLowerCase()) mismatches.push(`court intake ${court.intake} != capabilities intake ${net.intake}`);
    if (net.asset.toLowerCase() !== court.asset.toLowerCase()) mismatches.push(`court fee asset ${court.asset} != capabilities asset ${net.asset}`);
    if (act?.actionId !== court.action) mismatches.push(`court action ${court.action} != capabilities actionId ${act?.actionId}`);
  }
  if (callbackGas !== 200000n) mismatches.push(`Intake.callbackGas() is ${callbackGas}; the pinned IMD skill documents a 200000 callback stipend`);
  const treeNeeds = { eth: parseEther(S(o["eth-per-arm"])) * 3n + parseEther(S(o["eth-challenger"])) + parseEther("0.1"), armt: 3n * ARM_BOND + parseTokens("10"), imd: court.fee * 2n };
  const have = { eth: await chain.pub.getBalance({ address: funder.address }), armt: await chain.token<bigint>("balanceOf", funder.address), imd: await chain.read<bigint>(court.asset, erc20Abi, "balanceOf", [funder.address]) };
  log(`form ${spec.formId}\n  ${spec.uri}\ncourt fee ${fmt(court.fee)} imdTEST (${court.asset}), callbackGas ${callbackGas}\nfunder holds ${formatEther(have.eth)} ETH / ${fmt(have.armt)} ARMT / ${fmt(have.imd)} imdTEST; run needs about ${formatEther(treeNeeds.eth)} ETH / ${fmt(treeNeeds.armt)} ARMT / ${fmt(treeNeeds.imd)} imdTEST`);
  const short = (have.eth < treeNeeds.eth ? ["ETH"] : []).concat(have.armt < treeNeeds.armt ? ["ARMT"] : [], have.imd < treeNeeds.imd ? ["imdTEST"] : []);
  if (short.length) { log(`funder is short of: ${short.join(", ")}`); if (send) throw new Error(`funder is short of ${short.join(", ")}`); }

  const wsend = (acct: Account) => createWalletClient({ account: acct, chain: sepolia, transport: http(rpcUrlOf(cfg)) });
  const tx = async (acct: Account | undefined, plan: TxPlan): Promise<TxOutcome> => {
    const r = await execute(chain, acct, plan, send);
    if (r.hash) hashes.push({ label: plan.label, hash: r.hash, gasUsed: r.gasUsed?.toString() });
    if (send && (r.error || !r.sent)) throw new Error(`${plan.label}: ${r.error ?? "not sent"}`);
    return r;
  };
  const sendEth = async (to: Address, amt: bigint, label: string) => {
    log(`  ${label}\n    to ${to}\n    value ${formatEther(amt)} ETH${send ? "" : "\n    NOT SENT (dry run)"}`);
    if (!send) return;
    const h = await wsend(funder).sendTransaction({ to, value: amt }); const rc = await chain.pub.waitForTransactionReceipt({ hash: h });
    hashes.push({ label, hash: h, gasUsed: rc.gasUsed.toString() });
  };

  // ---- 1. register the form (same values as script/prepare_control_map.py) ----
  const info: any = await chain.forms("info", spec.formId);
  const registered = Number(info[0]) !== 0;
  log(`\n[1] register form (${registered ? "already registered" : "not yet registered"})`);
  if (!registered) await tx(funder, plans.arms(cfg, "registerForm control-map-v1", "registerForm", [spec.textHash, 13, spec.uri]));

  // ---- 2. wallets ----
  log(`\n[2] wallets in ${wdir}/ (git-ignored)`);
  const names = ["arm1", "arm2", "arm3", "challenger"];
  const accounts: Record<string, Account> = {};
  for (const n of names) {
    const f = join(wdir, `${n}.key`);
    if (existsSync(f)) accounts[n] = accountFrom({ file: f });
    else if (send) { mkdirSync(wdir, { recursive: true, mode: 0o700 }); writeFileSync(f, generatePrivateKey(), { mode: 0o600 }); chmodSync(f, 0o600); accounts[n] = accountFrom({ file: f }); }
    log(`  ${n}: ${accounts[n]?.address ?? "(would be generated)"}`);
  }
  if (!send) { log("\nDRY RUN ends here: the remaining steps need the wallets and on-chain state. Planned:\n [3] fund each arm with ETH and 500 ARMT, the challenger with ETH, 5 ARMT and imdTEST\n [4] each arm: approve + bond 500 ARMT, serve at 1 ARMT\n [5] job 1 honest: post, draw, commit, reveal, settle\n [6] job 2: wrong key-index-8 value from every drawn arm, IMD request check, challenge, wait for ruling, resolve\n [7] report.md"); return; }

  // ---- 3. fund ----
  log("\n[3] fund");
  for (const n of ["arm1", "arm2", "arm3"]) {
    const a = accounts[n]!.address;
    if ((await chain.pub.getBalance({ address: a })) < parseEther(S(o["eth-per-arm"])) / 2n) await sendEth(a, parseEther(S(o["eth-per-arm"])), `fund ${n} ETH`);
    const bal = await chain.token<bigint>("balanceOf", a);
    if (bal < ARM_BOND) await tx(funder, { label: `transfer ${fmt(ARM_BOND - bal)} ARMT to ${n}`, to: cfg.token, abi: erc20Abi, functionName: "transfer", args: [a, ARM_BOND - bal] });
  }
  { const c = accounts.challenger!.address;
    if ((await chain.pub.getBalance({ address: c })) < parseEther(S(o["eth-challenger"])) / 2n) await sendEth(c, parseEther(S(o["eth-challenger"])), "fund challenger ETH");
    if ((await chain.token<bigint>("balanceOf", c)) < parseTokens("5")) await tx(funder, { label: "transfer 5 ARMT to challenger", to: cfg.token, abi: erc20Abi, functionName: "transfer", args: [c, parseTokens("5")] });
    const ib = await chain.read<bigint>(court.asset, erc20Abi, "balanceOf", [c]);
    if (ib < court.fee) await tx(funder, { label: `transfer ${fmt(court.fee)} imdTEST to challenger`, to: court.asset, abi: erc20Abi, functionName: "transfer", args: [c, court.fee] }); }

  // ---- 4. bond + serve ----
  log("\n[4] bond 500 ARMT each and serve at 1e18");
  for (const n of ["arm1", "arm2", "arm3"]) {
    const a = accounts[n]!;
    const [bond] = await chain.arms<any[]>("arms", a.address);
    if (bond < ARM_BOND) { await tx(a, plans.approve(cfg, cfg.token, cfg.arms, ARM_BOND)); await tx(a, plans.arms(cfg, `${n} bond 500 ARMT`, "bond", [ARM_BOND - bond])); }
    const mf = await chain.forms<bigint>("minFeeOf", spec.formId, a.address); const stopped = await chain.forms<bigint>("stoppedAt", spec.formId, a.address);
    if (mf === 0n || stopped !== 0n) await tx(a, plans.arms(cfg, `${n} serve at 1e18`, "serve", [spec.formId, FEE]));
  }

  // ---- 5/6 jobs ----
  const store = new SaltStore(join(wdir, "live-salts.json"));
  const honest = await honestAnswers(cfg, chain, S(o.target), S(o["honest-file"]), wdir);
  const mine = (addr: string) => names.map((n) => accounts[n]!).find((a) => a.address.toLowerCase() === addr.toLowerCase())!;

  const runJob = async (tag: string, vals: (arm: string) => Hex[], atBlock: bigint): Promise<bigint> => {
    if (state[tag]?.settled) return BigInt(state[tag].jobId);
    let jobId: bigint;
    if (state[tag]?.jobId) jobId = BigInt(state[tag].jobId);
    else {
      await tx(funder, plans.approve(cfg, cfg.token, cfg.arms, 3n * FEE));
      const before = await chain.arms<bigint>("jobCount");
      await tx(funder, plans.arms(cfg, `${tag}: post ${S(o.target)} @ ${atBlock}`, "post", [spec.formId, 11155111n, S(o.target), atBlock, FEE]));
      jobId = await chain.arms<bigint>("jobCount"); if (jobId <= before) throw new Error("post did not create a job");
      state[tag] = { jobId: jobId.toString(), atBlock: atBlock.toString() }; saveState();
    }
    log(`  ${tag}: job ${jobId}`);
    // draw until a phase beyond OPEN (seed block must be mined first)
    for (let i = 0; i < 40; i++) {
      const j = await chain.job(jobId); if (Number(j.phase) >= 2) break;
      try { await tx(funder, plans.arms(cfg, `${tag}: draw job ${jobId}`, "draw", [jobId])); } catch (e: any) { log(`    draw not yet possible: ${String(e.message).slice(0, 120)}`); await sleep(15_000); }
    }
    const drawn = await chain.arms<Address[]>("armsOf", jobId);
    log(`    drawn: ${drawn.join(", ")}`);
    state[tag].drawn = drawn;
    for (const a of drawn) {
      const w = mine(a); const v = vals(a); const id = SaltStore.id(11155111, cfg.arms, jobId, a);
      const rec = store.prepare(id, jobId, a, v, `live-run:${tag}`);
      const e = await chain.entry(jobId, a);
      if (!e.committed) { await tx(w, plans.arms(cfg, `${tag}: commit job ${jobId} by ${a}`, "commit", [jobId, a, rec.hash])); store.mark(id, "committed"); }
    }
    for (let i = 0; i < 20 && Number((await chain.job(jobId)).phase) === 2; i++) await sleep(5_000);
    for (const a of drawn) {
      const id = SaltStore.id(11155111, cfg.arms, jobId, a); const rec = store.get(id)!; const e = await chain.entry(jobId, a);
      if (!e.revealed) { await tx(mine(a), plans.arms(cfg, `${tag}: reveal job ${jobId} by ${a}`, "reveal", [jobId, a, rec.values, rec.salt, rec.evidenceURI])); store.mark(id, "revealed"); }
    }
    await tx(funder, plans.arms(cfg, `${tag}: settle job ${jobId}`, "settle", [jobId]));
    const j = await chain.job(jobId); log(`    phase ${PHASES[Number(j.phase)]}`);
    state[tag].settled = true; saveState();
    return jobId;
  };

  log("\n[5] job one: honest check");
  const head = await chain.pub.getBlockNumber();
  const block1 = BigInt(state.job1?.atBlock ?? head - 12n);
  const job1 = await runJob("job1", () => honest.values, block1);
  const v1 = await chain.arms<any>("verdict", job1);
  log(`    verdict: ${v1.values.map((w: Hex, i: number) => `${i + 1}=${decodeAnswer(w)}`).join(" ")}`);

  log("\n[6] job two: wrong key-index-8 value from every drawn arm, then a challenge");
  const rightKey9 = honest.values[8]!;
  const wrong = rightKey9 === encodeLabel("YES") ? encodeLabel("NO") : encodeLabel("YES");
  if (rightKey9 === UNKNOWN) throw new Error("key 9 honest answer is UNKNOWN: supply --honest-file with a true key 9 answer");
  const block2 = BigInt(state.job2?.atBlock ?? (await chain.pub.getBlockNumber()) - 12n);
  const job2 = await runJob("job2", () => honest.values.map((v, i) => (i === 8 ? wrong : v)), block2);
  const j2 = await chain.job(job2);
  const [storedVal, status] = await chain.arms<[Hex, number]>("results", job2, 8);
  log(`    stored value for index 8: ${decodeAnswer(storedVal)} (status ${status}); challenger claims ${decodeAnswer(rightKey9)}`);
  const ch = accounts.challenger!;
  let caseId: Hex = await chain.arms<Hex>("caseIdOf", job2, 8, rightKey9);
  if (!state.job2.challenged) {
    const chk = await imdRequestCheck(chain, { formId: j2.formId, key0: 8, chainId: 11155111, target: j2.target, atBlock: j2.atBlock, stored: storedVal, claimed: rightKey9 });
    log(`    IMD request check: ${chk.ok ? "PASS" : "FAIL"} ${jsonSafe(chk.blockers)}`);
    state.job2.check = { ok: chk.ok, blockers: chk.blockers, matches: chk.onchainQuestionMatches }; saveState();
    if (!chk.ok) throw new Error("IMD request check did not pass; not paying the oracle fee");
    const stake = 2n * FEE;
    await tx(ch, plans.approve(cfg, cfg.token, cfg.arms, stake)); await tx(ch, plans.approve(cfg, court.asset, cfg.arms, court.fee));
    const r = await tx(ch, plans.arms(cfg, `challenge job ${job2} key index 8`, "challenge", [job2, 8, rightKey9, court.fee]));
    const rc = await chain.pub.getTransactionReceipt({ hash: r.hash! }); const blk = await chain.pub.getBlock({ blockNumber: rc.blockNumber });
    state.job2.challenged = { tx: r.hash, ts: blk.timestamp.toString(), gasUsed: rc.gasUsed.toString() }; saveState();
  }
  log("    waiting for the real IMD oracle ruling…");
  const deadline = Date.now() + Number(S(o["ruling-timeout-min"])) * 60_000;
  let ruling = 0, rulingTs = 0n, cbTx: Hex | undefined, cbGas = 0n, cbBlock = 0n;
  while (Date.now() < deadline) {
    ruling = Number(await chain.read(cfg.court, courtAbi, "rulingOf", [cfg.arms, caseId]));
    if (ruling !== 0) break;
    const c: any = await chain.court("caseOf", cfg.arms, caseId); if (!c.open) { log("    case closed without a ruling (CaseFailed)"); break; }
    await sleep(30_000);
  }
  const logs = await chain.pub.getContractEvents({ address: cfg.court, abi: courtAbi, eventName: "CaseRuled", fromBlock: BigInt(state.job2.challenged ? head - 50n : 0n), args: { caseId } as any }).catch(() => []);
  if ((logs as any[]).length) { const l: any = (logs as any[])[0]; cbTx = l.transactionHash; cbBlock = l.blockNumber; const rc = await chain.pub.getTransactionReceipt({ hash: cbTx! }); cbGas = rc.gasUsed; rulingTs = (await chain.pub.getBlock({ blockNumber: cbBlock })).timestamp; }
  if (ruling !== 0 || Date.now() >= deadline) { /* resolve below */ }
  if (ruling === 0) throw new Error("no ruling yet: rerun the same command later; progress is kept in wallets/live-state.json");
  await tx(funder, plans.arms(cfg, `resolve job ${job2} key index 8`, "resolve", [job2, 8, rightKey9]));
  const final = await chain.arms<any>("verdict", job2);
  const ttr = rulingTs ? Number(rulingTs - BigInt(state.job2.challenged.ts)) : NaN;

  // ---- report ----
  rep.push("# Arms v1 live run on Sepolia", "", `Date: ${new Date().toISOString()}`, `Arms ${cfg.arms}, IMDCourt ${cfg.court}, ARMT ${cfg.token}`, `Form ${spec.formId}`, `Form URI ${spec.uri}`, `Target ${S(o.target)}`, "",
    "## Wallets (addresses only)", ...names.map((n) => `- ${n}: ${accounts[n]!.address}`), `- funder: ${funder.address}`, "",
    "## Transactions", ...hashes.map((h) => `- ${h.label}: ${h.hash}${h.gasUsed ? ` (gas ${h.gasUsed})` : ""}`), "",
    "## Job one (honest)", `Job ${job1}; verdict ${v1.values.map((w: Hex, i: number) => `${i + 1}=${decodeAnswer(w)}`).join(" ")}`, "",
    "## Job two (challenge)", `Job ${job2}; wrong value for key index 8: ${decodeAnswer(wrong)}; challenger claim ${decodeAnswer(rightKey9)}`,
    `IMD request check: ${jsonSafe(state.job2.check)}`, `Ruling: ${RULINGS[ruling]}; final status of key index 8: ${final.statuses[8]}`,
    `Time to ruling: ${Number.isNaN(ttr) ? "unknown" : `${ttr} s`} (challenge tx ${state.job2.challenged.tx}; ruling callback tx ${cbTx ?? "n/a"})`,
    `Callback gas: ruling delivery tx gas used ${cbGas}; Intake.callbackGas() limit ${callbackGas}`, "",
    "## Did not match IMD's docs", ...(mismatches.length ? mismatches.map((m) => `- ${m}`) : ["- nothing observed"]), "");
  writeFileSync(S(o.report), rep.join("\n")); log(`\nwrote ${o.report}`);
}

async function honestAnswers(cfg: any, chain: Chain, target: string, file: string | undefined, wdir: string) {
  const block = (await chain.pub.getBlockNumber()) - 12n;
  if (file) {
    const j = JSON.parse(readFileSync(file, "utf8")); const ans = await answerJob(cfg, { chainId: 11155111, target, block, rpcUrl: rpcUrlOf(cfg), dir: join(wdir, "honest"), skipAgent: true });
    return { values: [...ans.values.slice(0, 7), ...[8, 9, 10, 11, 12, 13].map((k) => (j[String(k)] ? encodeAnswer(j[String(k)]) : UNKNOWN))] as Hex[] };
  }
  const ans = await answerJob(cfg, { chainId: 11155111, target, block, rpcUrl: rpcUrlOf(cfg), dir: join(wdir, "honest"), etherscanKey: cfg.etherscanKeyEnv ? process.env[cfg.etherscanKeyEnv] : undefined });
  return { values: ans.values };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
main().catch((e) => { console.error(`error: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0]}`); process.exit(1); });
