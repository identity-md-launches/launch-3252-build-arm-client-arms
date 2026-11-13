// Chain client: read helpers and a write path that previews every transaction and sends only with the send flag.
import { createPublicClient, createWalletClient, http, formatUnits, parseUnits, type Abi, type Account, type Address, type Hex, type PublicClient } from "viem";
import { sepolia } from "viem/chains";
import { armsAbi, courtAbi, erc20Abi, formsAbi } from "./abi.js";
import type { ArmsConfig } from "./config.js";

export const jsonSafe = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

export interface TxPlan { label: string; to: Address; abi: Abi; functionName: string; args: unknown[] }
export interface TxOutcome { label: string; sent: boolean; hash?: Hex; gasEstimate?: bigint; gasUsed?: bigint; error?: string; status?: string; blockNumber?: bigint }

export class Chain {
  readonly pub: PublicClient;
  constructor(readonly cfg: ArmsConfig, readonly rpcUrl: string) {
    this.pub = createPublicClient({ chain: cfg.chainId === 11155111 ? sepolia : undefined, transport: http(rpcUrl, { retryCount: 3 }) }) as PublicClient;
  }
  read<T = any>(address: Address, abi: Abi, functionName: string, args: unknown[] = [], blockNumber?: bigint): Promise<T> {
    return this.pub.readContract({ address, abi, functionName, args, blockNumber } as any) as Promise<T>;
  }
  arms<T = any>(fn: string, ...args: unknown[]) { return this.read<T>(this.cfg.arms, armsAbi, fn, args); }
  court<T = any>(fn: string, ...args: unknown[]) { return this.read<T>(this.cfg.court, courtAbi, fn, args); }
  token<T = any>(fn: string, ...args: unknown[]) { return this.read<T>(this.cfg.token, erc20Abi, fn, args); }
  async forms<T = any>(fn: string, ...args: unknown[]) { return this.read<T>(await this.arms<Address>("formRegistry"), formsAbi, fn, args); }

  async job(id: bigint) {
    const r = (await this.arms<any[]>("jobs", id));
    const names = ["formId","targetChainId","target","atBlock","feePerArm","poster","keyCount","needed","phase","openSince","deadline","challengeEnd","seedBlock","drawNonce","drawSeed","postedBlock","serverCount","escrow","spent","overturned","slashedOnce","rewardPaid","released","reward","openChallenges","challengesOpened","tieBreaker","disputedMask","disputedCount"];
    return Object.fromEntries(names.map((n, i) => [n, r[i]])) as Record<string, any>;
  }
  async entry(jobId: bigint, arm: Address) {
    const r = await this.arms<any[]>("entries", jobId, arm);
    return { commitHash: r[0] as Hex, committed: r[1] as boolean, revealed: r[2] as boolean, evidence: r[3] as string };
  }
  async now(): Promise<bigint> { return (await this.pub.getBlock()).timestamp; }
}

export const fmt = (x: bigint, dec = 18) => formatUnits(x, dec);
export const parseTokens = (s: string) => parseUnits(s, 18);

export function describePlan(p: TxPlan, from?: Address): string {
  return [`  ${p.label}`, `    from:     ${from ?? "(no key)"}`, `    to:       ${p.to}`, `    function: ${p.functionName}`, `    args:     ${jsonSafe(p.args).replace(/\s+/g, " ")}`, `    value:    0`].join("\n");
}

/** Preview a plan (simulation + gas estimate); send only when `send` is true. Errors are returned, not thrown. */
export async function execute(chain: Chain, account: Account | undefined, plan: TxPlan, send: boolean, log: (s: string) => void = console.log): Promise<TxOutcome> {
  log(describePlan(plan, account?.address));
  const out: TxOutcome = { label: plan.label, sent: false };
  if (account) {
    try {
      const sim = await chain.pub.simulateContract({ account, address: plan.to, abi: plan.abi, functionName: plan.functionName, args: plan.args } as any);
      out.gasEstimate = await chain.pub.estimateContractGas({ account, address: plan.to, abi: plan.abi, functionName: plan.functionName, args: plan.args } as any);
      log(`    simulation: ok, gas estimate ${out.gasEstimate}`);
      void sim;
    } catch (e: any) {
      out.error = String(e?.shortMessage ?? e?.message ?? e).split("\n")[0];
      log(`    simulation: FAILED ${out.error}`);
    }
  } else log("    simulation: skipped (no key given)");
  if (!send) { log("    NOT SENT (dry run; pass --send to broadcast)"); return out; }
  if (!account) throw new Error("--send needs a key source");
  if (out.error) { log("    refusing to send a transaction whose simulation failed"); return out; }
  const wallet = createWalletClient({ account, chain: chain.cfg.chainId === 11155111 ? sepolia : undefined, transport: http(chain.rpcUrl) });
  const hash = await wallet.writeContract({ address: plan.to, abi: plan.abi, functionName: plan.functionName, args: plan.args, gas: out.gasEstimate ? (out.gasEstimate * 12n) / 10n : undefined } as any);
  out.sent = true; out.hash = hash;
  log(`    sent: ${hash}`);
  const rc = await chain.pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  out.status = rc.status; out.gasUsed = rc.gasUsed; out.blockNumber = rc.blockNumber;
  log(`    mined in block ${rc.blockNumber}: ${rc.status}, gas used ${rc.gasUsed}`);
  if (rc.status !== "success") out.error = "reverted on chain";
  return out;
}

export const plans = {
  approve: (cfg: ArmsConfig, token: Address, spender: Address, amount: bigint): TxPlan => ({ label: `approve ${fmt(amount)} to ${spender}`, to: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  arms: (cfg: ArmsConfig, label: string, functionName: string, args: unknown[]): TxPlan => ({ label, to: cfg.arms, abi: armsAbi, functionName, args }),
};
