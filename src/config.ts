// One config file holds every address and setting. Secrets are never in it: it only names where a key lives.
import { readFileSync } from "node:fs";
import { getAddress, type Hex } from "viem";

export interface ArmsConfig {
  chainId: number;
  rpcUrl?: string;            // public/provider URL; may be omitted if rpcUrlEnv is set
  rpcUrlEnv?: string;         // name of an env var holding the URL (useful when the URL embeds an API key)
  arms: Hex; court: Hex; token: Hex;
  form: { id?: Hex; repo: string; commit: string; path: string };
  key?: { file?: string; env?: string };           // where the operator's key lives; the value is never read except to sign
  saltsFile: string;                               // local salt store
  sourcesDir: string; evidenceDir: string;
  etherscanKeyEnv?: string; etherscanBase?: string;
  skillPath: string;
  agent?: { command?: string[]; timeoutSeconds?: number; passEnv?: string[] }; // command run with the job dir, writes answers.json; passEnv: extra env names the agent may see
  pollSeconds: number;
  readerRpc: { [chainId: string]: string };        // RPC URL per target chain, for reading targets
}

export function loadConfig(path: string): ArmsConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const need = (k: string) => { if (raw[k] === undefined) throw new Error(`config ${path}: missing "${k}"`); return raw[k]; };
  const cfg: ArmsConfig = {
    chainId: Number(need("chainId")),
    rpcUrl: raw.rpcUrl, rpcUrlEnv: raw.rpcUrlEnv,
    arms: getAddress(need("arms")).toLowerCase() as Hex,
    court: getAddress(need("court")).toLowerCase() as Hex,
    token: getAddress(need("token")).toLowerCase() as Hex,
    form: need("form"),
    key: raw.key,
    saltsFile: raw.saltsFile ?? ".arms/salts.json",
    sourcesDir: raw.sourcesDir ?? ".arms/sources",
    evidenceDir: raw.evidenceDir ?? ".arms/evidence",
    etherscanKeyEnv: raw.etherscanKeyEnv, etherscanBase: raw.etherscanBase,
    skillPath: raw.skillPath ?? "skills/control-map-source/SKILL.md",
    agent: raw.agent,
    pollSeconds: Number(raw.pollSeconds ?? 20),
    readerRpc: raw.readerRpc ?? {},
  };
  return cfg;
}

export function rpcUrlOf(cfg: ArmsConfig): string {
  const u = cfg.rpcUrlEnv ? process.env[cfg.rpcUrlEnv] : cfg.rpcUrl;
  if (!u) throw new Error(cfg.rpcUrlEnv ? `env var ${cfg.rpcUrlEnv} (rpcUrlEnv) is not set` : "config has no rpcUrl");
  return u;
}
