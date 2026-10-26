import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { clean, normalizeAsin, normalizeMsku, normalizeMarketplace, findAsinMatchingRow, mergeRows } from '../core.js';

const content = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const section = (from, to) => content.slice(content.indexOf(from), content.indexOf(to, content.indexOf(from)));
const identity = { asin: 'B012345678', msku: 'NEW-US', store: 'DEMO-US', marketplace: '美国' };
const row = (change = {}, price = '$9') => ({ identity: { ...identity, msku: 'OTHER-US', ...change }, fields: { 价格: price } });

test('Listing ASIN 匹配不依赖 MSKU，缺少或不同 ASIN 不回退，跨店铺/站点拒绝', () => {
  const local = vm.runInNewContext(`${section('  function findAsinMatchingRow(', '\n  function acceptBackfillMessage(')}\nfindAsinMatchingRow`, {
    clean, normalizeAsin, normalizeMarketplace, contextIdentity: () => ({})
  });
  for (const match of [findAsinMatchingRow, local]) {
    assert.equal(match(identity, [row()], '价格')?.fields.价格, '$9');
    assert.equal(match({ ...identity, asin: 'b012345678' }, [row()], '价格')?.fields.价格, '$9');
    for (const change of [{ asin: '' }, { asin: 'B087654321' }, { store: 'SAMPLE-US' }, { marketplace: 'UK' }, { store: '' }]) {
      assert.equal(match(identity, [row({ ...change, msku: identity.msku })], '价格'), null);
    }
    assert.equal(match({ ...identity, asin: '' }, [row()], '价格'), null);
    assert.equal(match({ ...identity, asin: 'INVALID' }, [row()], '价格'), null);
  }
});

test('同店铺同 ASIN 多 MSKU：相同字段可复用，冲突价格/缺值/跨店铺歧义不任选', () => {
  assert.equal(findAsinMatchingRow(identity, [row(), row({ msku: 'THIRD-US' })], '价格')?.fields.价格, '$9');
  assert.equal(findAsinMatchingRow(identity, [row(), row({ msku: 'THIRD-US' }, '$10')], '价格'), null);
  assert.equal(findAsinMatchingRow(identity, [row(), row({ msku: 'THIRD-US' }, '')], '价格'), null);
  assert.equal(findAsinMatchingRow({ asin: identity.asin }, [row(), row({ store: 'SAMPLE-US' })], '价格'), null);
  assert.equal(findAsinMatchingRow(identity, [row({}, '0'), row({ msku: 'THIRD-US' }, '0')], '价格')?.fields.价格, '0');
});

test('涉及 Listing 的两个方向都走 ASIN；销量与产品表现仍走 MSKU', () => {
  let route = 'sales';
  const find = vm.runInNewContext(`${section('  function findFieldMatchingRow(', '\n  function acceptBackfillMessage(')}\nfindFieldMatchingRow`, {
    clean, normalizeAsin, normalizeMarketplace, contextIdentity: () => ({}), routeKind: () => route,
    findMatchingRow: () => ({ fields: { 值: 'msku' } }), fbaEstimatedDaysField: () => false
  });
  assert.equal(find(identity, [row()], { sourceKind: 'listing', label: '价格' })?.fields.价格, '$9');
  route = 'listing';
  assert.equal(find(identity, [row()], { sourceKind: 'sales', label: '价格' })?.fields.价格, '$9');
  route = 'sales';
  assert.equal(find(identity, [], { sourceKind: 'page@product', label: '值' })?.fields.值, 'msku');
});

test('相同 MSKU 的已知不同 ASIN 不合并旧字段，避免换绑后带入旧价格', () => {
  const merged = mergeRows([row({ msku: 'SAME' })], [{ identity: { ...identity, msku: 'SAME', asin: 'B087654321' }, fields: { 库存: '5' } }]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].fields.价格, undefined);
});

