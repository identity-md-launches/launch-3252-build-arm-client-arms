// Local chain (anvil) with 20 planted contracts. Addresses are deterministic for a fresh chain.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, encodeFunctionData, encodeDeployData, type Abi, type Address, type Hex, parseAbi } from "viem";

export const planted: Record<string, { abi: Abi; bytecode: Hex }> = JSON.parse(readFileSync("test/fixtures/planted.json", "utf8"));
export const expected: Record<string, Record<string, string> & { desc: string }> = JSON.parse(readFileSync("test/fixtures/expected.json", "utf8"));

export interface Deployed { address: Address; refs: Record<string, string> }
export interface Chain20 { url: string; stop(): void; scenarios: Record<string, Deployed>; block: bigint }

export async function startAnvil(port: number): Promise<{ url: string; stop(): void }> {
  const p: ChildProcess = spawn("anvil", ["--port", String(port), "--silent", "--hardfork", "prague"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }); if (r.ok) break; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, stop: () => void p.kill() };
}

export async function deployAll(url: string): Promise<Chain20["scenarios"] & {}> {
  const pub = createPublicClient({ transport: http(url), pollingInterval: 20 });
  const accts = (await pub.request({ method: "eth_accounts" } as any)) as Address[];
  const [deployer, eoa1, eoa2, eoa3] = accts as [Address, Address, Address, Address];
  const wallet = createWalletClient({ account: deployer, transport: http(url) });
  const ZERO = "0x0000000000000000000000000000000000000000" as Address;
  const dep = async (name: string, args: unknown[] = []): Promise<Address> => {
    const c = planted[name]!;
    const data = args.length || (c.abi as any[]).some((x) => x.type === "constructor" && x.inputs.length) ? encodeDeployData({ abi: c.abi, bytecode: c.bytecode, args }) : c.bytecode;
    const hash = await wallet.sendTransaction({ data, chain: null, gas: 5_000_000n });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (!rc.contractAddress) throw new Error(`deploy ${name} failed`);
    return rc.contractAddress;
  };
  const raw = async (code: Hex): Promise<Address> => {
    const rc = await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ data: code, chain: null, gas: 1_000_000n }) });
    return rc.contractAddress!;
  };
  const initData = (o: Address) => encodeFunctionData({ abi: parseAbi(["function init(address)"]), args: [o] });
  const initOwned = async (a: Address, o: Address) => { await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ to: a, data: initData(o), chain: null }) }); };
  const out: Record<string, Deployed> = {};
  const clone = (impl: Address, extra = "") => {
    const body = `363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3${extra}`;
    const len = body.length / 2;
    const pre = extra ? `3d61${len.toString(16).padStart(4, "0")}80600b3d3981f3` : "3d602d80600a3d3981f3";
    return `0x${pre}${body}` as Hex;
  };

  out["01-plain-owned-eoa"] = { address: await dep("PlainOwned", [eoa1]), refs: { root4: eoa1 } };
  out["02-plain-renounced"] = { address: await dep("PlainOwned", [ZERO]), refs: { root4: ZERO } };
  out["03-plain-no-owner"] = { address: await dep("NoOwner"), refs: {} };
  out["04-open-mint-token"] = { address: await dep("OpenMint"), refs: {} };
  for (const [n, c] of [["05-capped-mint-token", "CappedMint"], ["06-pausable-token", "PausableTok"], ["07-tax-token", "TaxTok"], ["08-timelocked-mint-token", "TimelockMint"]] as const) {
    const a = await dep(c); await initOwned(a, eoa1); out[n] = { address: a, refs: { root4: eoa1 } };
  }
  // 09 transparent proxy over CappedMint, admin = ProxyAdmin owned by an EOA
  { const impl = await dep("CappedMint"); const admin = await dep("ProxyAdmin", [eoa2]);
    const p = await dep("TransparentProxy", [impl, admin, initData(eoa1)]);
    out["09-transparent-proxy"] = { address: p, refs: { impl, admin, root4: eoa1, root6: eoa2 } }; }
  // 10 UUPS over a vault, 11 UUPS pausable token
  for (const [n, c] of [["10-uups-vault", "UUPSVault"], ["11-uups-pausable-token", "UUPSPausable"]] as const) {
    const impl = await dep(c); const p = await dep("ERC1967Proxy", [impl, initData(eoa1)]);
    out[n] = { address: p, refs: { impl, root4: eoa1 } };
  }
  // 12 beacon owned by an EOA, 13 beacon owned by a multisig stub that is owned by an EOA
  { const impl = await dep("CappedMint"); const beacon = await dep("UpgradeableBeacon", [eoa2, impl]);
    out["12-beacon-proxy"] = { address: await dep("BeaconProxy", [beacon, initData(eoa1)]), refs: { impl, admin: beacon, root4: eoa1, root6: eoa2 } };
    const ms = await dep("Multisig", [eoa3]); const beacon2 = await dep("UpgradeableBeacon", [ms, impl]);
    out["13-beacon-proxy-multisig-admin"] = { address: await dep("BeaconProxy", [beacon2, initData(eoa1)]), refs: { impl, admin: beacon2, root4: eoa1, root6: eoa3 } }; }
  // 14 minimal proxy (1167) of a taxed token, 15 minimal proxy with immutable args
  { const impl = await dep("TaxTok"); const c = await raw(clone(impl)); await initOwned(c, eoa1);
    out["14-minimal-proxy"] = { address: c, refs: { impl, root4: eoa1 } };
    const impl2 = await dep("CloneTarget"); const c2 = await raw(clone(impl2, "11".repeat(32))); await initOwned(c2, eoa1);
    out["15-minimal-proxy-immutable-args"] = { address: c2, refs: { impl: impl2, root4: eoa1 } }; }
  // 16-18 owner chains
  { const m1 = await dep("Multisig", [eoa1]); out["16-owner-two-deep"] = { address: await dep("PlainOwned", [m1]), refs: { root4: eoa1 } };
    const a = await dep("Multisig", [eoa2]); const b = await dep("Multisig", [a]);
    out["17-owner-three-hops"] = { address: await dep("PlainOwned", [b]), refs: { root4: eoa2 } };
    const c1 = await dep("Multisig", [eoa3]); const c2 = await dep("Multisig", [c1]); const c3 = await dep("Multisig", [c2]);
    out["18-owner-chain-too-deep"] = { address: await dep("PlainOwned", [c3]), refs: {} }; }
  // 19 EOA with an EIP-7702 delegation designator to SimpleWallet
  { const w = await dep("SimpleWallet"); const eoa = "0x00000000000000000000000000000000000d7702" as Address;
    await pub.request({ method: "anvil_setCode", params: [eoa, `0xef0100${w.slice(2)}`] } as any);
    out["19-delegated-wallet"] = { address: eoa, refs: { delegate: w } }; }
  // 20 UUPS proxy, owner is a multisig stub, immediate upgrade + timelocked mint
  { const impl = await dep("UUPSTimelockMint"); const ms = await dep("Multisig", [eoa1]);
    const p = await dep("ERC1967Proxy", [impl, initData(ms)]);
    out["20-uups-timelock-mint-multisig-owner"] = { address: p, refs: { impl, root4: eoa1 } }; }
  return out;
}

export async function startChain20(port: number): Promise<Chain20> {
  const a = await startAnvil(port);
  const scenarios = await deployAll(a.url);
  const pub = createPublicClient({ transport: http(a.url) });
  return { ...a, scenarios, block: await pub.getBlockNumber() };
}

/** Resolve expected.json tokens (@impl, @admin, @root4, @root6) to values for a deployed scenario. */
export function resolveExpected(name: string, d: Deployed): Record<string, string> {
  const e = expected[name]!; const out: Record<string, string> = {};
  for (let k = 1; k <= 13; k++) { const v = e[String(k)]!; out[String(k)] = v.startsWith("@") ? (d.refs[v.slice(1)] ?? (() => { throw new Error(`${name}: missing ref ${v}`); })()) : v; }
  return out;
}
