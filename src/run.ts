// `arms run`: watch for draws naming this arm, answer, commit, reveal. Restart-safe through the salt store.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Account, Address, Hex } from "viem";
import { armsAbi } from "./abi.js";
import { Chain, execute, plans } from "./chain.js";
import { SaltStore } from "./salts.js";
import { answerJob, evidenceUriOf } from "./pipeline.js";
import type { ArmsConfig } from "./config.js";

export interface RunOpts { send: boolean; once?: boolean; account: Account; targetRpc: (chainId: number) => string; etherscanKey?: string; answer?: typeof answerJob; log?: (s: string) => void; lookbackBlocks?: bigint }

interface RunState { nextBlock: string; jobs: number[] }

/** Jobs where this arm is a main arm or the tie breaker and the job is still in a phase where it owes an action. */
export async function runOnce(cfg: ArmsConfig, chain: Chain, o: RunOpts, store: SaltStore, statePath: string): Promise<string[]> {
  const log = o.log ?? console.log;
  const me = o.account.address.toLowerCase() as Address;
  const actions: string[] = [];
  const state: RunState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { nextBlock: "0", jobs: [] };
  const head = await chain.pub.getBlockNumber();
  let from = BigInt(state.nextBlock) || (head > (o.lookbackBlocks ?? 20000n) ? head - (o.lookbackBlocks ?? 20000n) : 0n);
  const jobs = new Set<number>(state.jobs);
  for (let s = from; s <= head; s += 5000n) {
    const e = s + 4999n > head ? head : s + 4999n;
    const logs = await chain.pub.getContractEvents({ address: cfg.arms, abi: armsAbi, eventName: "Drawn", fromBlock: s, toBlock: e });
    for (const l of logs as any[]) if (String(l.args.arm).toLowerCase() === me) jobs.add(Number(l.args.jobId));
  }
  state.nextBlock = (head + 1n).toString();

  for (const n of [...jobs]) {
    const jobId = BigInt(n);
    const j = await chain.job(jobId);
    const phase = Number(j.phase);
    const tie = String(j.tieBreaker).toLowerCase() === me;
    const id = SaltStore.id(cfg.chainId, cfg.arms, jobId, me);
    const rec = store.get(id);
    const e = await chain.entry(jobId, me);
    const now = await chain.now();
    const inCommit = tie ? phase === 5 : phase === 2;
    const inReveal = tie ? phase === 6 : phase === 3;

    if (phase >= 7) { if (!rec || rec.stage === "revealed" || phase === 8) { jobs.delete(n); } continue; }
    if (inCommit && !e.committed) {
      if (now > BigInt(j.deadline)) { log(`job ${n}: commit window closed`); continue; }
      let r = rec;
      if (!r) {
        log(`job ${n}: answering ${j.target} at block ${j.atBlock} on chain ${j.targetChainId}`);
        const ans = await (o.answer ?? answerJob)(cfg, { chainId: Number(j.targetChainId), target: j.target, block: BigInt(j.atBlock), rpcUrl: o.targetRpc(Number(j.targetChainId)), dir: join(dirname(statePath), "jobs", String(n)), etherscanKey: o.etherscanKey });
        let values = ans.values;
        if (tie) { const mask = Number(j.disputedMask); values = values.filter((_, k) => (mask & (1 << k)) !== 0); }
        // Persist salt and answers BEFORE sending the commit: a crash here cannot orphan a commit.
        r = store.prepare(id, jobId, me, values, evidenceUriOf(ans.digest));
        log(`job ${n}: salt and answers stored (${ans.problems.length} agent problems)`);
      }
      const out = await execute(chain, o.account, plans.arms(cfg, `commit job ${n}`, "commit", [jobId, me, r.hash]), o.send, log);
      if (out.sent && !out.error) { store.mark(id, "committed", out.hash); actions.push(`commit ${n}`); }
    } else if (e.committed && rec && rec.stage === "prepared") {
      store.mark(id, "committed"); // committed on chain before a crash could record it
    }
    if (inReveal && e.committed && !e.revealed) {
      if (!rec) { log(`job ${n}: committed on chain but no local salt record: cannot reveal`); continue; }
      if (now > BigInt(j.deadline)) { log(`job ${n}: reveal window closed`); continue; }
      if (e.commitHash.toLowerCase() !== rec.hash.toLowerCase()) { log(`job ${n}: on-chain commit hash differs from the stored one; refusing to reveal`); continue; }
      const out = await execute(chain, o.account, plans.arms(cfg, `reveal job ${n}`, "reveal", [jobId, me, rec.values, rec.salt, rec.evidenceURI]), o.send, log);
      if (out.sent && !out.error) { store.mark(id, "revealed", out.hash); actions.push(`reveal ${n}`); }
    }
  }
  state.jobs = [...jobs];
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state));
  return actions;
}

export async function runLoop(cfg: ArmsConfig, chain: Chain, o: RunOpts) {
  const store = new SaltStore(cfg.saltsFile);
  const statePath = join(dirname(cfg.saltsFile), "run-state.json");
  const log = o.log ?? console.log;
  for (;;) {
    try { await runOnce(cfg, chain, o, store, statePath); } catch (e: any) { log(`run: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0]}`); }
    if (o.once) return;
    await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
  }
}
