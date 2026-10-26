import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = fs.readFileSync(path.join(directory, 'content.js'), 'utf8');
const start = content.indexOf('  async function runFocusedTransitDetailQuery(');
const end = content.indexOf('\n  async function runTransitDetailQuery(', start);
assert.ok(start >= 0 && end > start, '无法定位按 MSKU 查询的货件链路');

test('按 MSKU 搜索逐段核对 SHIPPED 商品，并关联发货单而不扫整张产品表', async () => {
  const messages = [];
  const ranges = [];
  const controls = { input: { value: '' } };
  const identity = { msku: 'TEST-Product Zeta-001-US', store: 'DEMO-US' };
  let pageCount = 24;
  let bodyText = '未筛选的 24 票';
  let searches = 0;
  let view = 'product';
  const radio = (name) => ({
    getAttribute: () => view === name ? 'true' : 'false',
    querySelector: () => ({ checked: view === name }),
    click() { view = name; }
  });
  const context = {
    setTimeout,
    location: { pathname: '/erp/msupply/fbaCargo', origin: 'https://example.lingxing.com' },
    window: { postMessage() {} },
    document: {
      querySelector(selector) {
        if (selector.includes('input[value="product"]')) return { closest: () => radio('product') };
        if (selector.includes('input[value="order"]')) return { closest: () => radio('order') };
        if (selector.includes('tbody')) return { get textContent() { return bodyText; } };
        return {};
      },
      createElement: () => ({})
    },
    sourceQueryBusy: false,
    cargoNetworkCapture: null,
    clean: (value) => String(value ?? '').trim(),
    normalizeMsku: (value) => String(value).toUpperCase().replace(/[\s-]+/g, '-'),
    cargoDiagnosticText: () => '响应 1',
    send: async (message) => { messages.push(message); return { ok: true }; },
    waitCargoCaptureStarted: async () => {},
    waitCargoIdle: async () => true,
    headerMap: () => new Map([[1, view === 'product' ? 'MSKU' : '发货单']]),
    chooseCargoShippedStatus: async () => {},
    cargoShippedSelected: () => true,
    cargoPageSize500: async () => true,
    cargoSixMonthRange: () => ({ start: '2026-04-16', end: '2026-10-16' }),
    cargoScanWindows: () => [{ start: '2026-07-16', end: '2026-10-16' }, { start: '2026-04-16', end: '2026-07-15' }],
    dateRangeKey: (range) => `${range.start}:${range.end}`,
    pageDateRange: () => ranges.at(-1),
    setSourceDateRange: async (range) => { ranges.push(range); return true; },
    waitForCargoMskuSearch: async () => controls,
    cargoPageCount: () => pageCount,
    setInputValue: (input, value) => { input.value = value; },
    submitSourceSearch: () => { searches += 1; pageCount = 1; bodyText = '筛选后 1 票'; },
    sourceIsLoading: () => false,
    collectCargoProductPage: async (expected) => {
      assert.equal(expected, 1);
      return { rows: [{ shipmentId: 'FBA1', msku: identity.msku, store: identity.store, status: 'SHIPPED', declared: '30', received: '2' }] };
    },
    cargoShipmentOrderRows: () => [],
    cargoOrderDates: async () => ({}),
    collectCargoRows: async () => [{ shipmentId: 'FBA1', status: 'SHIPPED', orderNumber: 'SP1', shippedAt: '2026-09-24', arrivalAt: '2026-11-13' }],
    LXShipmentDetail: { fromRows: (rows) => ({ shipments: rows.map((row) => ({ shipmentId: row.shipmentId, quantity: Number(row.declared) - Number(row.received), orderNumber: row.orderNumber, shippedAt: row.shippedAt, arrivalDay: row.arrivalAt?.slice(0, 10) })), total: 28, complete: false }) }
  };
  const run = vm.runInNewContext(`${content.slice(start, end)}\nrunFocusedTransitDetailQuery`, context);
  await run('query-1', identity);
  const result = messages.findLast((message) => message.type === 'LX_FORMAL_TRANSIT_DETAIL_RESULT');
  assert.equal(result.error, undefined);
  assert.equal(result.result.complete, true);
  assert.equal(result.result.total, 28);
  assert.equal(result.result.shipments[0].orderNumber, 'SP1');
  assert.equal(ranges.length, 2);
  assert.equal(searches, 1, '第二段日期变更保留 MSKU 搜索时不重复提交');
});
