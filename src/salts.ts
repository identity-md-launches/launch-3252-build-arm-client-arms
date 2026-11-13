// Local salt store: a reveal must match its commit, also after a restart.
// The salt and the answers are persisted (atomically, mode 0600) BEFORE the commit is sent.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { encodeAbiParameters, keccak256, type Hex } from "viem";

export type Stage = "prepared" | "committed" | "revealed";
export interface SaltRecord { salt: Hex; values: Hex[]; hash: Hex; stage: Stage; evidenceURI: string; commitTx?: string; revealTx?: string; updated: string }

export function commitmentHash(jobId: bigint, arm: string, values: Hex[], salt: Hex): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "bytes32[]" }, { type: "bytes32" }],
    [jobId, arm as Hex, values, salt]));
}

export class SaltStore {
  constructor(readonly path: string) {}
  private load(): Record<string, SaltRecord> {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
  }
  private save(d: Record<string, SaltRecord>) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
    const fd = openSync(tmp, "r+"); fsyncSync(fd); closeSync(fd);
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }
  static id(chainId: number, arms: string, jobId: bigint, arm: string) { return `${chainId}:${arms.toLowerCase()}:${jobId}:${arm.toLowerCase()}`; }
  get(id: string): SaltRecord | undefined { return this.load()[id]; }
  all() { return this.load(); }

  /** Create (once) the salt and commitment for this job/arm. A second call returns the stored record unchanged
   *  even when `values` differ, so a restart can never produce a commit that a later reveal cannot match. */
  prepare(id: string, jobId: bigint, arm: string, values: Hex[], evidenceURI = ""): SaltRecord {
    const d = this.load();
    if (d[id]) return d[id]!;
    const salt = `0x${randomBytes(32).toString("hex")}` as Hex;
    const rec: SaltRecord = { salt, values, hash: commitmentHash(jobId, arm, values, salt), stage: "prepared", evidenceURI, updated: new Date().toISOString() };
    d[id] = rec; this.save(d);
    return rec;
  }
  mark(id: string, stage: Stage, tx?: string) {
    const d = this.load(); const r = d[id];
    if (!r) throw new Error(`no salt record ${id}`);
    r.stage = stage; r.updated = new Date().toISOString();
    if (tx) { if (stage === "committed") r.commitTx = tx; else if (stage === "revealed") r.revealTx = tx; }
    this.save(d);
  }
}
