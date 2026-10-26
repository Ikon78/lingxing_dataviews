import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content.js'), 'utf8');
const start = source.indexOf('  function sourceQueryCandidates(');
const end = source.indexOf('\n  function sourceIsLoading(', start);
assert.ok(start >= 0 && end > start);
const helper = `${source.slice(start, end)}\nsourceQueryCandidates`;

test('销量补查先用已抓取的原始 MSKU 拼写，并保留短后缀重试', () => {
  const query = vm.runInNewContext(helper, {
    isSalesPage: () => true,
    state: { data: { datasets: { sales: { rows: [{ identity: { msku: 'TEST-Product Delta-001-US' } }] } } } },
    normalizeMsku: (value) => String(value || '').toUpperCase().replace(/[\s-]+/g, '-'),
    clean: (value) => String(value || '').trim(),
    skuQueryFromMsku: (value) => value.replace(/-US$/, '')
  });
  assert.deepEqual(Array.from(query('TEST-Product-Delta-001-US', 'MSKU')),
    ['TEST-Product Delta-001-US', 'TEST-Product-Delta-001-US', 'Delta-001-US', '001-US']);
  assert.deepEqual(Array.from(query('TEST-Product-Delta-001-US', 'SKU')), ['TEST-Product-Delta-001']);
});

test('产品表现只提交完整 MSKU，不删站点、不用 SKU 或后缀候选', () => {
  const query = vm.runInNewContext(helper, {
    isProductExpressionPage: () => true, isSalesPage: () => false,
    clean: (value) => String(value ?? '').trim(),
    skuQueryFromMsku: () => { throw new Error('产品表现不能生成 SKU 候选'); }
  });
  assert.deepEqual(Array.from(query('TEST-Product-Delta-001-US', 'MSKU')), ['TEST-Product-Delta-001-US']);
  assert.deepEqual(Array.from(query('A-EU', 'SKU')), ['A-EU']);
});
