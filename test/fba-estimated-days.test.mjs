import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const productKind = 'page@%2Ferp%2FproductExpressionNew';
const fieldId = `${productKind}:FBA可售天数预估`;
const clean = (value) => String(value ?? '').trim();
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

test('FBA 预估列使用独立界限，短红长黄、相等及非数值不预警', () => {
  let route = 'sales';
  const state = { inventoryDaysThresholds: { short: '30', long: '90' }, fbaEstimatedDaysThresholds: { short: '10', long: '60' } };
  const { tone, style } = vm.runInNewContext(`${section('  const inventoryDaysField = ', '\n  function render(')}\n({ tone: inventoryDaysTone, style: inventoryDaysCellStyle })`, {
    clean, state, PRODUCT_EXPRESSION_KIND: productKind,
    isSalesPage: () => route === 'sales', isProductExpressionPage: () => route === 'product'
  });
  const field = { sourceKind: productKind, label: 'FBA可售天数预估' };
  for (const value of ['0', '9', '9.5 天']) assert.equal(tone(field, value), 'short');
  for (const value of ['10', '35 天', '60', '', '未命中', '—', 'Infinity', '-1']) assert.equal(tone(field, value), '');
  assert.equal(tone(field, '61 日'), 'long');
  assert.match(style(field, '5'), /#fee2e2/);
  assert.match(style(field, '80'), /#fef3c7/);
  assert.doesNotMatch(style(field, '60'), /#fee2e2|#fef3c7/);
  state.fbaEstimatedDaysThresholds = { short: '', long: '' };
  assert.equal(tone(field, '0'), '');
  assert.equal(tone(field, '999'), '');
  route = 'product';
  assert.equal(tone(field, '1'), '');
  assert.equal(tone({ sourceKind: 'sales', label: '可用库存可售天数' }, '20'), 'short', '原库存天数界限不受影响');
});

test('扩展预警底色拒绝分组展开行的白色背景图覆盖，两个指标共享相同保护', () => {
  let route = 'sales';
  const state = { inventoryDaysThresholds: { short: '49', long: '86' }, fbaEstimatedDaysThresholds: { short: '49', long: '86' } };
  const style = vm.runInNewContext(`${section('  const inventoryDaysField = ', '\n  function render(')}\ninventoryDaysCellStyle`, {
    clean, state, PRODUCT_EXPRESSION_KIND: productKind,
    isSalesPage: () => route === 'sales', isProductExpressionPage: () => route === 'product'
  });
  for (const [page, field] of [
    ['sales', { sourceKind: productKind, label: 'FBA可售天数预估' }],
    ['product', { sourceKind: 'sales', label: '可用库存可售天数' }]
  ]) {
    route = page;
    for (const [value, background] of [['27', '#fee2e2'], ['123', '#fef3c7'], ['52', '#f8fbff']]) {
      const css = style(field, value);
      assert.ok(css.includes(`background:${background}!important`), '背景颜色不因行级 important 样式变化');
      assert.match(css, /(?:^|;)background-image:none!important(?:;|$)/, '移除盖在颜色上方的白色背景图');
    }
  }
  assert.deepEqual(state.fbaEstimatedDaysThresholds, { short: '49', long: '86' }, '不改用户阈值');
});

test('切换视图重绘后的边界、未命中、关闭阈值不残留预警色块或文字', () => {
  const state = { fbaEstimatedDaysThresholds: { short: '49', long: '86' } };
  const style = vm.runInNewContext(`${section('  const inventoryDaysField = ', '\n  function render(')}\ninventoryDaysCellStyle`, {
    clean, state, PRODUCT_EXPRESSION_KIND: productKind, isSalesPage: () => true, isProductExpressionPage: () => false
  });
  const field = { sourceKind: productKind, label: 'FBA可售天数预估' };
  assert.match(style(field, '0'), /background:#fee2e2!important/);
  for (const value of ['49', '86', '52', '未命中', '未识别', '', '—']) {
    const css = style(field, value);
    assert.match(css, /background:#f8fbff!important/);
    assert.doesNotMatch(css, /#fee2e2|#fef3c7|color:|font-weight:/);
  }
  state.fbaEstimatedDaysThresholds = { short: '', long: '' };
  for (const value of ['0', '27', '123']) assert.doesNotMatch(style(field, value), /#fee2e2|#fef3c7|color:|font-weight:/);
  assert.doesNotMatch(style({ sourceKind: 'listing', label: '价格' }, '27'), /#fee2e2|#fef3c7/);
});

test('原生、AK 与 VXE 渲染路径仅在扩展单元格上使用共同的底色保护', () => {
  for (const renderer of [
    section('  function injectNativeColumns(', '\n  function injectAkColumns('),
    section('  function injectAkColumns(', '\n  function scheduleColumnVerification('),
    section('  function injectColumns(', '\n  chrome.runtime.onMessage.addListener(')
  ]) {
    assert.match(renderer, /td\.className = "[^"]*lx-formal-column"/);
    assert.match(renderer, /td\.style\.cssText = `[^`]*inventoryDaysCellStyle\(field, value\)/);
  }
});

test('阈值输入只更新所属指标，非法上下限不写入，并触发保存和重绘', async () => {
  const state = { inventoryDaysThresholds: { short: '30', long: '90' }, fbaEstimatedDaysThresholds: { short: '', long: '' } };
  const calls = [];
  const bar = { dataset: { thresholdKey: 'fbaEstimatedDaysThresholds' }, querySelectorAll: () => inputs };
  const inputs = ['short', 'long'].map((edge, index) => ({ dataset: { threshold: edge }, value: index ? '60' : '10',
    validity: { badInput: false }, closest: () => bar, setCustomValidity(value) { this.error = value; }, reportValidity() {} }));
  const start = source.indexOf('    root.querySelectorAll(".threshold-inputs input").forEach(');
  const end = source.indexOf('\n    root.querySelector(".batch-toggle")', start);
  vm.runInNewContext(source.slice(start, end), { root: { querySelectorAll: () => inputs }, state,
    thresholdSaveTimer: null, thresholdSavePending: false, clearTimeout() {},
    setTimeout(callback) { callback(); return 1; }, saveLayout: async () => { calls.push('save'); }, injectColumns: () => calls.push('paint') });
  inputs[0].oninput(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.fbaEstimatedDaysThresholds.short, '10');
  assert.deepEqual(state.inventoryDaysThresholds, { short: '30', long: '90' });
  assert.deepEqual(calls, ['save', 'paint']);
  inputs[0].value = '70'; inputs[0].oninput();
  assert.equal(state.fbaEstimatedDaysThresholds.short, '10');
  assert.match(inputs[0].error, /过短天数必须小于/);
  assert.equal(calls.length, 2);
});

test('销量统计首次自动添加预估列；之后移除不强行恢复，原阈值保留', async () => {
  let layout = { fieldIds: [], inventoryDaysThresholds: { short: '30', long: '90' } };
  let sales = true;
  const field = { id: fieldId, sourceKind: productKind, label: 'FBA可售天数预估' };
  const state = { selected: [], dateRanges: {}, batchSelected: new Set(), panel: {}, fbaEstimatedDaysInitialized: false };
  const saved = [];
  const context = { state, FBA_ESTIMATED_DAYS_ID: fieldId, stopped: false, thresholdSavePending: false,
    routeKind: () => sales ? 'sales' : 'listing', isSalesPage: () => sales,
    send: async () => ({ ok: true, targetKind: sales ? 'sales' : 'listing', data: { fields: [field], layout } }),
    saveLayout: async () => { saved.push([...state.selected]); layout = { ...layout, fieldIds: [...state.selected], fbaEstimatedDaysInitialized: true }; return { ok: true }; },
    render() {}, injectColumns() {}, setTimeout() {}
  };
  const refresh = vm.runInNewContext(`${section('  async function refreshLibrary(', '\n  function updateBackfill(')}\nrefreshLibrary`, context);
  await refresh();
  assert.deepEqual(Array.from(state.selected), [fieldId]);
  assert.equal(saved.length, 1);
  assert.deepEqual(state.inventoryDaysThresholds, { short: '30', long: '90' });
  await refresh(); assert.equal(saved.length, 1);
  layout = { ...layout, fieldIds: [], fbaEstimatedDaysThresholds: { short: '15', long: '80' } };
  await refresh();
  assert.equal(state.selected.length, 0);
  assert.equal(state.fbaEstimatedDaysThresholds.short, '15');
  sales = false; layout = { fieldIds: [] }; await refresh();
  assert.equal(state.selected.length, 0, '其他页面不默认添加该列');
});

test('读取产品表现完整列时，视口缺失的店铺身份不覆盖业务表正确值', async () => {
  const read = vm.runInNewContext(`${section('  async function captureSourceRows(', '\n  async function waitLoadedTableSettled(')}\ncaptureSourceRows`, {
    captureVisibleTable: () => [{ identity: { msku: 'A-EU', store: '', marketplace: '' }, fields: { 品名: 'A' } }],
    isSalesPage: () => false, isProductExpressionMskuView: () => true, normalizeMsku: (value) => value, clean,
    readLoadedTable: async () => ({ ok: true, rows: [{ identity: { msku: 'A-EU', store: 'SAMPLE-DE', marketplace: '德国' }, fields: { FBA可售天数预估: '0' } }] })
  });
  const rows = await read();
  assert.equal(rows[0].identity.store, 'SAMPLE-DE');
  assert.equal(rows[0].fields.FBA可售天数预估, '0');
});

test('互为来源时来源工作页不派生新补查，首次产品来源也始终传递报表日期', () => {
  const schedule = section('  function scheduleSourceBackfill(', '\n  function cleanupColumns(');
  let cleared = false;
  const fn = vm.runInNewContext(`${schedule}\nscheduleSourceBackfill`, { sourceQueryBusy: true, backfillTimer: 1, clearTimeout: () => { cleared = true; } });
  fn([], []);
  assert.equal(cleared, true);
  assert.match(schedule, /sourceKind === PRODUCT_EXPRESSION_KIND/);
  assert.match(source, /kind === "sales" \|\| kind === PRODUCT_EXPRESSION_KIND/);
});

test('产品表现直接用完整 MSKU 原生搜索，保存独立店铺的预估天数及零值', async () => {
  const input = { value: '', isConnected: true };
  const controls = { input, mode: 'MSKU', modeInput: { value: 'MSKU', isConnected: true }, originalMode: 'MSKU' };
  const range = { start: '2026-10-19', end: '2026-10-19' };
  const events = [];
  const saved = [];
  const messages = [];
  const run = vm.runInNewContext(`${section('  async function runSourceQuery(', '\n  function findMatchingRow(')}\nrunSourceQuery`, {
    sourceQueryBusy: false, BACKFILL_BATCH_SIZE: 8, SOURCE_QUERY_MAX_MS: 52000,
    clean, normalizeMsku: (value) => value, routeKind: () => productKind,
    isProductExpressionPage: () => true, isSalesPage: () => false,
    ensureSourceMskuView: async () => { events.push('view'); return true; },
    waitForSearchInput: async (timeout, mode) => { assert.equal(mode, 'MSKU'); events.push('mode'); return controls; },
    pageDateRange: () => range, dateRangeKey: (value) => `${value.start}:${value.end}`,
    setSourceDateRange: async (value) => { assert.deepEqual(value, range); events.push('date'); return true; },
    sourceSearchControls: () => controls, sourceQueryCandidates: (msku, mode) => { assert.equal(mode, 'MSKU'); return [msku]; },
    readLoadedTable: async ({ action, query }) => {
      if (action === 'state') return { ok: true, signature: 'old' };
      assert.equal(action, 'queryProductMsku'); assert.equal(query, 'A-EU');
      input.value = query; events.push(`native:${query}`);
      return { ok: true, supported: true, submitted: query };
    },
    currentTableText: () => '', setInputValue: (node, value) => { node.value = value; },
    submitSourceSearch: () => events.push(`query:${input.value}`),
    waitForSourceResult: async (msku) => { assert.equal(msku, 'A-EU'); return { settled: true }; },
    captureSourceRows: async () => [
      { identity: { msku: 'A-EU', store: 'SAMPLE-DE' }, fields: { FBA可售天数预估: '27' } },
      { identity: { msku: 'A-EU', store: 'SAMPLE-FR' }, fields: { FBA可售天数预估: '0' } }
    ],
    saveSourceRows: async (rows) => { saved.push(...rows); return { ok: true }; },
    send: async (message) => { messages.push(message); return { ok: true }; },
    setTimeout: (callback) => { callback(); }, console
  });
  await run('fba-query', ['A-EU'], range, ['FBA可售天数预估']);
  const result = messages.find((message) => message.type === 'LX_FORMAL_SOURCE_RESULT')?.result;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.matched, 1);
  assert.deepEqual(saved.map((row) => [row.identity.store, row.fields.FBA可售天数预估]), [['SAMPLE-DE', '27'], ['SAMPLE-FR', '0']]);
  assert.deepEqual(events, ['view', 'mode', 'date', 'native:A-EU', 'query:']);
});

test('预估列即使只有一个同 MSKU 候选，也拒绝不同或缺失店铺站点的数据', () => {
  const identity = { msku: 'A-EU', store: 'SAMPLE-DE', marketplace: '德国' };
  const field = { sourceKind: productKind, label: 'FBA可售天数预估' };
  const match = vm.runInNewContext(`${section('  function findFieldMatchingRow(', '\n  function acceptBackfillMessage(')}\nfindFieldMatchingRow`, {
    clean, routeKind: () => 'sales', normalizeMarketplace: (value) => ({ 德国: 'DE', 法国: 'FR' })[value] || clean(value),
    findMatchingRow: (identity, rows) => rows[0] || null,
    fbaEstimatedDaysField: (value) => value?.sourceKind === productKind && value?.label === 'FBA可售天数预估'
  });
  assert.equal(match(identity, [{ identity: { ...identity, store: 'SAMPLE-FR' } }], field), null);
  assert.equal(match(identity, [{ identity: { ...identity, marketplace: '法国' } }], field), null);
  assert.equal(match(identity, [{ identity: { msku: 'A-EU' } }], field), null);
  assert.equal(match(identity, [{ identity }], field).identity.store, 'SAMPLE-DE');
  assert.ok(match(identity, [{ identity: { ...identity, store: 'SAMPLE-FR' } }], { sourceKind: 'sales', label: '其他字段' }), '非 Listing 的通用字段行为不改变');
});
