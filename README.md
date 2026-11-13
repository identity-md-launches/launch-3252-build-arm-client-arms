# arms-client

Client for **Arms v1**, the bonded checking protocol live on Sepolia. An *arm* is a bonded agent that answers the 13 keys
of **Control Map v1** (`forms/control-map-v1.txt`) about a contract at one block. This repo contains:

| Part | Where | Job |
| --- | --- | --- |
| Reader | `src/reader.ts`, `src/rpc.ts`, `src/bytecode.ts` | Keys 1 to 7 from JSON-RPC at the pinned block only, plus an evidence JSON listing every call |
| Source | `src/source.ts` | Verified source of the code that runs (Sourcify, then an Etherscan-style API if you give a key) |
| Skill | `skills/control-map-source/SKILL.md` | Tells a Claude Code / Codex agent how to answer keys 8 to 13 from that source |
| Chain client + CLI | `src/chain.ts`, `src/cli.ts`, `src/salts.ts`, `src/wallet.ts`, `src/oracle.ts` | The `arms` command |
| Arm runner | `src/run.ts`, `src/pipeline.ts`, `src/agent.ts` | `arms run`: draw → reader → source → agent → commit → reveal, restart-safe |
| Live run | `live/live-run.ts` | Scripted Sepolia run with real oracle ruling and `report.md` |
| Tests | `test/` | 20 planted contracts on a local anvil chain, unit tests, expected answers for scoring an agent |

Contracts: Arms `0x0cc4cab99c475973f658a64814b8b020e7f32e30`, IMDCourt `0x14e2d8744f4fdaedcb13578dbbb1a7e4ac183a31`,
ARMT `0x60f0592275d89034eab8e5aa3023349275aabc37`, chain 11155111, from
`identity-md-launches/launch-3247-deploy-arms-v1-sepolia` at `ad0f0b417c11d8c713641351b76afdc2fa5bf57f` (ABIs in `src/abi/`
come from `forge build` of that commit).

## Install

Node 20 or newer. `dist/arms.mjs` and `dist/live-run.mjs` are committed bundles that include viem, so running needs no install:

```
node dist/arms.mjs --help
```

To rebuild or run the tests: `npm ci && npm run build && npm test` (tests need `anvil` from Foundry on PATH).
The 20 planted contracts are precompiled into `test/fixtures/planted.json`; `SOLC=/path/to/solc-0.8.26 npm run fixtures` recompiles them.

## Config

Copy `arms.config.example.json` to `arms.config.json`. All addresses live in this one file. It never holds a secret, only
*where* one is: `key.file` (path) or `key.env` (variable name), `rpcUrlEnv` if the RPC URL embeds an API key,
`etherscanKeyEnv` (variable name) for the Etherscan-style fallback, `readerRpc` (RPC per target chain, used to read targets),
and `agent.command` / `agent.passEnv` (see below).

## Commands

```
arms [--config F] [--send] [--key-file F | --key-env VAR] <command>
status [job]  verdict <job>  watch [--once]
bond <ARMT>  serve [--min-fee ARMT]  stop  exit  withdraw
post --target 0x.. --block N [--chain N] [--fee ARMT]  draw <job>  commit <job> --values answers.json  reveal <job>  settle <job>
challenge <job> <keyIndex0> <value> [--max-court-fee X]  resolve <job> <keyIndex0> <value>
run [--once]
read --chain N --target 0x.. --block N [--rpc URL] [--out evidence.json]     source --chain N --target 0x..     form     score <got.json> <expected.json>
```

Every write prints sender, target contract, function, arguments, a simulation result and a gas estimate, and **sends nothing
without `--send`**. A transaction whose simulation fails is not sent. `challenge` first builds the oracle question, checks it
equals what `IMDCourt.question` returns on chain, and calls IMD's request check (`POST https://api.imd.fun/requests/check`);
with `--send` it refuses to pay if the check has blockers. Key indices are zero based (`values[0]` is Key 1).

Salts: `commit` and `run` write the salt, the answers and the commitment to `saltsFile` (mode 0600, atomic) **before** the
commit transaction is sent. A later `reveal` reads that file, so it always matches its commit, also after a crash.
`commit --values` refuses a file that the contract would reject at reveal: it must hold exactly 13 values (only the disputed
keys for a tie-break draw), each legal for its key.

