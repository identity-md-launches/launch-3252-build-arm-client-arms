// Phase control for one live-run job, from draw to the reveal phase, over injected chain reads and sends so it can be
// driven by a fake chain in tests. Arms.timeout() in COMMIT strikes every arm that has not committed and reopens the job
// to OPEN (Arms.sol _reopen), so a no-show foreign arm means the job must be drawn again, not revealed.
import type { Address } from "viem";
import { PHASES } from "../src/abi.js";

export const PHASE = { OPEN: PHASES.indexOf("OPEN"), COMMIT: PHASES.indexOf("COMMIT"), REVEAL: PHASES.indexOf("REVEAL"), CANCELLED: PHASES.indexOf("CANCELLED") } as const;

export interface JobFlowDeps {
  job(jobId: bigint): Promise<{ phase: number | bigint; deadline: number | bigint }>;
  armsOf(jobId: bigint): Promise<Address[]>;
  now(): Promise<bigint>;
  /** Sends draw(jobId); throws while the draw is not yet possible. */
  draw(jobId: bigint): Promise<unknown>;
  /** Sends timeout(jobId); throws while it is not yet possible. */
  timeout(jobId: bigint, phase: number): Promise<unknown>;
  /** Commits for one of this script's arms unless it already committed. */
  commit(arm: Address): Promise<void>;
  mine(addr: string): boolean;
  /** Called after every draw round with the drawn arms and the ones that are not this script's. */
  drawn(drawn: Address[], foreign: Address[]): void;
  log(s: string): void;
  sleep(ms: number): Promise<unknown>;
}

export interface DrawOutcome { drawn: Address[]; own: Address[]; foreign: Address[]; phase: number }

/** Wait while the job sits in `phase`; once its deadline has passed, call timeout() so no-shows (e.g. a foreign arm) are closed. */
export async function waitPast(d: JobFlowDeps, jobId: bigint, phase: number): Promise<void> {
  for (;;) {
    const j = await d.job(jobId); if (Number(j.phase) !== phase) return;
    if ((await d.now()) > BigInt(j.deadline)) {
      try { await d.timeout(jobId, phase); } catch (e: any) { d.log(`    timeout not yet possible: ${String(e.message).slice(0, 120)}`); }
      if (Number((await d.job(jobId)).phase) !== phase) return;
    }
    await d.sleep(15_000);
  }
}

/**
 * Draws the job, commits for this script's arms and waits out the COMMIT phase. Returns once the job has left both OPEN
 * and COMMIT: a COMMIT timeout that removes a no-show arm reopens the job to OPEN, and then the draw is run again and any
 * newly drawn own arm commits, until every drawn arm has committed (REVEAL) or the job is cancelled.
 */
export async function drawAndCommit(d: JobFlowDeps, jobId: bigint, tag: string): Promise<DrawOutcome> {
  for (;;) {
    // draw until a phase beyond OPEN (seed block must be mined first)
    for (let i = 0; i < 40; i++) {
      const j = await d.job(jobId); if (Number(j.phase) >= PHASE.COMMIT) break;
      try { await d.draw(jobId); } catch (e: any) { d.log(`    draw not yet possible: ${String(e.message).slice(0, 120)}`); await d.sleep(15_000); }
    }
    const drawn = await d.armsOf(jobId);
    d.log(`    drawn: ${drawn.join(", ")}`);
    const foreign = drawn.filter((a) => !d.mine(a));
    d.drawn(drawn, foreign);
    const own = drawn.filter((a) => d.mine(a));
    for (const a of own) await d.commit(a);
    if (foreign.length) await waitPast(d, jobId, PHASE.COMMIT);
    else for (let i = 0; i < 20 && Number((await d.job(jobId)).phase) === PHASE.COMMIT; i++) await d.sleep(5_000);
    const phase = Number((await d.job(jobId)).phase);
    if (phase === PHASE.OPEN) { d.log(`    ${tag}: job ${jobId} reopened to OPEN (a drawn arm did not commit before the deadline); drawing again`); continue; }
    return { drawn, own, foreign, phase };
  }
}
