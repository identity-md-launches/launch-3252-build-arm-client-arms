// Form identity: formId = keccak256(abi.encode(textHash, uint8(13), uri)); same as script/prepare_control_map.py.
import { encodeAbiParameters, keccak256, type Hex } from "viem";

export interface FormSpec { uri: string; textHash: Hex; keyCount: number; formId: Hex }

export function formSpec(repo: string, commit: string, path: string, bytes: Uint8Array): FormSpec {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("form commit must be the immutable 40-hex commit, not a branch");
  const uri = `https://raw.githubusercontent.com/${repo}/${commit}/${path}`;
  if (new TextEncoder().encode(uri).length > 200) throw new Error("form URI longer than 200 bytes");
  const textHash = keccak256(bytes);
  const formId = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }, { type: "string" }], [textHash, 13, uri]));
  return { uri, textHash, keyCount: 13, formId };
}
