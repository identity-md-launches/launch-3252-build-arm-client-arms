// SOURCE: fetch verified source of the code that runs at the target (Sourcify, then an Etherscan-style API).
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname, normalize, sep } from "node:path";
import { createHash } from "node:crypto";

export interface SourceBundle {
  provider: "sourcify" | "etherscan";
  address: string; chainId: number; contractName?: string; match?: string; compiler?: string;
  files: { path: string; sha256: string; lines: number }[]; dir: string; url: string;
}
export interface SourceAttempt { provider: string; url: string; ok: boolean; detail: string }
export interface SourceResult { address: string; bundle: SourceBundle | null; attempts: SourceAttempt[] }

export interface SourceOptions {
  outDir: string; etherscanApiKey?: string; etherscanBase?: string; sourcifyBase?: string; fetchImpl?: typeof fetch;
}

function safeRel(p: string): string {
  const n = normalize(p.replace(/^[a-z]+:\/\//i, "").replace(/^\/+/, "")).split(sep).filter((s) => s !== ".." && s !== "").join("/");
  return n || "source.sol";
}

async function save(dir: string, files: Record<string, string>): Promise<SourceBundle["files"]> {
  const out: SourceBundle["files"] = [];
  for (const [p, content] of Object.entries(files)) {
    const rel = safeRel(p);
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
    out.push({ path: rel, sha256: createHash("sha256").update(content).digest("hex"), lines: content.split("\n").length });
  }
  return out;
}

/** Fetch source for one address. Every attempt (including failures) is returned for the evidence file. */
export async function fetchSource(chainId: number, address: string, o: SourceOptions): Promise<SourceResult> {
  const f = o.fetchImpl ?? fetch;
  const addr = address.toLowerCase();
  const attempts: SourceAttempt[] = [];
  const dir = join(o.outDir, addr);
  const sBase = o.sourcifyBase ?? "https://sourcify.dev/server";
  const sUrl = `${sBase}/v2/contract/${chainId}/${address}?fields=sources,compilation`;
  try {
    const r = await f(sUrl, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) attempts.push({ provider: "sourcify", url: sUrl, ok: false, detail: `HTTP ${r.status}` });
    else {
      const j: any = await r.json();
      const srcs: Record<string, string> = {};
      for (const [p, v] of Object.entries<any>(j.sources ?? {})) srcs[p] = v.content ?? "";
      if (Object.keys(srcs).length === 0) attempts.push({ provider: "sourcify", url: sUrl, ok: false, detail: "no sources in response" });
      else {
        const files = await save(dir, srcs);
        attempts.push({ provider: "sourcify", url: sUrl, ok: true, detail: `match=${j.match ?? j.runtimeMatch ?? "?"}` });
        return { address: addr, attempts, bundle: { provider: "sourcify", address: addr, chainId, contractName: j.compilation?.name, match: j.match ?? j.runtimeMatch, compiler: j.compilation?.compilerVersion, files, dir, url: sUrl } };
      }
    }
  } catch (e: any) {
    attempts.push({ provider: "sourcify", url: sUrl, ok: false, detail: String(e?.message ?? e) });
  }
  if (o.etherscanApiKey) {
    const base = o.etherscanBase ?? "https://api.etherscan.io/v2/api";
    const shown = `${base}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=<redacted>`;
    try {
      const r = await f(`${base}?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${encodeURIComponent(o.etherscanApiKey)}`, { signal: AbortSignal.timeout(30_000) });
      const j: any = await r.json();
      const item = Array.isArray(j.result) ? j.result[0] : null;
      if (!item || !item.SourceCode) attempts.push({ provider: "etherscan", url: shown, ok: false, detail: String(typeof j.result === "string" ? j.result : j.message ?? "not verified") });
      else {
        let srcs: Record<string, string> = {};
        let raw: string = item.SourceCode;
        if (raw.startsWith("{{")) raw = raw.slice(1, -1);
        if (raw.startsWith("{")) {
          const parsed = JSON.parse(raw);
          const s = parsed.sources ?? parsed;
          for (const [p, v] of Object.entries<any>(s)) srcs[p] = v.content ?? String(v);
        } else srcs[`${item.ContractName || "Contract"}.sol`] = raw;
        const files = await save(dir, srcs);
        attempts.push({ provider: "etherscan", url: shown, ok: true, detail: "verified" });
        return { address: addr, attempts, bundle: { provider: "etherscan", address: addr, chainId, contractName: item.ContractName, compiler: item.CompilerVersion, files, dir, url: shown } };
      }
    } catch (e: any) {
      attempts.push({ provider: "etherscan", url: shown, ok: false, detail: String(e?.message ?? e).replace(o.etherscanApiKey, "<redacted>") });
    }
  } else attempts.push({ provider: "etherscan", url: "", ok: false, detail: "skipped: no API key configured" });
  return { address: addr, bundle: null, attempts };
}
