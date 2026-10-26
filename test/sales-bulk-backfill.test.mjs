import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content.js'), 'utf8');
const start = source.indexOf('  async function runSourceQuery(');
const end = source.indexOf('\n  function findMatchingRow(', start);
assert.ok(start >= 0 && end > start);

test('销量统计先批量读取已载入 MSKU 行，命中项不再逐个模拟搜索', async () => {
  const messages = [];
  const saved = [];
  const input = { value: '', isConnected: true };
  const normalizeMsku = (value) => String(value || '').toUpperCase().replace(/[\s-]+/g, '-');
  const context = {
    BACKFILL_BATCH_SIZE: 8,
    SOURCE_QUERY_MAX_MS: 52_000,
    sourceQueryBusy: false,
    isProductExpressionPage: () => false,
    isSalesPage: () => true,
    ensureSourceMskuView: async () => true,
    routeKind: () => 'sales',
    waitForSearchInput: async () => ({ input, modeInput: { value: 'MSKU' }, originalMode: 'MSKU' }),
    captureSourceRows: async () => [
      { identity: { msku: 'TEST-Product Delta-001-US' }, fields: { 可用库存可售天数: '6 天' } },
      { identity: { msku: 'TEST-Product Zeta-001-US' }, fields: { 可用库存可售天数: '78 天' } }
    ],
    saveSourceRows: async (rows) => { saved.push(...rows); return { ok: true }; },
    normalizeMsku,
    clean: (value) => String(value || '').trim(),
    send: async (message) => { messages.push(message); return { ok: true }; },
    setInputValue: () => { throw new Error('批量已命中时不应输入单项搜索'); },
    submitSourceSearch: () => { throw new Error('批量已命中时不应提交单项搜索'); },
    console
  };
  const run = vm.runInNewContext(`${source.slice(start, end)}\nrunSourceQuery`, context);
  await run('request-1', ['TEST-Product-Delta-001-US', 'TEST-Product-Zeta-001-US'], null);
  assert.equal(saved.length, 2);
  const result = messages.find((message) => message.type === 'LX_FORMAL_SOURCE_RESULT')?.result;
  assert.equal(result?.ok, true);
  assert.equal(result?.matched, 2);
  assert.deepEqual(Array.from(result?.unresolved || []), []);
});

test('MSKU 存在但目标可售天数字段缺失时不能误报命中', async () => {
  const messages = [];
  const input = { value: '', isConnected: true };
  const controls = { input, mode: 'MSKU', modeInput: { value: 'MSKU' }, originalMode: 'MSKU' };
  const context = {
    BACKFILL_BATCH_SIZE: 8, SOURCE_QUERY_MAX_MS: 52_000, sourceQueryBusy: false,
    isProductExpressionPage: () => false, isSalesPage: () => true, ensureSourceMskuView: async () => true,
    routeKind: () => 'sales', waitForSearchInput: async () => controls, sourceSearchControls: () => controls,
    captureSourceRows: async () => [{ identity: { msku: 'A-US' }, fields: { 可用库存: '253' } }],
    saveSourceRows: async () => ({ ok: true }), normalizeMsku: (value) => String(value || '').toUpperCase(),
    clean: (value) => String(value || '').trim(), send: async (message) => { messages.push(message); return { ok: true }; },
    currentTableText: () => 'A-US 253', setInputValue: (target, value) => { target.value = value; },
    readLoadedTable: async () => ({ ok: false }),
    submitSourceSearch: () => {}, waitForSourceResult: async () => ({ settled: true, matched: true }),
    sourceQueryCandidates: () => ['A-US'], setTimeout, console
  };
  const run = vm.runInNewContext(`${source.slice(start, end)}\nrunSourceQuery`, context);
  await run('request-2', ['A-US'], null, ['可用库存可售天数']);
  const result = messages.find((message) => message.type === 'LX_FORMAL_SOURCE_RESULT')?.result;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.matched, 0);
  assert.deepEqual(Array.from(result.unresolved), ['A-US']);
});