test('校准样本合并当前 DOM 的 ASIN，旧 MSKU 行的空值不挡住新身份', () => {
  const main = {}, node = {};
  const samples = vm.runInNewContext(`${section('  function loadedTableSamples(', '\n  function readLoadedTable(')}\nloadedTableSamples`, {
    clean, isSalesPage: () => true, isProductExpressionPage: () => false,
    findTableMount: () => ({ querySelector: () => main }), tableRowKey: () => 'r1',
    vxeRenderedRows: () => [{ mainRow: node, master: { identity: { msku: 'A-US', asin: '', store: 'DEMO-US', marketplace: '美国' } },
      identity: { msku: 'A-US', asin: 'B012345678', store: '', marketplace: '' } }]
  });
  assert.equal(samples()[0].asin, 'B012345678');
  assert.equal(samples()[0].store, 'DEMO-US');
  assert.equal(samples()[0].marketplace, '美国');
});

test('自动补查按 ASIN 去重并传递匹配类型，不使用 MSKU 候选', async () => {
  for (const [route, sourceKind] of [['sales', 'listing'], ['listing', 'sales']]) {
    const messages = [];
    let timer;
    const fields = [{ sourceKind, label: '价格', id: `${sourceKind}:价格` }];
    const fn = vm.runInNewContext(`${section('  function scheduleSourceBackfill(', '\n  function cleanupColumns(')}\nscheduleSourceBackfill`, {
      sourceQueryBusy: false, activeBackfill: null, routeKind: () => route, clean, normalizeAsin,
      findFieldMatchingRow: () => null, sourceRowsFor: () => [], masterReportDateRange: () => null,
      selectedDateRange: () => null, dateRangeKey: () => '', backfillAttempts: new Map(), backfillAttemptCounts: new Map(),
      backfillFailureReasons: new Map(), backfillRetryDelay: () => 0, backfillTimer: null, BACKFILL_BATCH_SIZE: 8,
      updateBackfill() {}, routeLabel: (value) => value, clearTimeout() {}, setTimeout: (callback) => { timer = callback; },
      state: { selected: [fields[0].id], data: { fields, datasets: {} } }, PRODUCT_EXPRESSION_KIND: 'product',
      send: async (message) => { messages.push(message); return { ok: true, requestId: 'r', requested: 1 }; }
    });
    fn(fields, [{ identity }, { identity: { ...identity, msku: 'ANOTHER' } }]);
    await timer();
    assert.equal(messages[0].matchBy, 'asin');
    assert.deepEqual(Array.from(messages[0].asins), [identity.asin]);
    assert.equal(messages[0].mskus, undefined);
  }
});

test('ASIN 来源搜索原生提交 ASIN，结果只接受该 ASIN，允许不同 MSKU', async () => {
  const messages = [], saved = [], actions = [];
  const input = { value: '', isConnected: true };
  const controls = { input, modeInput: { value: 'ASIN', isConnected: true }, mode: 'ASIN', originalMode: 'ASIN' };
  const run = vm.runInNewContext(`${section('  async function runSourceQuery(', '\n  function findMatchingRow(')}\nrunSourceQuery`, {
    clean, normalizeAsin, normalizeMsku, sourceQueryBusy: false, routeKind: () => 'listing', isSalesPage: () => false,
    isProductExpressionPage: () => false, BACKFILL_BATCH_SIZE: 8, SOURCE_QUERY_MAX_MS: 52_000,
    waitForSearchInput: async (_, mode) => { assert.equal(mode, 'ASIN'); return controls; }, sourceSearchControls: () => controls,
    currentTableText: () => '', sourceQueryCandidates: (key, mode) => { assert.equal(mode, 'ASIN'); return [key]; },
    readLoadedTable: async (options) => { actions.push(options.action); if (options.action === 'state') return { ok: true, signature: 'old' }; assert.equal(options.query, identity.asin); input.value = options.query; return { ok: true, supported: true, submitted: options.query }; },
    waitForSourceResult: async () => ({ settled: true }), captureSourceRows: async () => [row(), row({ asin: 'B087654321', msku: identity.msku }, '$100')],
    saveSourceRows: async (rows) => saved.push(...rows), send: async (message) => { messages.push(message); return { ok: true }; },
    setInputValue: (target, value) => { target.value = value; }, submitSourceSearch() {}, console
  });
  await run('r', [identity.asin], null, ['价格'], 'asin');
  assert.deepEqual(actions, ['state', 'querySourceAsin']);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].identity.asin, identity.asin);
  assert.equal(messages.find((m) => m.result)?.result.matched, 1);
});

