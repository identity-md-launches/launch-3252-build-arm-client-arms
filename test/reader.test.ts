import { test } from "node:test";
import assert from "node:assert/strict";
import { startChain20, resolveExpected, expected, type Chain20 } from "./fixtures/harness.js";
import { readKeys } from "../src/reader.js";
import { encodeAnswer, UNKNOWN } from "../src/keys.js";

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
