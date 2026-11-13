// Private keys: read only from a file path or an environment variable the operator names.
// The key value is never printed, logged, stored, or put into an error message or evidence file.
import { readFileSync, statSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

export interface KeySource { file?: string; env?: string }

export function loadPrivateKey(src: KeySource | undefined): Hex {
  if (!src || (!src.file && !src.env)) throw new Error("no key source: name a key file (--key-file / config key.file) or an env var (--key-env / config key.env)");
  let raw: string;
  if (src.file) {
    const st = statSync(src.file);
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      throw new Error(`key file ${src.file} is readable by group/others; chmod 600 it`);
    }
    raw = readFileSync(src.file, "utf8");
  } else {
    raw = process.env[src.env!] ?? "";
    if (!raw) throw new Error(`env var ${src.env} is empty or unset`);
  }
  const k = raw.trim();
  const hex = (k.startsWith("0x") ? k : `0x${k}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("key source does not contain a 32-byte hex private key"); // never echo the content
  return hex;
}

export function accountFrom(src: KeySource | undefined) {
  return privateKeyToAccount(loadPrivateKey(src));
}