## Running an arm

1. Fund an arm wallet with Sepolia ETH and ARMT; keep its key in a file (`chmod 600`) or an env var.
2. `arms --send bond 500` then `arms --send serve --min-fee 1`.
3. Choose how keys 8 to 13 are answered. `agent.command` is run with the job directory as working directory and `ARMS_JOB_DIR`,
   `ARMS_SKILL` in the environment; `{jobdir}`, `{skill}`, `{prompt}` are substituted. The agent does **not** inherit your
   environment: it gets only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TERM`, `TMPDIR`, `TZ`, plus any names
   you list in `agent.passEnv` (for example `["ANTHROPIC_API_KEY"]`). The `key.env` / `--key-env`, `rpcUrlEnv` and `etherscanKeyEnv`
   variables are always removed, even if listed. The default is
   `claude -p "{prompt}" --permission-mode acceptEdits --add-dir {jobdir}`. It must write `answers.json` as `SKILL.md` describes.
   Use absolute paths for your own scripts. Invalid, missing or evidence-less answers become UNKNOWN (an abstention), never a guess.
   If no source can be read, keys 8 to 13 are UNKNOWN and the agent is not called.
4. `arms --send run`. It scans `Drawn` events for this arm, reads keys 1 to 7, fetches source, runs the agent, stores salt and
   answers, commits, and reveals once the phase is `REVEAL`. A tie-break draw is answered for the disputed keys only. Without
   `--send` it is a dry run and commits nothing. Restart it at any time; progress is in `saltsFile` and `run-state.json` beside it.

Evidence per job is written to `<dir of saltsFile>/jobs/<job>/evidence.json` (reader calls with inputs and results, source
attempts, agent evidence marked fact/inference). The 200-byte reveal evidence URI is `arms-evidence:sha256:<digest of that file>`.
Publish the file yourself if you want others to check it.

## Live run on Sepolia

`node dist/live-run.mjs --config arms.config.json --key-file ./funder.key` is a **dry run**; add `--send` to execute. One
funded wallet (the funder) registers the form, creates `wallets/arm1..3.key` and `wallets/challenger.key` (the folder is
git-ignored, keys are mode 0600 and never printed), funds them, bonds 500 ARMT each and serves at 1e18, runs job one (honest, on
imdTEST, a verified Sepolia contract) and job two (all drawn arms agree on the wrong Key 9 value, index 8; the challenger
runs the IMD request check, pays the oracle fee in imdTEST, waits for the real ruling, anyone calls `resolve`). It writes
`report.md` with every transaction hash, the callback gas, time to ruling and mismatches with IMD's docs. It resumes from
`wallets/live-state.json` if interrupted or if the ruling has not arrived (`--ruling-timeout-min`). It never uses `MockCourt`.

**What the funder needs** (the dry run prints the live numbers): about **0.35 Sepolia ETH** (gas for ~60 transactions plus
0.05 ETH per arm and 0.08 for the challenger, tunable with `--eth-per-arm`, `--eth-challenger`), about **1,510 ARMT**
(1,500 bonded, 2 stake, 6 job fees, slack), and **1 imdTEST** (oracle fee 0.5 per challenge, read from the court). ARMT is
held by the MockToken owner. imdTEST is mintable only by IMD's owner/minters (`ImdTest.mint`), so ask IMD for it. Keys 8 to 13 for the honest
check come from your agent; pass `--honest-file answers.json` (`{"8":"NO","9":"YES",...}`) to supply them instead.
Job two needs a TRUE Key 9 answer so the claimed value is right; the script stops if it is UNKNOWN. The honest answers are read
at each job's own `atBlock` (once per job, kept in `wallets/live-state.json`), so the evidence in `wallets/honest-job1/` and
`wallets/honest-job2/` is for the block that job was posted for. If the draw picks an arm that is not one of the script's
wallets, the script commits and reveals only for its own arms, notes it in the report, waits for the phase deadline and calls
`timeout`; a job that ends cancelled is posted again on the next run.

**Status: the live run has not been executed.** This build environment had no funded Sepolia wallet, so there is no `report.md`; the
script was exercised as a dry run against live Sepolia (preflight, form check, balances, court config) only. Known differences
found while reading the contracts and docs, which the report also records when it runs: `Intake.callbackGas()` is 1,000,000 on
Sepolia while the pinned IMD skill documents 200,000; the form registers at the URI
`…/launch-3247-deploy-arms-v1-sepolia/ad0f0b41…/forms/control-map-v1.txt` (same formula as `script/prepare_control_map.py`, whose
`REPO` constant names `launch-3241-build-test-deploy-sepolia`; change `form.repo`/`form.commit` in the config to register against that repo instead).

## Tests and scoring an agent

`npm test` runs: the reader against **20 planted contracts** (plain, transparent proxy, UUPS, beacon, EIP-1167 clones with and
without immutable args, renounced owner, owner chains of 2, 3 and too many hops, an EIP-7702 delegated wallet, and mixes) and
requires keys 1 to 7 exactly right on all 20; failed-read UNKNOWN; encoding against the form's constants; salts and restart
between commit and reveal; agent-output validation; key-handling.

`test/fixtures/expected.json` has the answers to all 13 keys for each of the 20. To score an agent on keys 8 to 13:

```
node scripts/score-jobs.mjs /tmp/jobs                   # one job dir per contract (Planted.sol + task.json)
# run your agent in each /tmp/jobs/<name> with the skill; it writes answers.json
node scripts/collect-answers.mjs /tmp/jobs /tmp/got.json
node dist/arms.mjs score /tmp/got.json test/fixtures/expected.json
```

The bar: **18 of 20 contracts fully right on keys 8 to 13 and no miss on Key 8 (upgrade) or Key 9 (mint)**; an UNKNOWN on those
two keys counts as a miss. Interpretation notes: the 7702 wallet counts as `YES` for Key 8 because its key can re-delegate; a
one-shot genesis `seed` is not a mint path.

## What the tool will never do with a key

- Read a key from anywhere except the file path or environment variable name you give (flag or config).
- Print, log, or put a key (or an RPC URL that may embed one) in an error, evidence file, report or config. Evidence keeps only the RPC origin.
- Write a key anywhere except `wallets/*.key` created by the live script, mode 0600, in a git-ignored folder.
- Send a transaction without `--send`, send one whose simulation failed, or pass a key to the agent. The agent gets a job directory and an
  allow-listed environment (see "Running an arm"); the key, RPC-URL and explorer-key variables are always stripped from it.
- Read chain state from an explorer. Only JSON-RPC at the pinned block; Sourcify/Etherscan are used for source text only.

## Review

No independent reviewer process was available in this run, so this is a self-review; treat it as less than independent. Found and fixed:
local-chain revert errors were not classified as reverts (found by the 20-contract test; now JSON-RPC code 3); the receipt polling made the
harness crawl; Sourcify rejected one field selector (found against live Sepolia); the agent ran with a relative job path from inside the job dir
(found by the end-to-end run with a stand-in agent); `run` could reveal with a salt whose hash differs from the on-chain commit (now refused).
An independent review of the first submission reported six findings, all reproduced and fixed: the agent subprocess inherited
the whole environment, including a `--key-env` key (now an allow-list, see above); a beacon proxy that also mirrors its
implementation in the EIP-1967 implementation slot was read as UUPS, making Keys 3, 6, 7 `NOT_APPLICABLE` (the beacon slot now
wins; disagreeing slots give UNKNOWN for Key 2); Keys 4/5 were UNKNOWN on every proxy whose implementation has no `owner()` (the
absence proof now scans the resolved implementation); `commit --values` sent commitments the contract could never accept at reveal
(now length- and per-key-checked); agent answers breaking the form's Key 10 / Key 13 rules were committed (now forced to
`NOT_APPLICABLE` / `UNKNOWN` as the form says); the live run aborted when a foreign arm was drawn and read its honest answers at a
different block than it posted. Each has a test except the live-run two, which need Sepolia.
Open limits: Key 1 `NO` rests on slots, clone prefixes, a DELEGATECALL opcode scan and a loupe probe, not on source; Key 4 absence is
inferred from the executing bytecode having no `owner()` selector; a proxy with an unknown dispatcher is UNKNOWN; verified source is looked up by
address, not matched to the block's code hash; the live run and a real agent were not run end to end here.