test('后台 Listing 关联请求只接受 ASIN，两方向派发及任务恢复保留匹配键', async () => {
  for (const [masterKind, sourceKind] of [['sales', 'listing'], ['listing', 'sales']]) {
    let listener;
    const storage = {}, messages = [];
    const origin = 'https://example.lingxing.com';
    const url = (kind) => `${origin}/erp/${kind === 'sales' ? 'mreport/salesStat' : 'listing'}`;
    const master = { tab: { id: 1, url: url(masterKind) } };
    const worker = { tab: { id: 99, url: url(sourceKind) } };
    const store = { async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map((name) => [name, storage[name]])); },
      async set(data) { Object.assign(storage, structuredClone(data)); }, async remove(key) { delete storage[key]; } };
    globalThis.chrome = {
      runtime: { getManifest: () => ({ version: '1.4.76' }), onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
      storage: { local: store, session: store },
      tabs: { async query() { return []; }, async create() { return worker.tab; }, async remove() {},
        async sendMessage(tabId, message) { messages.push({ tabId, message }); return message.type === 'LX_FORMAL_RUN_SOURCE_QUERY' ? { ok: true } : null; } }
    };
    try {
      const load = () => import(`../background.js?asin-${masterKind}-${Math.random()}`);
      await load();
      const request = (message, sender = master) => new Promise((resolve) => listener(message, sender, resolve));
      const base = { type: 'LX_FORMAL_BACKFILL_SOURCE', sourceKind, dateRange: { start: '2026-10-20', end: '2026-10-20' } };
      assert.equal((await request({ ...base, mskus: ['TEST-One-US'] })).ok, false, '不能把原 MSKU 请求当 ASIN');
      assert.equal((await request({ ...base, matchBy: 'msku', asins: [identity.asin] })).ok, false);
      assert.equal((await request({ ...base, matchBy: 'asin', asins: ['not-an-asin'] })).ok, false);
      const result = await request({ ...base, matchBy: 'asin', asins: [identity.asin.toLowerCase(), identity.asin] });
      assert.equal(result.ok, true);
      assert.equal(storage.formalSourcePendingQueries[0].matchBy, 'asin');
      // 模拟 service worker 回收后重新加载；不让旧 70 秒定时器挂住测试。
      await request({ type: 'LX_FORMAL_SOURCE_CANCEL', requestId: result.requestId });
      const pending = { requestId: result.requestId, requesterTabId: 1, sourceTabId: 99, sourceKind, matchBy: 'asin',
        mskus: [identity.asin], fieldLabels: ['价格'], dateRange: base.dateRange, started: false,
        deadline: Date.now() + 70000, readyDeadline: Date.now() + 25000 };
      storage.formalSourcePendingQueries = [pending];
      await load();
      await request({ type: 'LX_FORMAL_SOURCE_READY' }, worker);
      const dispatched = messages.findLast(({ message }) => message.type === 'LX_FORMAL_RUN_SOURCE_QUERY')?.message;
      assert.equal(dispatched.matchBy, 'asin');
      assert.deepEqual(dispatched.asins, [identity.asin]);
      assert.equal(dispatched.mskus, undefined);
      await request({ type: 'LX_FORMAL_SOURCE_RESULT', result: { requestId: result.requestId, ok: true, matched: 1 } }, worker);
      assert.equal(storage.formalSourcePendingQueries.length, 0);
    } finally { await new Promise((resolve) => setTimeout(resolve, 1300)); delete globalThis.chrome; }
  }
});
