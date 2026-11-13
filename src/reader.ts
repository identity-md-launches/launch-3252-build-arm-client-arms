// READER: keys 1..7 of Control Map v1 for one target at one block, from JSON-RPC only.
import { type Hex, toHex, hexToBigInt, decodeAbiParameters, encodeFunctionData, getAddress, keccak256, toBytes } from "viem";
import { RecordingRpc, ReadError, tryCall, type CallRecord } from "./rpc.js";
import { encodeAddress, encodeLabel, NOT_APPLICABLE, UNKNOWN, KEY_NAMES, decodeAnswer } from "./keys.js";
import { parseDelegation, parseMinimalProxy, scan, ZERO_ADDR } from "./bytecode.js";

export const SLOT_IMPL: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const SLOT_BEACON: Hex = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
export const SLOT_ADMIN: Hex = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
export const SLOT_PROXIABLE: Hex = keccak256(toBytes("PROXIABLE"));
const SEL_OWNER: Hex = "0x8da5cb5b";
const SEL_IMPLEMENTATION: Hex = "0x5c60da1b";
const SEL_FACET_ADDRESSES: Hex = "0x52ef6b2c";

export interface KeyResultRow {
  key: number; name: string; value: Hex; answer: string; basis: string; failedRead?: string; reads: number[];
}
export interface ReaderOutput {
  chainId: number; target: string; block: string; blockHash: string | null; rpcUrl: string;
  keys: KeyResultRow[]; calls: CallRecord[]; notes: Record<string, unknown>;
}
export interface ReaderInput { chainId: number; target: string; block: bigint | number; rpcUrl: string; }

type Typed = "YES" | "NO" | "ZERO_ADDRESS" | "NO_CODE" | "DELEGATED_WALLET" | "CONTRACT";
type Val = { kind: "word"; value: Hex; basis: string } | { kind: "unknown"; failed: string; basis: string } | { kind: "na"; basis: string };
const NA = (basis: string): Val => ({ kind: "na", basis });
const UNK = (failed: string, basis: string): Val => ({ kind: "unknown", failed, basis });
const W = (value: Hex, basis: string): Val => ({ kind: "word", value, basis });

const addrOfWord = (w: Hex): string | null => {
  const h = w.slice(2).padStart(64, "0");
  return /^0{24}/.test(h) ? `0x${h.slice(24)}` : null; // non-address upper bits => not an address
};

interface Hop { ok: boolean; owner?: string; absent?: boolean; note: string; failed?: string }

