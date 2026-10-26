import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content.js'), 'utf8');
const start = source.indexOf('  async function waitCargoPacket(');
const end = source.indexOf('\n  function waitCargoIdle(', start);
assert.ok(start >= 0 && end > start);

test('候选货件包已返回却无商品行时提前改走页面表格', async () => {
  let now = 1000;
  const context = {
    cargoNetworkCapture: { batchCount: 0, orderBatchCount: 0, diagnostic: { candidates: 1, productRows: 0 } },
    sourceIsLoading: () => false,
    Date: { now: () => now },
    setTimeout: (callback, delay) => { now += delay; callback(); }
  };
  const waitCargoPacket = vm.runInNewContext(`${source.slice(start, end)}\nwaitCargoPacket`, context);
  await assert.rejects(waitCargoPacket(0, 'product'), /改用页面表格核对/);
  assert.ok(now < 1000 + 12000);
});

test('已解析出货件商品行时不触发页面回退', async () => {
  const context = {
    cargoNetworkCapture: { batchCount: 1, orderBatchCount: 0, diagnostic: { candidates: 1, productRows: 4 } },
    sourceIsLoading: () => false,
    Date,
    setTimeout
  };
  const waitCargoPacket = vm.runInNewContext(`${source.slice(start, end)}\nwaitCargoPacket`, context);
  await waitCargoPacket(0, 'product');
});
