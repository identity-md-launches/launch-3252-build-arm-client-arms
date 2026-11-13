// Encoding of Control Map v1 answers as bytes32 (forms/control-map-v1.txt, "Numbering and bytes32 encoding").
import { keccak256, toBytes, stringToHex, pad, getAddress, type Hex } from "viem";

export const NOT_APPLICABLE: Hex = keccak256(toBytes("ARMS_NOT_APPLICABLE"));
export const UNKNOWN: Hex = keccak256(toBytes("ARMS_UNKNOWN"));
export const ZERO_WORD: Hex = `0x${"00".repeat(32)}`;

/** Enum label such as "YES": exact uppercase ASCII, right-padded with zero bytes to 32 bytes. */
export function encodeLabel(label: string): Hex {
  if (!/^[A-Z0-9_]{1,32}$/.test(label)) throw new Error(`bad enum label: ${label}`);
  return stringToHex(label, { size: 32 });
}

/** Address: 20 bytes LEFT-padded with 12 zero bytes. */
export function encodeAddress(a: string): Hex {
  return pad(getAddress(a).toLowerCase() as Hex, { size: 32 });
}

/** Encode a human answer: "NOT_APPLICABLE", "UNKNOWN", an 0x address (20 bytes), a 0x bytes32, or an enum label. */
export function encodeAnswer(a: string): Hex {
  if (a === "NOT_APPLICABLE") return NOT_APPLICABLE;
  if (a === "UNKNOWN") return UNKNOWN;
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return encodeAddress(a);
  if (/^0x[0-9a-fA-F]{64}$/.test(a)) return a.toLowerCase() as Hex;
  return encodeLabel(a);
}

/** Inverse of encodeAnswer, for display. Unrecognised words are returned as hex. */
export function decodeAnswer(w: Hex): string {
  if (w === NOT_APPLICABLE) return "NOT_APPLICABLE";
  if (w === UNKNOWN) return "UNKNOWN";
  const h = w.slice(2);
  if (/^(00){12}[0-9a-f]{40}$/.test(h)) return getAddress(`0x${h.slice(24)}`);
  const m = /^((?:[0-9a-f]{2})+?)(00)*$/.exec(h);
  if (m) {
    const s = Buffer.from(m[1]!, "hex").toString("latin1");
    if (/^[A-Z0-9_]+$/.test(s)) return s;
  }
  return w;
}

export const KEY_NAMES = [
  "Standard proxy", "Implementation address", "Proxy admin or beacon", "Owner root", "Owner root type",
  "Admin root", "Admin root type", "Replaceable logic", "Mint path", "Mint cap",
  "Transfer restriction power", "Transfer tax power", "Enforced waiting time",
] as const;

export const ENUMS: Record<number, string[]> = {
  1: ["YES", "NO"], 5: ["ZERO_ADDRESS", "NO_CODE", "DELEGATED_WALLET", "CONTRACT"],
  7: ["ZERO_ADDRESS", "NO_CODE", "DELEGATED_WALLET", "CONTRACT"], 8: ["YES", "NO"], 9: ["YES", "NO"],
  10: ["LIFETIME_TOTAL", "OUTSTANDING_SUPPLY", "PER_ACCOUNT", "NONE"], 11: ["YES", "NO"], 12: ["YES", "NO"],
  13: ["ALL", "SOME", "NONE"],
};

/** Validate a decoded answer for a human key number (1..13). Throws on an impossible value. */
export function validateAnswer(key: number, a: string): void {
  if (a === "NOT_APPLICABLE" || a === "UNKNOWN") return;
  if (key === 2 || key === 3 || key === 4 || key === 6) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`key ${key} needs an address, got ${a}`);
    return;
  }
  if (!ENUMS[key]?.includes(a)) throw new Error(`key ${key}: ${a} is not one of ${ENUMS[key]?.join("/")}`);
}

/** Validate a commit's answers before a salt is made: the reveal must be one the contract accepts (length and per-key legality). */
export function commitValues(raw: unknown, keys: number[]): Hex[] {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) throw new Error("--values file must be a JSON array of strings");
  if (raw.length !== keys.length) throw new Error(`${keys.length} values required (keys ${keys.join(",")}), file has ${raw.length}: refusing to commit an unrevealable answer`);
  return raw.map((v: string, i) => { validateAnswer(keys[i]!, v); return encodeAnswer(v); });
}
