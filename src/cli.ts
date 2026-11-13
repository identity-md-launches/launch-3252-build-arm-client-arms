// `arms` command line. Every write previews what it will send and needs --send.
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { loadConfig, rpcUrlOf, type ArmsConfig } from "./config.js";
import { Chain, execute, plans, jsonSafe, fmt, parseTokens } from "./chain.js";
import { accountFrom } from "./wallet.js";
import { PHASES, STATUSES, RULINGS, armsAbi, erc20Abi } from "./abi.js";
import { SaltStore, commitmentHash } from "./salts.js";
import { encodeAnswer, decodeAnswer, KEY_NAMES } from "./keys.js";
import { readKeys } from "./reader.js";
import { answerJob, evidenceUriOf, sourceTargets } from "./pipeline.js";
import { fetchSource } from "./source.js";
import { runLoop } from "./run.js";
import { imdRequestCheck } from "./oracle.js";
import { formSpec } from "./form.js";
import { scoreAgent } from "./score.js";

const HELP = `arms [--config arms.config.json] [--send] [--key-file F | --key-env VAR] <command> [args]

Reads:   status [job]      verdict <job>      watch [--once] [--from N]
Reader:  read --chain N --target 0x.. --block N [--rpc URL] [--out evidence.json]
         source --chain N --target 0x.. [--out DIR]       form      score <answers.json> <expected.json>
Writes (dry run unless --send):
         bond <ARMT>   serve [--min-fee ARMT]   stop   exit   withdraw
         post --target 0x.. --block N [--chain N] [--fee ARMT]
         draw <job>   commit <job> --values answers.json   reveal <job>   settle <job>
         challenge <job> <keyIndex0> <value> [--max-court-fee X]   resolve <job> <keyIndex0> <value>
Run:     run [--once]      watch for draws naming this arm, answer, commit, reveal (restart-safe)
Keys come only from --key-file / --key-env (or config key.file / key.env). They are never printed or stored.`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true, strict: false,
  options: {
    config: { type: "string", default: "arms.config.json" }, send: { type: "boolean", default: false },
    "key-file": { type: "string" }, "key-env": { type: "string" }, chain: { type: "string" }, target: { type: "string" },
    block: { type: "string" }, rpc: { type: "string" }, out: { type: "string" }, fee: { type: "string" }, "min-fee": { type: "string" },
    values: { type: "string" }, "max-court-fee": { type: "string" }, once: { type: "boolean", default: false }, from: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const cmd = positionals[0];
const a1 = positionals[1], a2 = positionals[2], a3 = positionals[3];
const str = (v: unknown) => v as string | undefined;

async function main() {
  if (!cmd || opt.help) { console.log(HELP); return; }
  if (cmd === "score") { console.log(jsonSafe(scoreAgent(JSON.parse(readFileSync(a1!, "utf8")), JSON.parse(readFileSync(a2!, "utf8"))))); return; }
  const cfg = loadConfig(str(opt.config)!);
  const keySrc = str(opt["key-file"]) || str(opt["key-env"]) ? { file: str(opt["key-file"]), env: str(opt["key-env"]) } : cfg.key;
  const targetRpc = (id: number) => str(opt.rpc) ?? cfg.readerRpc[String(id)] ?? (id === cfg.chainId ? rpcUrlOf(cfg) : (() => { throw new Error(`no readerRpc for chain ${id} in config`); })());
  const etherscanKey = cfg.etherscanKeyEnv ? process.env[cfg.etherscanKeyEnv] : undefined;
  const send = !!opt.send;

  if (cmd === "form") {
    const spec = formSpec(cfg.form.repo, cfg.form.commit, cfg.form.path, readFileSync("forms/control-map-v1.txt"));
    console.log(jsonSafe(spec)); return;
  }
  if (cmd === "read") {
    const chainId = Number(str(opt.chain) ?? cfg.chainId);
    const out = await readKeys({ chainId, target: str(opt.target)!, block: BigInt(str(opt.block)!), rpcUrl: targetRpc(chainId) });
    for (const k of out.keys) console.log(`${String(k.key).padStart(2)} ${k.name.padEnd(24)} ${k.answer.padEnd(44)} ${k.value}${k.failedRead ? `   [${k.failedRead}]` : ""}`);
    if (opt.out) { mkdirSync(dirname(str(opt.out)!), { recursive: true }); writeFileSync(str(opt.out)!, jsonSafe(out)); console.log(`evidence: ${opt.out}`); }
    return;
  }
  if (cmd === "source") {
    const chainId = Number(str(opt.chain) ?? cfg.chainId);
    const r = await fetchSource(chainId, str(opt.target)!, { outDir: str(opt.out) ?? cfg.sourcesDir, etherscanApiKey: etherscanKey, etherscanBase: cfg.etherscanBase });
    console.log(jsonSafe({ ...r, bundle: r.bundle && { ...r.bundle, files: r.bundle.files.length } })); return;
  }

  const chain = new Chain(cfg, rpcUrlOf(cfg));
  const needKey = () => accountFrom(keySrc);
  const arm = () => needKey();
  const write = async (account: ReturnType<typeof accountFrom> | undefined, p: ReturnType<typeof plans.arms>) => execute(chain, account, p, send);
  const job = a1 ? BigInt(a1) : 0n;

  switch (cmd) {
    case "status": {
      const acct = keySrc ? (() => { try { return accountFrom(keySrc); } catch { return undefined; } })() : undefined;
      const count = await chain.arms<bigint>("jobCount");
      console.log(`chain ${cfg.chainId}  arms ${cfg.arms}  court ${cfg.court}  token ${cfg.token}\njobs: ${count}  totalBonded: ${fmt(await chain.arms("totalBonded"))} ARMT  minBond: ${fmt(await chain.arms("minBond"))}`);
      if (acct) {
        const [bond, locked, signer, exiting, exitAt, inactive, , strikes] = await chain.arms<any[]>("arms", acct.address);
        console.log(`arm ${acct.address}: bond ${fmt(bond)} locked ${fmt(locked)} signer ${signer} exiting ${exiting}${exiting ? ` at ${exitAt}` : ""} inactive ${inactive} strikes ${strikes}\nbalance: ${fmt(await chain.token("balanceOf", acct.address))} ARMT`);
      }
      if (a1) {
        const j = await chain.job(job);
        console.log(jsonSafe({ ...j, phase: PHASES[Number(j.phase)] }));
        console.log("arms:", (await chain.arms<string[]>("armsOf", job)).join(", "));
      }
      return;
    }
    case "verdict": {
      const v = await chain.arms<any>("verdict", job);
      console.log(jsonSafe({ phase: PHASES[Number(v.phase)], atBlock: v.atBlock, overturned: v.overturned, arms: v.arms, keys: v.values.map((w: Hex, i: number) => ({ key: i + 1, name: KEY_NAMES[i], status: STATUSES[Number(v.statuses[i])], answer: decodeAnswer(w) })) }));
      return;
    }
    case "watch": {
      let from = str(opt.from) ? BigInt(str(opt.from)!) : (await chain.pub.getBlockNumber()) - 500n;
      for (;;) {
        const head = await chain.pub.getBlockNumber();
        for (let s = from; s <= head; s += 5000n) {
          const e = s + 4999n > head ? head : s + 4999n;
          const logs = await chain.pub.getContractEvents({ address: cfg.arms, abi: armsAbi, fromBlock: s, toBlock: e });
          for (const l of logs as any[]) console.log(`${l.blockNumber} ${l.eventName} ${jsonSafe(l.args).replace(/\s+/g, " ")}`);
        }
        from = head + 1n;
        if (opt.once) return;
        await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
      }
    }
    case "bond": {
      const acct = arm(); const amt = parseTokens(a1!);
      const allowance = await chain.token<bigint>("allowance", acct.address, cfg.arms);
      if (allowance < amt) await execute(chain, acct, plans.approve(cfg, cfg.token, cfg.arms, amt), send);
      await write(acct, plans.arms(cfg, `bond ${a1} ARMT`, "bond", [amt])); return;
    }
    case "serve": {
      const acct = arm();
      const min = str(opt["min-fee"]) ? parseTokens(str(opt["min-fee"])!) : 10n ** 18n;
      const fid = formSpec(cfg.form.repo, cfg.form.commit, cfg.form.path, readFileSync("forms/control-map-v1.txt")).formId;
      await write(acct, plans.arms(cfg, "serve form", "serve", [cfg.form.id ?? fid, min])); return;
    }
    case "stop": { const fid = cfg.form.id ?? formSpec(cfg.form.repo, cfg.form.commit, cfg.form.path, readFileSync("forms/control-map-v1.txt")).formId; await write(arm(), plans.arms(cfg, "stop serving", "stopServing", [fid])); return; }
    case "exit": await write(arm(), plans.arms(cfg, "request exit", "requestExit", [])); return;
    case "withdraw": await write(arm(), plans.arms(cfg, "withdraw unlocked bond", "withdraw", [])); return;
    case "post": {
      const acct = arm();
      const fid = cfg.form.id ?? formSpec(cfg.form.repo, cfg.form.commit, cfg.form.path, readFileSync("forms/control-map-v1.txt")).formId;
      const fee = parseTokens(str(opt.fee) ?? "1");
      const allowance = await chain.token<bigint>("allowance", acct.address, cfg.arms);
      if (allowance < 3n * fee) await execute(chain, acct, plans.approve(cfg, cfg.token, cfg.arms, 3n * fee), send);
      await write(acct, plans.arms(cfg, "post job", "post", [fid, BigInt(str(opt.chain) ?? cfg.chainId), getAddress(str(opt.target)!), BigInt(str(opt.block)!), fee])); return;
    }
    case "draw": await write(needKey(), plans.arms(cfg, `draw job ${a1}`, "draw", [job])); return;
    case "settle": await write(needKey(), plans.arms(cfg, `settle job ${a1}`, "settle", [job])); return;
    case "commit": {
      const acct = arm(); const me = acct.address.toLowerCase();
      const vals: Hex[] = (JSON.parse(readFileSync(str(opt.values)!, "utf8")) as string[]).map(encodeAnswer);
      const store = new SaltStore(cfg.saltsFile);
      const rec = store.prepare(SaltStore.id(cfg.chainId, cfg.arms, job, me), job, me, vals);
      const out = await write(acct, plans.arms(cfg, `commit job ${a1}`, "commit", [job, me, rec.hash]));
      if (out.sent && !out.error) store.mark(SaltStore.id(cfg.chainId, cfg.arms, job, me), "committed", out.hash);
      return;
    }
    case "reveal": {
      const acct = arm(); const me = acct.address.toLowerCase();
      const id = SaltStore.id(cfg.chainId, cfg.arms, job, me);
      const rec = new SaltStore(cfg.saltsFile).get(id);
      if (!rec) throw new Error(`no stored salt for job ${job}: nothing to reveal`);
      if (commitmentHash(job, me, rec.values, rec.salt) !== rec.hash) throw new Error("stored salt record is inconsistent");
      const out = await write(acct, plans.arms(cfg, `reveal job ${a1}`, "reveal", [job, me, rec.values, rec.salt, rec.evidenceURI]));
      if (out.sent && !out.error) new SaltStore(cfg.saltsFile).mark(id, "revealed", out.hash);
      return;
    }
    case "challenge": {
      const acct = arm();
      const key0 = Number(a2), claimed = encodeAnswer(a3!);
      const j = await chain.job(job);
      const [stored] = await chain.arms<[Hex, number]>("results", job, key0);
      const chk = await imdRequestCheck(chain, { formId: j.formId, key0, chainId: Number(j.targetChainId), target: j.target, atBlock: j.atBlock, stored, claimed });
      console.log(`IMD request check: ${chk.ok ? "PASS" : "FAIL"} blockers=${jsonSafe(chk.blockers)} onchainQuestionMatches=${chk.onchainQuestionMatches}`);
      if (!chk.ok && send) throw new Error("IMD request check failed: not paying");
      const fee = await chain.court<bigint>("fee"); const asset = await chain.court<Address>("feeAsset");
      const maxFee = str(opt["max-court-fee"]) ? parseTokens(str(opt["max-court-fee"])!) : fee;
      const stake = 2n * BigInt(j.feePerArm);
      await execute(chain, acct, plans.approve(cfg, cfg.token, cfg.arms, stake), send);
      if (fee > 0n) await execute(chain, acct, plans.approve(cfg, asset, cfg.arms, fee), send);
      await write(acct, plans.arms(cfg, `challenge job ${a1} key index ${key0}`, "challenge", [job, key0, claimed, maxFee])); return;
    }
    case "resolve": await write(needKey(), plans.arms(cfg, `resolve job ${a1}`, "resolve", [job, Number(a2), encodeAnswer(a3!)])); return;
    case "run": {
      const acct = accountFrom(keySrc);
      console.log(`arm ${acct.address}  mode ${send ? "SEND" : "DRY RUN (no commits are sent without --send)"}`);
      await runLoop(cfg, chain, { send, once: !!opt.once, account: acct, targetRpc, etherscanKey });
      return;
    }
    default: console.log(HELP); process.exitCode = 2;
  }
}
main().catch((e) => { console.error(`error: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0]}`); process.exit(1); });
