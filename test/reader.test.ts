import { test } from "node:test";
import assert from "node:assert/strict";
import { startChain20, startAnvil, planted, resolveExpected, expected, type Chain20 } from "./fixtures/harness.js";
import { createPublicClient, createWalletClient, http, encodeDeployData, encodeFunctionData, parseAbi, pad, type Address, type Hex } from "viem";
import { readKeys } from "../src/reader.js";
import { encodeAnswer, encodeAddress, UNKNOWN } from "../src/keys.js";

let chain: Chain20;
test("deploy 20 planted contracts on a local chain", async () => {
  chain = await startChain20(18545 + Math.floor(Math.random() * 1000));
  assert.equal(Object.keys(chain.scenarios).length, 20);
  assert.deepEqual(Object.keys(chain.scenarios).sort(), Object.keys(expected).sort());
});

test("reader gets keys 1..7 right on all 20", async () => {
  const bad: string[] = [];
  for (const [name, d] of Object.entries(chain.scenarios)) {
    const want = resolveExpected(name, d);
    const out = await readKeys({ chainId: 31337, target: d.address, block: chain.block, rpcUrl: chain.url });
    for (let k = 1; k <= 7; k++) {
      const got = out.keys[k - 1]!;
      if (got.value.toLowerCase() !== encodeAnswer(want[String(k)]!).toLowerCase()) bad.push(`${name} key ${k}: got ${got.answer} (${got.basis}) want ${want[String(k)]}`);
    }
    assert.ok(out.calls.length > 3 && out.calls.every((c) => c.method.startsWith("eth_")), `${name}: evidence lists every call`);
    assert.ok(out.blockHash);
  }
  chain.stop();
  assert.deepEqual(bad, []);
});

test("a failed read gives UNKNOWN and names the read", async () => {
  const out = await readKeys({ chainId: 31337, target: "0x00000000000000000000000000000000000d7702", block: 1n, rpcUrl: "http://127.0.0.1:1" });
  for (const k of out.keys) { assert.equal(k.value, UNKNOWN); assert.match(k.failedRead ?? "", /read #1 eth_chainId failed/); }
});

test("beacon proxy mirroring its implementation slot, and owner() absence proven behind a proxy", async () => {
  const a = await startAnvil(19545 + Math.floor(Math.random() * 1000));
  try {
    const pub = createPublicClient({ transport: http(a.url), pollingInterval: 20 });
    const [deployer, eoa1, eoa2] = (await pub.request({ method: "eth_accounts" } as any)) as Address[];
    const wallet = createWalletClient({ account: deployer!, transport: http(a.url) });
    const dep = async (name: string, args: unknown[] = []) => {
      const c = planted[name]!;
      const data = args.length ? encodeDeployData({ abi: c.abi, bytecode: c.bytecode, args }) : c.bytecode;
      return (await pub.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ data, chain: null, gas: 5_000_000n }) })).contractAddress!;
    };
    const init = (o: Address) => encodeFunctionData({ abi: parseAbi(["function init(address)"]), args: [o] });
    const impl = await dep("CappedMint");
    const beacon = await dep("UpgradeableBeacon", [eoa2, impl]);
    const px = await dep("BeaconProxy", [beacon, init(eoa1!)]);
    await pub.request({ method: "anvil_setStorageAt", params: [px, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", pad(impl)] } as any);
    const noOwner = await dep("NoOwner");
    const px2 = await dep("ERC1967Proxy", [noOwner, "0x"]);
    const block = await pub.getBlockNumber();
    const r1 = await readKeys({ chainId: 31337, target: px, block, rpcUrl: a.url });
    assert.equal(r1.keys[1]!.value, encodeAddress(impl), "key 2 = implementation via beacon");
    assert.equal(r1.keys[2]!.value, encodeAddress(beacon), "key 3 = beacon even when the implementation slot is mirrored");
    assert.equal(r1.keys[5]!.value, encodeAddress(eoa2!), "key 6 = beacon owner");
    assert.equal(r1.keys[6]!.value, encodeAnswer("NO_CODE"));
    const r2 = await readKeys({ chainId: 31337, target: px2, block, rpcUrl: a.url });
    assert.equal(r2.keys[3]!.value, encodeAnswer("NOT_APPLICABLE"), `key 4: ${r2.keys[3]!.basis}`);
    assert.equal(r2.keys[4]!.value, encodeAnswer("NOT_APPLICABLE"));
  } finally { a.stop(); }
});
