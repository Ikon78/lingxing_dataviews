import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
const start = content.indexOf('  async function runCargoSnapshot(');
const end = content.indexOf('\n  async function runTransitDetailQuery(', start);
assert.ok(start >= 0 && end > start, '无法定位货件整表扫描流程');
const scanSource = `${content.slice(start, end)}\nrunCargoSnapshot`;

test('整表扫描跨多个日期窗口合并货件；已是 500 条时不点刷新', async () => {
  const steps = [];
  const delivered = [];
  let currentRange = { start: '2026-07-16', end: '2026-10-16' };
  const context = {
    cargoNetworkCapture: null,
    sourceQueryBusy: false,
    location: { pathname: '/erp/msupply/fbaCargo', origin: 'https://example.lingxing.com' },
    window: {
      postMessage(message) {
        if (message.type === 'LX_FORMAL_CARGO_QUERY_START') {
          steps.push('capture:start');
          context.cargoNetworkCapture.started = true;
        }
        if (message.type === 'LX_FORMAL_CARGO_QUERY_STOP') steps.push('capture:stop');
      }
    },
    document: {
      querySelector(selector) {
        if (selector.includes('lx_table_refresh')) throw new Error('不能点击会重置日期的刷新按钮');
        if (selector.includes('input[value="product"]')) return { closest: () => ({ getAttribute: () => 'true' }) };
        return null;
      }
    },
    clean: (value) => String(value ?? '').trim(),
    normalizeMsku: (value) => String(value ?? '').trim().toUpperCase(),
    dateRangeKey: (range) => `${range?.start}:${range?.end}`,
    cargoSixMonthRange: () => ({ start: '2026-04-16', end: '2026-10-16' }),
    cargoScanWindows: () => [
      { start: '2026-07-16', end: '2026-10-16' },
      { start: '2026-04-16', end: '2026-07-15' }
    ],
    pageDateRange: () => currentRange,
    sourceIsLoading: () => false,
    waitCargoIdle: async () => true,
    readLoadedTable: async () => ({ ok: false }),
    waitLoadedTableSettled: async () => true,
    collectCargoLoadedPage: async () => null,
    waitCargoCaptureStarted: async () => {
      assert.equal(context.cargoNetworkCapture.started, true);
    },
    chooseCargoShippedStatus: async () => { steps.push('status:SHIPPED'); return true; },
    cargoShippedSelected: () => true,
    setSourceDateRange: async (range) => {
      steps.push('date:set');
      assert.equal(context.cargoNetworkCapture.started, true);
      currentRange = range;
      if (range.start === '2026-04-16') {
        context.cargoNetworkCapture.rows.set('FBA2|TEST-TWO-US|DEMO-US', {
          shipmentId: 'FBA2', msku: 'TEST-Two-US', store: 'DEMO-US', status: 'SHIPPED', declared: '20', received: '1'
        });
        context.cargoNetworkCapture.orders.set('FBA2', { orderNumber: 'SP2', shippedAt: '2026-06-01', arrivalAt: '2026-07-01' });
        context.cargoNetworkCapture.batchCount += 1;
      }
      return true;
    },
    cargoPageSize500: async () => { steps.push('size:already500'); return false; },
    collectCargoLegacyProductPage: async () => {
      context.cargoNetworkCapture.orders.set('FBA1', { orderNumber: 'SP1', shippedAt: '2026-09-01', arrivalAt: '2026-10-01' });
      return { rows: [{ shipmentId: 'FBA1', msku: 'TEST-One-US', store: 'DEMO-US', status: 'SHIPPED', declared: '30', received: '2' }] };
    },
    waitCargoPacket: async (previous) => {
      assert.ok(context.cargoNetworkCapture.batchCount > previous);
    },
    cargoPageCount: () => 1,
    cargoDiagnosticText: () => '测试诊断',
    send: async (message) => { delivered.push(message); return { ok: true }; },
    setTimeout,
    setInterval,
    clearInterval,
    Map,
    Set,
    Date,
    Number,
    String
  };
  const run = vm.runInNewContext(scanSource, context);
  await run('scan-1');
  assert.deepEqual(steps, ['capture:start', 'status:SHIPPED', 'date:set', 'size:already500', 'date:set', 'size:already500', 'capture:stop']);
  const result = delivered.find((message) => message.type === 'LX_FORMAL_CARGO_SNAPSHOT_READY');
  assert.equal(result?.complete, true, result?.error);
  assert.equal(delivered.filter((message) => message.type === 'LX_FORMAL_CARGO_FOCUS_SOURCE').length, 1);
  assert.equal(result.scope, '创建时间 2026-04-16 至 2026-10-16（分 2 段）');
  assert.equal(result.rows[0].orderNumber, 'SP1');
  assert.equal(result.rows[1].orderNumber, 'SP2');
});
