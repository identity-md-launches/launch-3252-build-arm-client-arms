# Review answers

## Finding 24373bc1 (low): live run sends reveal after a COMMIT timeout reopened the job to OPEN

**Holds. Fixed.**

Checked against `Arms.sol` at commit `ad0f0b4`: `timeout()` in `Phase.COMMIT` (lines 591-622) strikes and removes every
arm that has not committed and then calls `_reopen(j, Phase.OPEN)` (line 887), so the job goes back to OPEN with the
no-show's slot empty and `draw()` has to fill it again. `reveal()` reverts `WrongPhase()` in any phase but REVEAL
(line 565). The script's `waitPast(jobId, 2)` returned as soon as the phase left COMMIT, the only check after it was for
CANCELLED, and the reveal loop ran against a job in OPEN. In send mode `tx()` throws on the revert and the run exits 1
with the job left in OPEN. The case the earlier fix did cover, a foreign arm that commits but does not reveal, goes
through `_closeNoShow` and was not affected.

**Change.** The draw, commit and COMMIT-phase wait of one job now live in `live/job-flow.ts` as `drawAndCommit()`, over
an injected chain interface, and `live/live-run.ts` calls it. After the COMMIT wait the flow checks the phase: on OPEN it
logs the reopen and goes back to the draw step (re-draw until the phase is past OPEN, recompute drawn/own/foreign, commit
for any newly drawn own arm, wait again). It returns only once the job is past COMMIT and not OPEN. The CANCELLED check
and the reveal loop in `live-run.ts` are unchanged and now run only on a job that is in REVEAL or beyond. The
`waitPast()` helper moved into the same module unchanged. `dist/live-run.mjs` is rebuilt from the source.

**Test.** `test/live-flow.test.ts` drives `drawAndCommit()` with a fake job that follows the contract's rules
(commit moves to REVEAL when every drawn arm committed; timeout after the deadline removes the no-shows and reopens to
OPEN; draw in OPEN refills the slot and returns to COMMIT). The main case has two own arms and a foreign arm that never
commits: the test asserts the flow returns in REVEAL, sent timeout once, drew again, replaced the no-show, and did not
re-send the own commits. With the old fall-through behaviour the same test fails (`3 !== 1`: returned in OPEN). Further
cases: the re-draw picks one of the script's own arms, which then commits in the second round; a job cancelled after
the reopen is returned as CANCELLED and not revealed; a foreign arm that commits in time needs no timeout and no second
draw; `waitPast()` waits for the deadline before sending timeout and returns once the phase moves.

Not run on Sepolia (no funded wallet on this machine), as in the review.
