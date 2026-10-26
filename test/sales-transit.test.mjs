import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const shipmentContext = {};
vm.runInNewContext(readFileSync(new URL('../shipment-detail.js', import.meta.url), 'utf8'), shipmentContext);
const LXShipmentDetail = shipmentContext.LXShipmentDetail;
const clean = (value) => String(value ?? '').trim();
const esc = (value) => clean(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const identity = { msku: 'TEST-One-US', store: 'DEMO-US' };
const shipment = (shipmentId, declared, received, arrivalAt, extra = {}) => ({ shipmentId, status: 'SHIPPED', ...identity, declared, received, arrivalAt, ...extra });

test('销量在途与产品表现使用同一列注入路径，但标题分开；只用当前销量行身份', () => {
  let sales = true, product = false;
  const helpers = part('  const isTransitPage =', '\n  function transitRowKey(');
  const api = vm.runInNewContext(`${helpers}\n({isTransitPage, transitColumnLabel, transitItemIdentity})`, {
    isSalesPage: () => sales, isProductExpressionPage: () => product
  });
  const item = { identity, master: { identity: { msku: 'TEST-One-US', store: 'OTHER-US' } } };
  assert.equal(api.isTransitPage(), true);
  assert.equal(api.transitColumnLabel(), '在途数量');
  assert.equal(api.transitItemIdentity(item), identity, '不能使用宽松主表匹配找到的另一店铺');
  sales = false; product = true;
  assert.equal(api.transitColumnLabel(), 'FBA标发在途');
  assert.equal(api.transitItemIdentity(item), item.master.identity);
  product = false;
  assert.equal(api.isTransitPage(), false);
  const inject = part('  function injectTransitColumn(', '\n  function repairTransitColumn(');
  assert.match(inject, /!isTransitPage\(\)/);
  assert.match(inject, /fbaAvailableColId\(main\)/);
  assert.match(inject, /transitColumnLabel\(\)/);
  assert.match(inject, /vxe-table--footer tbody tr/);
});

test('原生库存下拉兼容销量的“标发在途”和产品表现的“FBA标发在途”，保留零值', () => {
  let label = '标发在途', value = '0';
  const getValue = vm.runInNewContext(`${part('  function transitValueFromPopover(', '\n  function onTransitNetworkMessage(')}\ntransitValueFromPopover`, {
    clean, document: { getElementById: () => ({ querySelectorAll: () => [{ querySelector: (selector) => ({ textContent: selector === '.title' ? label : value }) }] }) }
  });
  const reference = { getAttribute: () => 'popover' };
  assert.equal(getValue(reference), '0');
  label = 'FBA标发在途'; value = '1,234';
  assert.equal(getValue(reference), '1234');
  label = '计划入库';
  assert.equal(getValue(reference), null);
});

test('销量网络库存按完整 MSKU、店铺和日期匹配，不跨店或用未知店铺数量', () => {
  const rows = [{ msku: 'TEST-ONE-US', store: 'DEMO-US', value: '0' }, { msku: 'TEST-ONE-US', store: 'OTHER-US', value: '99' }];
  let date = '2026-10-20:2026-10-20';
  const value = vm.runInNewContext(`${part('  function transitValueFromNetwork(', '\n  function closeTransitDetail(')}\ntransitValueFromNetwork`, {
    clean, normalizeMsku: LXShipmentDetail.sku, isSalesPage: () => true,
    transitNetworkRows: rows, transitNetworkDateKey: date, pageDateRange: () => date, dateRangeKey: (value) => value
  });
  assert.equal(value(identity), '0');
  assert.equal(value({ ...identity, store: 'MISSING-US' }), null);
  assert.equal(value({ ...identity, store: '' }), null);
  assert.equal(value({ ...identity, msku: 'OTHER-US' }), null);
  rows.push({ ...rows[0], value: '12' });
  assert.equal(value(identity), null, '冲突数量不任取一行');
  date = '2026-10-19:2026-10-19';
  assert.equal(value(identity), null);
});

test('销量已载入数量不使用过期日期或无店铺值，同键冲突不最后一条覆盖，零值可缓存', () => {
  const cache = new Map();
  const record = vm.runInNewContext(`${part('  function rememberSalesTransitValues(', '\n  function transitValueFromPopover(')}\nrememberSalesTransitValues`, {
    isSalesPage: () => true, pageDateRange: () => 'today', dateRangeKey: (value) => value,
    transitRowKey: (identity) => identity?.msku ? `${identity.msku}|${identity.store}` : '', transitValues: cache
  });
  record([{ identity, transitQuantity: '5' }], 'old');
  assert.equal(cache.size, 0);
  record([{ identity, transitQuantity: '0' }, { identity: { msku: 'B' }, transitQuantity: '99' }], 'today');
  assert.equal(cache.get('TEST-One-US|DEMO-US'), '0');
  assert.equal(cache.size, 1);
  record([{ identity, transitQuantity: '1' }, { identity, transitQuantity: '2' }], 'today');
  assert.equal(cache.size, 0);
});

function detailHtml(result, view = 'sales') {
  const shadow = { innerHTML: '', querySelector: () => ({ addEventListener() {} }) };
  const render = vm.runInNewContext(`${part('  function renderTransitDetail(', '\n  async function onTransitColumnClick(')}\nrenderTransitDetail`, {
    activeTransitDetail: { identity, view, rect: { left: 500, bottom: 300 }, result, columnValue: '90' },
    transitDetailHost: { shadowRoot: shadow }, innerWidth: 1548, innerHeight: 860,
    LXShipmentDetail, clean, esc, closeTransitDetail() {}
  });
  render();
  return shadow.innerHTML;
}

test('销量下拉按日期正序、同日合成一行，仅两列并附总计，货件重复行不重复累计', () => {
  const result = LXShipmentDetail.fromRows([
    shipment('FBA3', '20', '0', '2026-11-01'),
    shipment('FBA1', '50', '8', '2026-10-15', { orderNumber: 'SP1' }),
    shipment('FBA2', '30', '2', '2026-10-15', { orderNumber: 'SP1' }),
    shipment('FBA1', '50', '8', '2026-10-15', { orderNumber: 'SP1' }),
    shipment('FBA4', '100', '0', '2026-10-15', { store: 'OTHER-US' })
  ], identity, 4);
  assert.equal(result.total, 90);
  assert.deepEqual(Array.from(result.groups, ({ arrivalDay, quantity }) => [arrivalDay, quantity]), [['2026-10-15', 70], ['2026-11-01', 20]]);
  const html = detailHtml(result);
  assert.match(html, /在途数量 · 预计到货明细/);
  assert.match(html, /<th>预计到货日期<\/th><th>在途数量<\/th>/);
  assert.equal((html.match(/<td>2026-10-15<\/td>/g) || []).length, 1);
  assert.ok(html.indexOf('<td>2026-10-15</td>') < html.indexOf('<td>2026-11-01</td>'));
  assert.match(html, /<td>2026-10-15<\/td><td>70<\/td>/);
  assert.match(html, /在途数量总计<\/span><span class="sum">90<\/span>/);
  assert.doesNotMatch(html, /<span>发货单号<\/span>/);
  assert.match(detailHtml(result, 'product'), /<span>发货单号<\/span><span>发货时间<\/span>/, '产品表现保留原五列详情');
});

test('美国沿用系统预计日，CA/UK/DE 按发货日加 60/30/14 天，保留已确认铁路规则', () => {
  const cases = [
    ['DEMO-US', '普船', '2026-10-15'],
    ['DEMO-CA', '普船', '2026-10-31'],
    ['DEMO-UK', '加班船', '2026-10-01'],
    ['SAMPLE-DE', '空派', '2026-09-15'],
    ['SAMPLE-DE', '铁路', '2026-10-31']
  ];
  for (const [store, shippingMethod, expected] of cases) {
    const result = LXShipmentDetail.fromRows([shipment('FBA1', '23', '3', '2026-10-15', { store, shippingMethod, shippedAt: '2026-09-01 23:59' })], { ...identity, store });
    assert.equal(result.groups[0].arrivalDay, expected);
    assert.equal(result.total, 20);
  }
});

test('完整快照仍复核单品数量；缺少日期保留待确认，未完成不显示伪总计，空快照为零', () => {
  const snapshot = vm.runInNewContext(`${part('  function cargoSnapshotResult(', '\n  function cargoProductRows(')}\ncargoSnapshotResult`, { clean, LXShipmentDetail });
  const invalid = snapshot([shipment('FBA1', '-', '0', '')], identity, true, 'scope');
  assert.equal(invalid.complete, false);
  assert.match(detailHtml(invalid), /不能确认总计/);
  assert.doesNotMatch(detailHtml(invalid), /class="sum">0<\/span>/);
  const unknown = snapshot([shipment('FBA1', '6', '1', '')], identity, true, 'scope');
  assert.match(detailHtml(unknown), /<td>待确认<\/td><td>5<\/td>/);
  assert.equal(unknown.total, 5);
  const empty = snapshot([], identity, true, 'scope');
  assert.equal(empty.complete, true);
  assert.match(detailHtml(empty), /在途数量总计<\/span><span class="sum">0<\/span>/);
});

test('销量点击复用完整货件快照与同一 MSKU/店铺；再次点击收起，不重复启动任务', async () => {
  const requests = [], column = { closest: () => ({}), getBoundingClientRect: () => ({ left: 100, bottom: 100 }), querySelector: () => ({ textContent: '90' }) };
  const row = column.closest();
  column.closest = () => row;
  const main = {}, fixed = {};
  const mount = { querySelector: (selector) => selector.includes('fixed') ? fixed : main };
  const context = {
    activeTransitDetail: null, transitDetailHost: null, clean, isSalesPage: () => true, isTransitPage: () => true,
    transitItemIdentity: (item) => item.identity, findTableMount: () => mount,
    vxeRenderedRows: () => [{ mainRow: row, identity }], transitRowKey: (identity) => JSON.stringify(identity),
    document: { createElement: () => ({ attachShadow() {} }), documentElement: { append() {} } },
    renderTransitDetail() {}, setInterval: () => 1, clearInterval() {},
    send: async (message) => { requests.push(message); return { ok: true, requestId: 'cached', cached: true, rows: [], complete: true, scope: '全部' }; },
    cargoSnapshotResult: () => ({ total: 0, complete: true })
  };
  context.closeTransitDetail = () => { context.activeTransitDetail = null; };
  const click = vm.runInNewContext(`${part('  async function onTransitColumnClick(', '\n  function cargoSnapshotResult(')}\nonTransitColumnClick`, context);
  const event = { target: { closest: () => column }, preventDefault() {}, stopPropagation() {} };
  await click(event);
  assert.equal(requests[0].type, 'LX_FORMAL_CARGO_SNAPSHOT_QUERY');
  assert.deepEqual({ ...requests[0].identity }, identity);
  assert.equal(context.activeTransitDetail.view, 'sales');
  assert.equal(context.activeTransitDetail.result.complete, true);
  assert.equal(context.activeTransitDetail.columnValue, '90');
  await click(event);
  assert.equal(context.activeTransitDetail, null);
  assert.equal(requests.length, 1);
});
