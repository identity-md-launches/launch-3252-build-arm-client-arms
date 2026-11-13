import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { drawAndCommit, waitPast, PHASE, type JobFlowDeps } from "../live/job-flow.js";

const OWN1 = "0x1111111111111111111111111111111111111111" as Address, OWN2 = "0x2222222222222222222222222222222222222222" as Address;
const FOREIGN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address, FOREIGN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;

// A fake Arms job that follows Arms.sol at ad0f0b4: commit() moves to REVEAL once every drawn arm committed; timeout() in
// COMMIT after the deadline strikes and removes every arm that has not committed and reopens the job to OPEN (_reopen);
// draw() in OPEN fills the empty slot and moves back to COMMIT with a fresh deadline.
function fakeJob(opts: { replacement?: Address; replacementCommits?: boolean; drawFailsWith?: string; cancelOnDrawTry?: number } = {}) {
  const s = { phase: PHASE.COMMIT, deadline: 100n, now: 50n, arms: [OWN1, OWN2, FOREIGN_A] as Address[], committed: new Set<Address>(), draws: 0, timeouts: 0, commits: [] as Address[], logs: [] as string[], sleeps: 0 };
  const settleCommit = () => { if (s.arms.length && s.arms.every((a) => s.committed.has(a))) s.phase = PHASE.REVEAL; };
  const d: JobFlowDeps = {
    job: async () => ({ phase: s.phase, deadline: s.deadline }),
    armsOf: async () => [...s.arms],
    now: async () => s.now,
    draw: async () => {
      s.draws++;
      if (s.phase !== PHASE.OPEN) throw new Error("WrongPhase");
      if (opts.cancelOnDrawTry && s.draws >= opts.cancelOnDrawTry) { s.phase = PHASE.CANCELLED; s.arms = []; return; }
      if (opts.drawFailsWith) throw new Error(opts.drawFailsWith);
      s.arms.push(opts.replacement ?? FOREIGN_B); s.phase = PHASE.COMMIT; s.deadline = s.now + 100n;
    },
    timeout: async () => {
      s.timeouts++;
      if (s.now <= s.deadline) throw new Error("TooEarly");
      if (s.phase !== PHASE.COMMIT) throw new Error("WrongPhase");
      const before = s.arms.length; s.arms = s.arms.filter((a) => s.committed.has(a));
      if (s.arms.length === before) throw new Error("NotPending");
      s.phase = PHASE.OPEN; s.deadline = 0n; // _reopen(j, Phase.OPEN): the job must be drawn again
    },
    commit: async (a) => { if (s.phase !== PHASE.COMMIT) throw new Error("WrongPhase"); if (s.committed.has(a)) return; s.committed.add(a); s.commits.push(a); settleCommit(); },
    mine: (a) => a === OWN1 || a === OWN2,
    drawn: () => {},
    log: (l) => s.logs.push(l),
    sleep: async () => {
      s.sleeps++;
      s.now += 60n; // time passes while the script waits
      // the replacement foreign arm commits on its own once it is drawn
      if (opts.replacementCommits !== false && s.phase === PHASE.COMMIT && s.arms.includes(opts.replacement ?? FOREIGN_B) && !s.committed.has(opts.replacement ?? FOREIGN_B)) { s.committed.add(opts.replacement ?? FOREIGN_B); settleCommit(); }
    },
  };
  return { s, d };
}

test("live run: a foreign arm that never commits is timed out, the job reopens to OPEN, and the script draws again instead of revealing", async () => {
  const { s, d } = fakeJob();
  const r = await drawAndCommit(d, 7n, "job1");
  assert.equal(r.phase, PHASE.REVEAL, "returns only once the job is in REVEAL, never while it sits in OPEN");
  assert.equal(s.timeouts, 1, "timeout() was sent once the COMMIT deadline passed");
  assert.equal(s.draws, 1, "the job was drawn again after the reopen");
  assert.deepEqual(s.arms, [OWN1, OWN2, FOREIGN_B], "the no-show was replaced by the new draw");
  assert.deepEqual(r.own, [OWN1, OWN2]); assert.deepEqual(r.foreign, [FOREIGN_B]);
  assert.deepEqual(s.commits, [OWN1, OWN2], "own arms committed once; the second round did not re-send their commits");
  assert.ok(s.logs.some((l) => /reopened to OPEN/.test(l)), "the reopen is logged");
});

test("live run: the re-draw can pick one of the script's own arms, which then commits in the second round", async () => {
  const { s, d } = fakeJob({ replacement: OWN2 });
  s.arms = [OWN1, FOREIGN_A]; // first draw: one own arm and a foreign one that never commits
  const r = await drawAndCommit(d, 8n, "job2");
  assert.equal(r.phase, PHASE.REVEAL);
  assert.deepEqual(r.own, [OWN1, OWN2]); assert.deepEqual(r.foreign, []);
  assert.deepEqual(s.commits, [OWN1, OWN2], "the newly drawn own arm committed in the second round");
});

test("live run: a job cancelled after the reopen is returned as CANCELLED, not revealed", async () => {
  const { s, d } = fakeJob({ drawFailsWith: "TooLate", cancelOnDrawTry: 3 }); // fillDeadline passed, then someone cancels
  const r = await drawAndCommit(d, 9n, "job1");
  assert.equal(r.phase, PHASE.CANCELLED);
  assert.equal(s.timeouts, 1);
});

test("live run: a foreign arm that commits in time needs no timeout and one draw round", async () => {
  const { s, d } = fakeJob();
  s.committed.add(FOREIGN_A);
  const r = await drawAndCommit(d, 10n, "job1");
  assert.equal(r.phase, PHASE.REVEAL); assert.equal(s.timeouts, 0); assert.equal(s.draws, 0);
  assert.deepEqual(r.foreign, [FOREIGN_A]);
});

test("live run: waitPast returns as soon as the phase moves, and sends timeout only after the deadline", async () => {
  const { s, d } = fakeJob();
  s.committed.add(OWN1); s.committed.add(OWN2);
  await waitPast(d, 7n, PHASE.COMMIT);
  assert.equal(s.phase, PHASE.OPEN); assert.equal(s.timeouts, 1); assert.ok(s.sleeps >= 1, "waited while the deadline had not passed");
});