test('原生日历和业务表日期确认后直接读取有效行，不再等待整表对象变化', async () => {
  const messages = [];
  const saved = [];
  let currentRange = { start: '2026-10-09', end: '2026-10-19' };
  const wantedRange = { start: '2026-10-18', end: '2026-10-18' };
  const input = { value: '', isConnected: true };
  const controls = { input, mode: 'MSKU', modeInput: { value: 'MSKU' }, originalMode: 'MSKU' };
  let searched = false;
  let now = 1000;
  const context = {
    BACKFILL_BATCH_SIZE: 8, SOURCE_QUERY_MAX_MS: 52_000, sourceQueryBusy: false,
    isProductExpressionPage: () => false, isSalesPage: () => true, ensureSourceMskuView: async () => true,
    routeKind: () => 'sales', waitForSearchInput: async () => controls, sourceSearchControls: () => controls,
    readLoadedTable: async () => ({ ok: true, signature: searched ? 'new-query' : 'unchanged' }),
    waitLoadedTableSettled: async () => false,
    pageDateRange: () => currentRange,
    dateRangeKey: (range) => `${range.start}:${range.end}`,
    setSourceDateRange: async (range) => { currentRange = range; return true; },
    setSalesDateRange: async (range) => { currentRange = range; return true; },
    waitSalesReportReady: async () => true,
    salesReportMatchesDate: () => true,
    sourceIsLoading: () => false, currentTableText: () => searched ? 'TEST-Product-Epsilon-US 43天' : 'old data',
    captureSourceRows: async () => {
      return [{ identity: { msku: 'TEST-Product-Epsilon-US' }, fields: { 可用库存可售天数: '43 天' } }];
    },
    saveSourceRows: async (rows) => { saved.push(...rows); return { ok: true }; },
    normalizeMsku: (value) => String(value || '').toUpperCase(), clean: (value) => String(value ?? '').trim(),
    send: async (message) => { messages.push(message); return { ok: true }; },
    setInputValue: (target, value) => { target.value = value; }, submitSourceSearch: () => { searched = true; },
    waitForSourceResult: async () => ({ settled: true }), sourceQueryCandidates: () => ['TEST-Product-Epsilon-US'],
    Date: { now: () => now }, setTimeout: (callback, delay) => { now += delay; callback(); }, console
  };
  const run = vm.runInNewContext(`${source.slice(start, end)}\nrunSourceQuery`, context);
  await run('dated-request', ['TEST-Product-Epsilon-US'], wantedRange, ['可用库存可售天数']);
  const result = messages.find((message) => message.type === 'LX_FORMAL_SOURCE_RESULT')?.result;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.matched, 1);
  assert.equal(saved.length, 1);
  assert.equal(searched, false);
  assert.ok(messages.some((message) => message.progress?.currentMsku.includes('原生日历已提交')));
});

test('销量先固定 MSKU 类型再选日期，直接搜索且结束不清空重搜', async () => {
  const events = [];
  const messages = [];
  const wantedRange = { start: '2026-10-18', end: '2026-10-18' };
  const oldRange = { start: '2026-10-10', end: '2026-10-19' };
  let range = oldRange;
  let searched = false;
  const input = { value: '', isConnected: true };
  const controls = { input, mode: 'MSKU', modeInput: { value: 'MSKU' }, originalMode: 'ASIN' };
  const context = {
    BACKFILL_BATCH_SIZE: 8, SOURCE_QUERY_MAX_MS: 52_000, sourceQueryBusy: false,
    clean: (value) => String(value ?? '').trim(), normalizeMsku: (value) => value,
    isProductExpressionPage: () => false, isSalesPage: () => true, routeKind: () => 'sales',
    ensureSourceMskuView: async () => { events.push('view'); return true; },
    waitForSearchInput: async () => { events.push('mode'); range = oldRange; return controls; },
    sourceSearchControls: () => controls,
    pageDateRange: () => range, dateRangeKey: (value) => `${value.start}:${value.end}`,
    setSalesDateRange: async (value) => { events.push('date'); range = value; return true; },
    waitSalesReportReady: () => { throw new Error('改日期后不能等待或点击整表刷新'); },
    sourceIsLoading: () => false, salesReportMatchesDate: () => searched,
    currentTableText: () => searched ? 'A-US 45 天' : 'old report',
    readLoadedTable: async (options) => {
      if (options.action === 'state') return { ok: true, signature: 'old' };
      assert.equal(options.action, 'querySalesMsku');
      assert.deepEqual(range, wantedRange);
      events.push('query'); input.value = options.query; searched = true;
      return { ok: true, supported: true, submitted: options.query };
    },
    sourceQueryCandidates: () => ['A-US'], waitForSourceResult: async () => ({ settled: true }),
    captureSourceRows: async () => { assert.ok(searched); return [{ identity: { msku: 'A-US' }, fields: { 可用库存可售天数: '45 天' } }]; },
    saveSourceRows: async () => { events.push('save'); return { ok: true }; },
    submitSourceSearch: () => { throw new Error('原生 MSKU 搜索后不得清空或重复提交'); },
    send: async (message) => { messages.push(message); return { ok: true }; }, console
  };
  const run = vm.runInNewContext(`${source.slice(start, end)}\nrunSourceQuery`, context);
  await run('correct-order', ['A-US'], wantedRange, ['可用库存可售天数']);
  const result = messages.find((message) => message.type === 'LX_FORMAL_SOURCE_RESULT').result;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.matched, 1);
  assert.deepEqual(events, ['view', 'mode', 'date', 'query', 'save']);
  assert.equal(input.value, 'A-US');
});

