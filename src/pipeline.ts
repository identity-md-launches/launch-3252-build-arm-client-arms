// Answer all 13 keys for one (chain, target, block): reader -> source -> agent.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, type Hex } from "viem";
import { readKeys, type ReaderOutput } from "./reader.js";
import { fetchSource, type SourceResult } from "./source.js";
import { prepareJobDir, runAgent, validateAgentOutput, unknownKeys8to13, evidenceDigest } from "./agent.js";
import { decodeAnswer, UNKNOWN } from "./keys.js";
import type { ArmsConfig } from "./config.js";

export interface JobAnswers { values: Hex[]; evidencePath: string; digest: string; reader: ReaderOutput; problems: string[] }

export const evidenceUriOf = (digest: string) => `arms-evidence:sha256:${digest}`; // <= 200 bytes

const wordAddr = (w: Hex) => getAddress(`0x${w.slice(26)}`);

export async function sourceTargets(reader: ReaderOutput, target: string): Promise<{ address: string; role: string }[]> {
  const out: { address: string; role: string }[] = [];
  const k2 = reader.keys[1]!, k3 = reader.keys[2]!;
  if (k2.answer.startsWith("0x") && BigInt(k2.value) !== 0n) out.push({ address: wordAddr(k2.value), role: "implementation (code that runs)" });
  if (!out.length || reader.keys[0]!.answer === "YES") out.push({ address: target, role: out.length ? "proxy (target)" : "target" });
  if (k3.answer.startsWith("0x")) out.push({ address: wordAddr(k3.value), role: "proxy admin or beacon" });
  return out;
}

export async function answerJob(cfg: ArmsConfig, o: { chainId: number; target: string; block: bigint; rpcUrl: string; dir: string; etherscanKey?: string; skipAgent?: boolean }): Promise<JobAnswers> {
  mkdirSync(o.dir, { recursive: true });
  const reader = await readKeys({ chainId: o.chainId, target: o.target, block: o.block, rpcUrl: o.rpcUrl });
  const targets = await sourceTargets(reader, o.target);
  const sources: SourceResult[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.address.toLowerCase())) continue; seen.add(t.address.toLowerCase());
    const s = await fetchSource(o.chainId, t.address, { outDir: join(o.dir, "sources"), etherscanApiKey: o.etherscanKey, etherscanBase: cfg.etherscanBase });
    (s as any).role = t.role;
    sources.push(s);
  }
  // Keys 8..13 are about the code that runs; if that source cannot be read they are UNKNOWN.
  const runs = sources[0]!;
  let tail: ReturnType<typeof unknownKeys8to13>;
  if (reader.keys[0]!.answer === "NOT_APPLICABLE") {
    // no code at target: every key has no subject
    const { NOT_APPLICABLE } = await import("./keys.js");
    tail = { values: Array(6).fill(NOT_APPLICABLE) as Hex[], problems: ["no code at target"], evidence: [] };
  } else if (!runs.bundle || o.skipAgent) {
    tail = unknownKeys8to13(runs.bundle ? "agent skipped" : "no verified source could be read for the code that runs");
  } else {
    prepareJobDir(o.dir, { chainId: o.chainId, target: o.target, block: o.block.toString(), blockHash: reader.blockHash, readerKeys: reader.keys.map((k) => ({ key: k.key, name: k.name, answer: k.answer })), sourceRoles: sources.map((s: any) => ({ address: s.address, role: s.role })) }, sources);
    const res = await runAgent(cfg, o.dir);
    tail = res.raw ? validateAgentOutput(res.raw) : unknownKeys8to13(`agent produced no valid answers.json (${res.log.slice(-200).replace(/\s+/g, " ")})`);
  }
  const values = [...reader.keys.map((k) => k.value), ...tail.values];
  const evidence = {
    chainId: o.chainId, target: o.target, block: o.block.toString(), blockHash: reader.blockHash,
    keys: values.map((v, i) => ({ key: i + 1, answer: decodeAnswer(v), word: v })),
    reader, sources: sources.map((s) => ({ address: s.address, role: (s as any).role, attempts: s.attempts, bundle: s.bundle && { ...s.bundle, dir: undefined } })),
    agent: { problems: tail.problems, evidence: tail.evidence },
  };
  const evidencePath = join(o.dir, "evidence.json");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  return { values, evidencePath, digest: evidenceDigest(evidence), reader, problems: tail.problems };
}
export { UNKNOWN };
