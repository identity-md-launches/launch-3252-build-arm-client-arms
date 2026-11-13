// JSON-RPC access that records every call (method, inputs, result or error) for the evidence file.
import { createPublicClient, http, type Hex } from "viem";

export interface CallRecord {
  n: number;
  method: string;
  params: unknown[];
  result?: unknown;
  error?: string;
  rpcCode?: number;
}

export class RecordingRpc {
  readonly calls: CallRecord[] = [];
  private client;
  constructor(readonly url: string) {
    this.client = createPublicClient({ transport: http(url, { retryCount: 2, timeout: 30_000 }) });
  }
  /** Returns the result, or throws an Error whose message names the failed read ("#n method"). */
  async request<T = unknown>(method: string, params: unknown[]): Promise<T> {
    const rec: CallRecord = { n: this.calls.length + 1, method, params };
    this.calls.push(rec);
    try {
      const r = await (this.client as any).request({ method, params });
      rec.result = r;
      return r as T;
    } catch (e: any) {
      rec.rpcCode = typeof e?.code === "number" ? e.code : e?.cause?.code;
      rec.error = [e?.shortMessage ?? e?.message ?? String(e), e?.details].filter(Boolean).join(": ").split("\n")[0]!.slice(0, 300);
      const err = new ReadError(`read #${rec.n} ${method} failed: ${rec.error}`, rec);
      throw err;
    }
  }
  getCode(address: string, block: Hex) { return this.request<Hex>("eth_getCode", [address, block]); }
  getStorageAt(address: string, slot: Hex, block: Hex) { return this.request<Hex>("eth_getStorageAt", [address, slot, block]); }
  call(to: string, data: Hex, block: Hex) { return this.request<Hex>("eth_call", [{ to, data }, block]); }
}

export class ReadError extends Error {
  constructor(message: string, readonly record: CallRecord) { super(message); }
}

/** eth_call that may revert: returns {ok:false} for an execution revert, still throws ReadError for transport failure. */
export async function tryCall(rpc: RecordingRpc, to: string, data: Hex, block: Hex): Promise<{ ok: true; data: Hex } | { ok: false; why: string }> {
  try {
    return { ok: true, data: await rpc.call(to, data, block) };
  } catch (e) {
    if (e instanceof ReadError && (e.record.rpcCode === 3 || /revert|execution|invalid opcode|out of gas|stack/i.test(e.record.error ?? ""))) {
      return { ok: false, why: e.record.error ?? "revert" };
    }
    throw e;
  }
}