export async function readKeys(inp: ReaderInput): Promise<ReaderOutput> {
  const rpc = new RecordingRpc(inp.rpcUrl);
  const block = toHex(inp.block);
  const target = getAddress(inp.target).toLowerCase();
  const notes: Record<string, unknown> = {};
  const rows: Val[] = Array.from({ length: 7 }, () => UNK("none", "not evaluated"));
  let blockHash: string | null = null;
  const failAll = (why: string, basis: string) => rows.forEach((_, i) => (rows[i] = UNK(why, basis)));

  try {
    const cid = Number(hexToBigInt(await rpc.request<Hex>("eth_chainId", [])));
    notes.rpcChainId = cid;
    if (cid !== inp.chainId) throw new Error(`RPC reports chain ${cid}, wanted ${inp.chainId}`);
    const hdr = await rpc.request<{ hash: string } | null>("eth_getBlockByNumber", [block, false]);
    blockHash = hdr?.hash ?? null;
  } catch (e: any) {
    failAll(e.message, "chain id / block header read failed");
    return finish();
  }

  const codeCache = new Map<string, Hex>();
  const codeOf = async (a: string) => {
    if (!codeCache.has(a)) codeCache.set(a, await rpc.getCode(a, block));
    return codeCache.get(a)!;
  };
  const lastN = () => rpc.calls[rpc.calls.length - 1]!.n;

  async function typeOf(a: string): Promise<{ t: Exclude<Typed, "YES" | "NO">; code: Hex }> {
    if (BigInt(a) === 0n) return { t: "ZERO_ADDRESS", code: "0x" };
    const code = await codeOf(a);
    if (code === "0x") return { t: "NO_CODE", code };
    if (parseDelegation(code)) return { t: "DELEGATED_WALLET", code };
    return { t: "CONTRACT", code };
  }

  /** selectors present in the code that executes at `a` (following a 7702 delegation and a 1167 clone). */
  async function effectiveSelectors(a: string): Promise<{ has: boolean; hasDelegatecall: boolean }> {
    let code = await codeOf(a);
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = parseDelegation(code) ?? parseMinimalProxy(code)?.impl;
      if (!d) break;
      seen.push(d);
      code = await codeOf(d);
    }
    const s = scan(code);
    // A proxy forwards owner() wherever it points; treat delegatecall code as possibly having it.
    return { has: s.selectors.has(SEL_OWNER.slice(2)), hasDelegatecall: s.delegatecall };
  }

  async function ownerHop(a: string): Promise<Hop> {
    const r = await tryCall(rpc, a, SEL_OWNER, block);
    const n = lastN();
    if (r.ok) {
      if (r.data.length === 66) {
        const o = addrOfWord(r.data);
        if (o) return { ok: true, owner: o, note: `read #${n}: owner() returned ${o}` };
        return { ok: false, failed: `read #${n} eth_call owner()`, note: "owner() returned a word that is not an address" };
      }
      if (r.data === "0x") {
        const e = await effectiveSelectors(a);
        if (!e.has && !e.hasDelegatecall) return { ok: true, absent: true, note: `read #${n}: empty return and no owner() selector in code` };
      }
      return { ok: false, failed: `read #${n} eth_call owner()`, note: `unexpected return ${r.data.slice(0, 80)}` };
    }
    const e = await effectiveSelectors(a);
    if (!e.has && !e.hasDelegatecall) {
      return { ok: true, absent: true, note: `read #${n}: owner() reverted and the executing bytecode has no owner() selector (0x8da5cb5b)` };
    }
    return { ok: false, failed: `read #${n} eth_call owner()`, note: "owner() reverted but bytecode may expose it or forwards by delegatecall: absence not proven" };
  }

  /** Owner walk from `start`: at most three successful owner() hops. */
  async function ownerRoot(start: string, startIsRootIfNoOwner: boolean): Promise<{ root: string | null; absentAtStart: boolean; fail?: string; trail: string[] }> {
    const trail: string[] = [];
    const seen = new Set<string>([start]);
    let cur = start;
    let hops = 0;
    for (;;) {
      if (BigInt(cur) === 0n) return { root: cur, absentAtStart: false, trail };
      const t = await typeOf(cur);
      if (t.t === "NO_CODE" ) {
        if (cur === start) return { root: startIsRootIfNoOwner ? cur : null, absentAtStart: true, trail };
        return { root: cur, absentAtStart: false, trail };
      }
      const h = await ownerHop(cur);
      trail.push(`${cur}: ${h.note}`);
      if (!h.ok) return { root: null, absentAtStart: false, fail: h.failed, trail };
      if (h.absent) {
        if (cur === start) return { root: startIsRootIfNoOwner ? cur : null, absentAtStart: true, trail };
        return { root: cur, absentAtStart: false, trail };
      }
      const nxt = h.owner!;
      hops++;
      if (seen.has(nxt)) return { root: null, absentAtStart: false, fail: `cycle at ${nxt}`, trail };
      seen.add(nxt);
      if (hops === 3) {
        // Third hop landed on nxt. It is a root only if it is zero, has no code, or provably has no owner().
        if (BigInt(nxt) === 0n) return { root: nxt, absentAtStart: false, trail };
        const t3 = await typeOf(nxt);
        if (t3.t === "NO_CODE") return { root: nxt, absentAtStart: false, trail };
        const h3 = await ownerHop(nxt);
        trail.push(`${nxt}: ${h3.note} (budget check, not a hop)`);
        if (h3.ok && h3.absent) return { root: nxt, absentAtStart: false, trail };
        return { root: null, absentAtStart: false, fail: h3.failed ?? "third-hop contract's ownership chain continues (hop budget exhausted)", trail };
      }
      cur = nxt;
    }
  }

  const typeWord = (t: string): Hex => encodeLabel(t);

  try {
    const code = await codeOf(target);
    const codeRead = lastN();
    notes.targetCodeBytes = (code.length - 2) / 2;
    notes.targetCodeHash = code === "0x" ? null : keccak256(code);

    // ---- keys 1-3 ----
    let admin: string | null = null;
    let adminIsBeacon = false;
    if (code === "0x") {
      rows[0] = NA("no code at target"); rows[1] = NA("no code"); rows[2] = NA("no code");
      rows[3] = NA("no code at target: nothing exposes owner()"); rows[4] = NA("key 4 not applicable");
      rows[5] = NA("no admin/beacon"); rows[6] = NA("no admin/beacon");
      return finish();
    }
    const deleg = parseDelegation(code);
    const clone = parseMinimalProxy(code);
    const sc = scan(deleg ? await codeOf(deleg) : code);
    notes.delegatecallOpcode = sc.delegatecall;
    const slotWord = async (slot: Hex) => addrOfWord(await rpc.getStorageAt(target, slot, block));
    const implRaw = await rpc.getStorageAt(target, SLOT_IMPL, block); const implN = lastN();
    const beaconRaw = await rpc.getStorageAt(target, SLOT_BEACON, block); const beaconN = lastN();
    const adminRaw = await rpc.getStorageAt(target, SLOT_ADMIN, block); const adminN = lastN();
    const proxiableRaw = await rpc.getStorageAt(target, SLOT_PROXIABLE, block);
    const implA = addrOfWord(implRaw), beaconA = addrOfWord(beaconRaw), adminA = addrOfWord(adminRaw), proxA = addrOfWord(proxiableRaw);
    const nz = (a: string | null) => !!a && BigInt(a) !== 0n;
    notes.slots = { impl: implA, beacon: beaconA, admin: adminA, proxiable: proxA, readNumbers: { impl: implN, beacon: beaconN, admin: adminN } };

    if (deleg) {
      rows[0] = W(typeWord("NO"), `EIP-7702 delegation designator (read #${codeRead}) to ${deleg}: a delegation, not a standard proxy`);
      rows[1] = NA("Key 1 is NO"); rows[2] = NA("Key 1 is NO");
    } else if (clone) {
      rows[0] = W(typeWord("YES"), `${clone.variant} clone bytecode (read #${codeRead}) embeds the implementation`);
      rows[1] = W(encodeAddress(clone.impl), `implementation embedded in clone bytecode: ${clone.impl}`);
      rows[2] = NA("minimal proxies have no admin or beacon");
    } else if (nz(implA) || nz(beaconA) || nz(proxA)) {
      if (!sc.delegatecall) {
        rows[0] = UNK(`read #${codeRead} eth_getCode`, "a proxy slot is set but the bytecode has no DELEGATECALL, so dispatch cannot be confirmed");
        rows[1] = UNK(`read #${codeRead} eth_getCode`, "Key 1 unresolved"); rows[2] = UNK(`read #${codeRead} eth_getCode`, "Key 1 unresolved");
      } else if (nz(implA)) {
        rows[0] = W(typeWord("YES"), `EIP-1967 implementation slot (read #${implN}) is set and bytecode has DELEGATECALL`);
        rows[1] = W(encodeAddress(implA!), `EIP-1967 implementation slot = ${implA}`);
        if (nz(adminA)) { admin = adminA; rows[2] = W(encodeAddress(adminA!), `EIP-1967 admin slot (read #${adminN}) = ${adminA} (transparent proxy)`); }
        else rows[2] = NA("EIP-1967 admin slot is zero: UUPS-style proxy without a distinct admin (owner is not a proxy admin)");
      } else if (nz(beaconA)) {
        adminIsBeacon = true; admin = beaconA;
        rows[0] = W(typeWord("YES"), `EIP-1967 beacon slot (read #${beaconN}) is set and bytecode has DELEGATECALL`);
        rows[2] = W(encodeAddress(beaconA!), `EIP-1967 beacon slot = ${beaconA}`);
        const r = await tryCall(rpc, beaconA!, SEL_IMPLEMENTATION, block);
        const n = lastN();
        const ia = r.ok && r.data.length === 66 ? addrOfWord(r.data) : null;
        rows[1] = ia ? W(encodeAddress(ia), `beacon.implementation() (read #${n}) = ${ia}`) : UNK(`read #${n} eth_call beacon.implementation()`, "beacon did not return an implementation");
      } else {
        // EIP-1822 PROXIABLE slot
        rows[0] = W(typeWord("YES"), "EIP-1822 PROXIABLE slot is set and bytecode has DELEGATECALL");
        rows[1] = W(encodeAddress(proxA!), `PROXIABLE slot = ${proxA}`);
        rows[2] = NA("EIP-1822 has no admin");
      }
    } else {
      // EIP-2535 diamond probe
      const d = await tryCall(rpc, target, SEL_FACET_ADDRESSES, block);
      const dn = lastN();
      if (d.ok && d.data.length >= 2 + 128 && sc.delegatecall) {
        let facets: string[] = [];
        try { facets = (decodeAbiParameters([{ type: "address[]" }], d.data)[0] as string[]); } catch { /* fallthrough */ }
        rows[0] = W(typeWord("YES"), `EIP-2535 diamond: facetAddresses() answered (read #${dn}) and bytecode has DELEGATECALL`);
        rows[1] = NA(`diamond has no unique implementation; facets: ${facets.join(", ")}`);
        rows[2] = NA("diamond: controllers must be read from source");
        notes.facets = facets;
      } else if (sc.delegatecall) {
        rows[0] = UNK(`read #${codeRead} eth_getCode`, "bytecode contains DELEGATECALL but no standard proxy pattern matched: identification uncertain");
        rows[1] = UNK(`read #${codeRead} eth_getCode`, "Key 1 unresolved"); rows[2] = UNK(`read #${codeRead} eth_getCode`, "Key 1 unresolved");
      } else {
        rows[0] = W(typeWord("NO"), `checked: EIP-1967 impl/beacon/admin slots (reads #${implN}-#${adminN}) empty, EIP-1822 slot empty, no EIP-1167 clone prefix, no EIP-7702 designator, no DELEGATECALL opcode in bytecode, no diamond loupe (read #${dn})`);
        rows[1] = NA("Key 1 is NO"); rows[2] = NA("Key 1 is NO");
      }
    }

    // ---- key 4/5 ----
    const own = await ownerRoot(target, false);
    notes.ownerTrail = own.trail;
    if (own.absentAtStart) {
      rows[3] = NA(`target exposes no owner() (${own.trail.join("; ")})`); rows[4] = NA("Key 4 not applicable");
    } else if (own.root === null) {
      rows[3] = UNK(own.fail ?? "owner walk", own.trail.join("; ")); rows[4] = UNK(own.fail ?? "owner walk", "Key 4 unresolved");
    } else {
      rows[3] = W(encodeAddress(own.root), `owner root ${own.root} via ${own.trail.length} step(s): ${own.trail.join("; ")}`);
      const t = await typeOf(own.root);
      rows[4] = W(typeWord(t.t), `owner root ${own.root} classified from eth_getCode at block: ${t.t}`);
    }

    // ---- key 6/7 ----
    if (!admin) {
      const why = rows[2]!.kind === "unknown" ? "admin/beacon unresolved" : "no admin/beacon";
      rows[5] = rows[2]!.kind === "unknown" ? UNK((rows[2] as any).failed, why) : NA(why);
      rows[6] = rows[5]!;
    } else {
      const ar = await ownerRoot(admin, true);
      notes.adminTrail = ar.trail;
      if (ar.root === null) {
        rows[5] = UNK(ar.fail ?? "admin owner walk", ar.trail.join("; ")); rows[6] = UNK(ar.fail ?? "admin owner walk", "Key 6 unresolved");
      } else {
        rows[5] = W(encodeAddress(ar.root), `admin${adminIsBeacon ? "/beacon" : ""} root ${ar.root}${ar.absentAtStart ? " (start has no owner(), so it is the root)" : ""}: ${ar.trail.join("; ")}`);
        const t = await typeOf(ar.root);
        rows[6] = W(typeWord(t.t), `admin root ${ar.root}: ${t.t}`);
      }
    }
  } catch (e: any) {
    // A failed read gives UNKNOWN for every key not already settled, naming the read.
    const msg = e instanceof ReadError ? e.message : `reader error: ${e?.message ?? e}`;
    rows.forEach((r, i) => { if (r.kind === "unknown" && (r as any).failed === "none") rows[i] = UNK(msg, "a read failed before this key was resolved"); });
  }
  return finish();

  function finish(): ReaderOutput {
    const keys: KeyResultRow[] = rows.map((v, i) => {
      const base = { key: i + 1, name: KEY_NAMES[i]!, reads: [] as number[] };
      if (v.kind === "word") return { ...base, value: v.value, answer: decodeAnswer(v.value), basis: v.basis };
      if (v.kind === "na") return { ...base, value: NOT_APPLICABLE, answer: "NOT_APPLICABLE", basis: v.basis };
      return { ...base, value: UNKNOWN, answer: "UNKNOWN", basis: v.basis, failedRead: v.failed };
    });
    return { chainId: inp.chainId, target, block: block, blockHash, rpcUrl: redactUrl(inp.rpcUrl), keys, calls: rpc.calls, notes };
  }
}

/** RPC URLs can embed an API key in the path or query: keep only the origin in evidence files. */
export function redactUrl(u: string): string {
  try { const x = new URL(u); return `${x.protocol}//${x.host}/…`; } catch { return "(invalid url)"; }
}