test('原生日历日期文字更新但业务表日期列不匹配时不保存旧表', async () => {
  const messages = [];
  let range = { start: '2026-10-09', end: '2026-10-19' };
  let now = 1000;
  const input = { value: '', isConnected: true };
  const controls = { input, mode: 'MSKU', modeInput: { value: 'MSKU' }, originalMode: 'MSKU' };
  const context = {
    BACKFILL_BATCH_SIZE: 8, SOURCE_QUERY_MAX_MS: 52_000, sourceQueryBusy: false,
    isProductExpressionPage: () => false, isSalesPage: () => true, ensureSourceMskuView: async () => true,
    routeKind: () => 'sales', waitForSearchInput: async () => controls, sourceSearchControls: () => controls,
    readLoadedTable: async () => ({ ok: true, signature: 'unchanged' }), waitLoadedTableSettled: async () => false,
    pageDateRange: () => range, dateRangeKey: (value) => `${value.start}:${value.end}`,
    setSourceDateRange: async (value) => { range = value; return true; }, sourceIsLoading: () => false,
    setSalesDateRange: async (value) => { range = value; return true; }, waitSalesReportReady: async () => false,
    currentTableText: () => 'old data', captureSourceRows: async () => { throw new Error('不可读取旧表'); },
    saveSourceRows: async (rows) => { assert.equal(rows.length, 0); return { ok: true }; },
    normalizeMsku: (value) => value, clean: (value) => String(value ?? '').trim(),
    send: async (message) => { messages.push(message); return { ok: true }; },
    setInputValue: (target, value) => { target.value = value; }, submitSourceSearch() {},
    waitForSourceResult: async () => ({ settled: true }), sourceQueryCandidates: () => ['A-US'],
    salesReportMatchesDate: () => false,
    Date: { now: () => now }, setTimeout: (callback, delay) => { now += delay; callback(); }, console
  };
  const run = vm.runInNewContext(`${source.slice(start, end)}\nrunSourceQuery`, context);
  await run('no-response', ['A-US'], { start: '2026-10-18', end: '2026-10-18' }, ['可用库存可售天数']);
  const result = messages.find((message) => message.type === 'LX_FORMAL_SOURCE_RESULT')?.result;
  assert.equal(result.ok, false);
  assert.match(result.error, /日期列未对应目标范围/);
  const saved = [];
  context.salesReportMatchesDate = () => true;
  context.captureSourceRows = async () => [{ identity: { msku: 'A-US' }, fields: { 可用库存可售天数: '45 天' } }];
  context.saveSourceRows = async (rows) => { saved.push(...rows); return { ok: true }; };
  await run('search-verified', ['A-US'], { start: '2026-10-18', end: '2026-10-18' }, ['可用库存可售天数']);
  assert.equal(messages.findLast((message) => message.type === 'LX_FORMAL_SOURCE_RESULT').result.ok, true);
  assert.equal(saved.length, 1);
  assert.ok(messages.some((message) => message.progress?.currentMsku.includes('跳过旧表')));
});

test('单项搜索返回相同可见值但业务表批次更新时，承认新结果而非空等超时', async () => {
  const waitStart = source.indexOf('  async function waitForSourceResult(');
  const waitEnd = source.indexOf('\n  async function saveSourceRows(', waitStart);
  let now = 1000;
  const run = vm.runInNewContext(`${source.slice(waitStart, waitEnd)}\nwaitForSourceResult`, {
    normalizeMsku: (value) => value, currentTableText: () => 'A-US 43 天', sourceIsLoading: () => false,
    readLoadedTable: async () => ({ ok: true, signature: 'new-batch' }),
    Date: { now: () => now }, setTimeout: (callback, delay) => { now += delay; callback(); }
  });
  const result = await run('A-US', 'A-US 43 天', 8000, { ok: true, signature: 'old-batch' });
  assert.equal(result.settled, true);
  assert.equal(result.matched, true);
  assert.ok(now < 9000);
});
