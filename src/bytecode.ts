// Bytecode inspection helpers: EIP-1167 clones, EIP-7702 designators, opcode scan.
import type { Hex } from "viem";

export const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export function parseDelegation(code: Hex): string | null {
  const m = /^0xef0100([0-9a-f]{40})$/i.exec(code);
  return m ? `0x${m[1]!.toLowerCase()}` : null;
}

/** EIP-1167 minimal proxy, including immutable-args variants that append data after the standard tail. */
export function parseMinimalProxy(code: Hex): { impl: string; variant: string } | null {
  const h = code.toLowerCase().slice(2);
  const a = /^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/.exec(h);
  if (a) return { impl: `0x${a[1]}`, variant: h.length === 90 ? "eip1167" : "eip1167+immutable-args" };
  const b = /^5f5f365f5f37365f73([0-9a-f]{40})5af43d5f5f3e6029573d5ffd5b3d5ff3/.exec(h);
  if (b) return { impl: `0x${b[1]}`, variant: "eip1167-push0" };
  // Solady-style / clones-with-immutable-args prefix: 3d61<len>3d81600a3d39f3 363d3d373d3d3d3d363d73<impl>5af4...
  const c = /363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/.exec(h);
  if (c && h.indexOf(c[0]) <= 40) return { impl: `0x${c[1]}`, variant: "eip1167-embedded" };
  return null;
}

function stripMetadata(h: string): string {
  if (h.length < 8) return h;
  const n = parseInt(h.slice(-4), 16) * 2;
  const start = h.length - 4 - n;
  if (n > 0 && start > 0 && /^a[1-6]/.test(h.slice(start, start + 2))) return h.slice(0, start);
  return h;
}

export interface Scan { delegatecall: boolean; selectors: Set<string>; }

/** Walk opcodes (skipping PUSH data) and collect DELEGATECALL presence and PUSH4 selectors. */
export function scan(code: Hex): Scan {
  const h = stripMetadata(code.slice(2).toLowerCase());
  const bytes = Buffer.from(h, "hex");
  const out: Scan = { delegatecall: false, selectors: new Set() };
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i]!;
    if (op === 0xf4) out.delegatecall = true;
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n === 4) out.selectors.add(bytes.subarray(i + 1, i + 5).toString("hex"));
      i += n;
    }
  }
  return out;
}
