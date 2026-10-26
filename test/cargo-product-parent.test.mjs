import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
const start = content.indexOf('  function cargoProductRows(');
const end = content.indexOf('\n  async function collectCargoProductPage(', start);
assert.ok(start >= 0 && end > start);

const special = (rowId, shipmentId, status) => ({
  getAttribute: () => rowId,
  classList: { contains: (name) => name === 'special-row' },
  querySelector: (selector) => selector.includes('oneLine') ? { textContent: shipmentId } : null,
  querySelectorAll: (selector) => selector.includes('status-action') ? [{ textContent: status }] : []
});
const loading = (rowId) => ({
  getAttribute: () => rowId,
  textContent: '展开剩余 18 个商品',
  classList: { contains: (name) => name === 'loading-row' }
});
const product = (rowId, msku) => ({
  getAttribute: () => rowId,
  classList: { contains: () => false },
  values: { m: msku, d: '10', r: '0' }
});

test('虚拟滚动首行沿用其 rowid 的父货件，不误认作上一轮最后的 SHIPPED 票', () => {
  const working = special('parent-working', 'FBA-WORKING', 'WORKING');
  const workingExpand = loading('working-expand');
  const shipped = special('parent-shipped', 'FBA-SHIPPED', 'SHIPPED');
  const shippedProduct = product('shipped-product', 'SKU-1');
  let visibleRows = [working, workingExpand, shipped, shippedProduct];
  const main = { querySelectorAll: () => visibleRows };
  const cargoProductRows = vm.runInNewContext(`${content.slice(start, end)}\ncargoProductRows`, {
    document: { querySelector: () => main },
    headerMap: () => new Map([['m', 'MSKU'], ['d', '申报量'], ['r', '签收量']]),
    rowText: (row, column) => row.values?.[column] || '',
    identityLine: (value) => value,
    clean: (value) => String(value || '').trim()
  });
  const state = { parents: new Map() };
  const first = { shipments: new Set(), collapsed: [] };
  cargoProductRows(state, first);
  assert.equal(first.collapsed.length, 0);

  visibleRows = [workingExpand, shipped, shippedProduct];
  const second = { shipments: new Set(), collapsed: [] };
  const rows = cargoProductRows(state, second);
  assert.equal(second.collapsed.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].shipmentId, 'FBA-SHIPPED');
});
