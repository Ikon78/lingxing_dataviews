import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const start = source.indexOf('  function productRowIdentity(');
const end = source.indexOf('\n  function pairedVxeRow(', start);
function harness() {
  const state = { page: '2', date: '2026-10-18:2026-10-18', filters: ['全部店铺', '品名', ''] };
  const resolve = vm.runInNewContext(`${source.slice(start, end)}\nproductRowIdentity`, {
    productRowIdentities: new WeakMap(), isProductExpressionMskuView: () => true,
    tableRowKey: (row) => row.id, clean: (value) => String(value ?? '').trim(),
    pageDateRange: () => state.date, dateRangeKey: (value) => value,
    document: { querySelector: () => ({ textContent: state.page }),
      querySelectorAll: () => state.filters.map((value) => ({ value })) }
  });
  return { state, resolve, main: {} };
}
const identity = (store = '', marketplace = '') => ({ msku: 'SAMPLE-Product Alpha-001-EU', store, marketplace, asin: '' });

test('横向移除店铺列后，同一业务行保留实际读到的店铺与站点', () => {
  const { resolve, main } = harness();
  resolve(main, { id: 'row_131' }, identity('SAMPLE-DE', '德国'));
  const result = resolve(main, { id: 'row_131' }, identity());
  assert.equal(result.store, 'SAMPLE-DE');
  assert.equal(result.marketplace, '德国');
  assert.equal(resolve(main, { id: 'row_132' }, identity()).store, '', '相同 MSKU 的另一行不能借用店铺');
  assert.equal(resolve({}, { id: 'row_131' }, identity()).store, '', '另一表格不能沿用身份');
});

test('新页面、日期或筛选条件不会沿用旧行身份', () => {
  for (const change of [(state) => { state.page = '3'; }, (state) => { state.date = '2026-10-19:2026-10-19'; },
    (state) => { state.filters = ['SAMPLE-FR', '品名', '']; }]) {
    const { resolve, main, state } = harness();
    resolve(main, { id: 'row_131' }, identity('SAMPLE-DE', '德国'));
    change(state);
    assert.equal(resolve(main, { id: 'row_131' }, identity()).store, '');
  }
});

test('完整 MSKU 或明确店铺变化时不继承旧上下文，新店铺可独立保留', () => {
  const { resolve, main } = harness();
  resolve(main, { id: 'row_131' }, identity('SAMPLE-DE', '德国'));
  assert.equal(resolve(main, { id: 'row_131' }, { ...identity(), msku: 'OTHER-EU' }).store, '');
  resolve(main, { id: 'row_131' }, identity('SAMPLE-DE', '德国'));
  const changed = resolve(main, { id: 'row_131' }, identity('SAMPLE-FR'));
  assert.equal(changed.marketplace, '', '新店铺不得混入旧德国站点');
  assert.equal(resolve(main, { id: 'row_131' }, identity()).store, 'SAMPLE-FR');
});

test('采集、列回填和在途点击使用同一已校准的行身份', () => {
  const capture = source.slice(source.indexOf('  function captureVisibleTable('), source.indexOf('  function scheduleCapture('));
  const rendered = source.slice(source.indexOf('  function vxeRenderedRows('), source.indexOf('  function fbaAvailableColId('));
  assert.match(capture, /identity: productRowIdentity\(main, mainRow,/);
  assert.match(rendered, /const identity = productRowIdentity\(main, mainRow,/);
});
