import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const toneSource = section('  function orderGrossMarginTone(', '\n  function renderOrderGrossMarginWarnings(');
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

test('毛利率按显示的百分数比较，支持负值/零/小数，等于上下限不标色', () => {
  const state = { orderGrossMarginThresholds: { low: '10', high: '30' } };
  const tone = vm.runInNewContext(`${toneSource}\norderGrossMarginTone`, { clean, state });
  for (const value of ['-150%', '−5.20%', '－0.5％', '0%', '+.5%', '9.99 %']) assert.equal(tone(value), 'low', value);
  for (const value of ['10%', '10.00%', '25.5 %', '30%', '30.000%']) assert.equal(tone(value), '', value);
  for (const value of ['30.01%', '101%', '+37.80％']) assert.equal(tone(value), 'high', value);
  state.orderGrossMarginThresholds = { low: '-10', high: '0' };
  assert.equal(tone('-10.01%'), 'low');
  assert.equal(tone('-10%'), '');
  assert.equal(tone('0%'), '');
  assert.equal(tone('0.01%'), 'high');
});

test('毛利率不把金额、原始比率、空值或对比文本当成当前百分数；空界限各自关闭', () => {
  const state = { orderGrossMarginThresholds: { low: '10', high: '30' } };
  const tone = vm.runInNewContext(`${toneSource}\norderGrossMarginTone`, { clean, state });
  for (const value of ['', '—', '未命中', '$25.00', '0.25', '25', 'NaN%', 'Infinity%', '25% 30%', '25% $10', '--5%']) assert.equal(tone(value), '', value);
  state.orderGrossMarginThresholds = { low: '', high: '30' };
  assert.equal(tone('-100%'), '');
  assert.equal(tone('31%'), 'high');
  state.orderGrossMarginThresholds = { low: '10', high: '' };
  assert.equal(tone('0%'), 'low');
  assert.equal(tone('100%'), '');
  state.orderGrossMarginThresholds = { low: '', high: '' };
  assert.equal(tone('-100%'), '');
  assert.equal(tone('100%'), '');
});

test('产品表现面板独立显示百分比编辑框，不依赖已拖入字段，天数编辑框保持原语义', () => {
  const state = { orderGrossMarginThresholds: { low: '-5.5', high: '35' }, inventoryDaysThresholds: { short: '30', long: '90' } };
  const html = vm.runInNewContext(`${section('  function thresholdBarHtml(', '\n  function render(')}\nthresholdBarHtml`, { state, esc: clean });
  const margin = html({ key: 'orderGrossMarginThresholds', label: '订单毛利率' });
  assert.match(margin, /data-threshold="low"/);
  assert.match(margin, /data-threshold="high"/);
  assert.match(margin, /min="-100000"/);
  assert.match(margin, /输入 10 表示 10%/);
  assert.match(margin, /value="-5.5"/);
  assert.match(margin, /订单毛利率下限阈值/);
  const days = html({ key: 'inventoryDaysThresholds', label: '可用库存可售天数' });
  assert.match(days, /data-threshold="short"/);
  assert.match(days, /min="0"/);
  assert.match(days, /过短天数/);
  assert.match(source, /key: 'orderGrossMarginThresholds', label: '订单毛利率', show: isProductExpressionPage\(\)/);
});

const paintFixture = () => {
  const attr = 'data-lx-formal-order-margin-tone';
  const makeCell = (value, injected = false) => ({ innerText: value, textContent: value, attrs: new Map(), style: { cssText: 'height:48px;color:green' },
    classList: { contains: (name) => injected && name === 'lx-formal-column' },
    getAttribute(name) { return this.attrs.get(name) ?? null; }, setAttribute(name, value) { this.attrs.set(name, value); }, removeAttribute(name) { this.attrs.delete(name); } });
  const cells = [makeCell('-5.20%'), makeCell('37.80%'), makeCell('25.37%'), makeCell('10%'), makeCell('30%'), makeCell('未命中'), makeCell('0%'), makeCell('4%', true)];
  const unrelated = makeCell('$42');
  const wrappers = [{ column: 'margin', rows: cells.map((cell) => ({ querySelector: () => cell })) }, { column: 'profit', rows: [{ querySelector: () => unrelated }] }];
  wrappers.forEach((wrapper) => { wrapper.querySelectorAll = () => wrapper.rows; });
  const styles = new Map();
  let product = true;
  let visible = true;
  const document = {
    querySelectorAll(selector) { return selector === '.vxe-table' ? [table] : cells.concat(unrelated).filter((cell) => cell.attrs.has(attr)); },
    getElementById(id) { return styles.get(id); },
    createElement() { return { remove() { styles.delete(this.id); } }; },
    documentElement: { append(node) { styles.set(node.id, node); } }
  };
  const table = { querySelectorAll: () => wrappers };
  const state = { orderGrossMarginThresholds: { low: '10', high: '30' } };
  const paint = vm.runInNewContext(`${toneSource}\n${section('  function renderOrderGrossMarginWarnings(', '\n  function thresholdBarHtml(')}\nrenderOrderGrossMarginWarnings`, {
    state, clean, document, CSS: { escape: (value) => value }, isProductExpressionPage: () => product, isRendered: () => visible,
    headerMap: (wrapper) => new Map([[wrapper.column, wrapper.column === 'margin' ? '订单毛利率' : '订单毛利润']])
  });
  return { cells, unrelated, wrappers, styles, state, paint, attr, route: (value) => { product = value; }, visible: (value) => { visible = value; } };
};

test('原生毛利率仅按精确表头标记数据行，不改金额列、注入列或原 inline 样式', () => {
  const fixture = paintFixture();
  fixture.paint();
  assert.deepEqual(fixture.cells.map((cell) => cell.getAttribute(fixture.attr)), ['low', 'high', null, null, null, null, 'low', null]);
  assert.equal(fixture.unrelated.getAttribute(fixture.attr), null);
  assert.ok(fixture.cells.every((cell) => cell.style.cssText === 'height:48px;color:green'));
  const css = [...fixture.styles.values()][0].textContent;
  assert.match(css, /background:#fee2e2!important;background-image:none!important/);
  assert.match(css, /background:#fef3c7!important;background-image:none!important/);
  assert.doesNotMatch(css, /td\s*\{|\.vxe-body--column\s*\{/);
});

test('虚拟单元格复用、列移出视口、清空界限、切离产品表现时清理旧预警', () => {
  const f = paintFixture();
  f.paint();
  f.cells[0].innerText = '25%'; f.cells[1].innerText = '—'; f.paint();
  assert.equal(f.cells[0].getAttribute(f.attr), null);
  assert.equal(f.cells[1].getAttribute(f.attr), null);
  f.visible(false); f.paint();
  assert.ok(f.cells.every((cell) => !cell.attrs.has(f.attr)));
  assert.equal(f.styles.size, 0);
  f.visible(true); f.paint();
  assert.equal(f.cells[6].getAttribute(f.attr), 'low');
  f.state.orderGrossMarginThresholds = { low: '', high: '' }; f.paint();
  assert.equal(f.styles.size, 0);
  f.state.orderGrossMarginThresholds = { low: '10', high: '30' }; f.paint();
  f.route(false); f.paint();
  assert.ok(f.cells.every((cell) => !cell.attrs.has(f.attr)));
  assert.equal(f.styles.size, 0);
});

test('毛利率编辑只写所属设置，允许负值；非法上下限、无限值不覆盖已保存值', async () => {
  const state = { orderGrossMarginThresholds: { low: '', high: '' }, inventoryDaysThresholds: { short: '30', long: '90' } };
  const calls = [];
  const bar = { dataset: { thresholdKey: 'orderGrossMarginThresholds' }, querySelectorAll: () => inputs };
  const inputs = ['low', 'high'].map((edge, i) => ({ dataset: { threshold: edge }, value: i ? '35' : '-5', validity: { badInput: false },
    closest: () => bar, setCustomValidity(value) { this.error = value; }, reportValidity() {} }));
  vm.runInNewContext(section('    root.querySelectorAll(".threshold-inputs input").forEach(', '\n    root.querySelector(".batch-toggle")'), {
    root: { querySelectorAll: () => inputs }, state, thresholdSaveTimer: null, thresholdSavePending: false,
    clearTimeout() {}, setTimeout(callback) { callback(); return 1; }, saveLayout: async () => { calls.push('save'); }, injectColumns: () => calls.push('paint')
  });
  inputs[0].oninput(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.orderGrossMarginThresholds.low, '-5');
  assert.equal(state.orderGrossMarginThresholds.high, '35');
  assert.deepEqual(state.inventoryDaysThresholds, { short: '30', long: '90' });
  assert.deepEqual(calls, ['save', 'paint']);
  for (const bad of ['35', '36', 'Infinity', '100001', '-100001']) {
    inputs[0].value = bad; inputs[0].oninput();
    assert.equal(state.orderGrossMarginThresholds.low, '-5');
  }
  inputs[0].value = '5'; inputs[0].validity.badInput = true; inputs[0].oninput();
  assert.equal(state.orderGrossMarginThresholds.low, '-5');
  inputs[0].validity.badInput = false; inputs[0].value = ''; inputs[0].oninput(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.orderGrossMarginThresholds.low, '');
});

test('未选跨页字段也更新原生预警；保存/恢复设置及路由清理接入现有生命周期', async () => {
  const inject = section('  function injectColumns(', '\n  chrome.runtime.onMessage.addListener(');
  assert.ok(inject.indexOf('renderOrderGrossMarginWarnings();') < inject.indexOf('findTableMount()'));
  let painted = 0;
  const update = vm.runInNewContext(`${inject}\ninjectColumns`, { injecting: false, stopped: false,
    state: { selected: [], data: { fields: [] } }, renderOrderGrossMarginWarnings: () => { painted += 1; }, renderAcoasWarnings() {}, findTableMount: () => null });
  update();
  assert.equal(painted, 1, '即使无 MSKU 主表挂载点，也先更新百分比预警');
  assert.match(section('  function install(', '\n  function panelX('), /renderOrderGrossMarginWarnings\(\)/);
  assert.match(section('  function syncRoute(', '\n  async function startPageSession('), /state.orderGrossMarginThresholds = \{ low: "", high: "" \}/);
  assert.match(section('  async function refreshLibrary(', '\n  function updateBackfill('), /if \(!thresholdSavePending\) state.orderGrossMarginThresholds = result.data.layout\?\.orderGrossMarginThresholds/);
  const state = { selected: [], panel: {}, dateRanges: {}, inventoryDaysThresholds: { short: '30', long: '90' },
    fbaEstimatedDaysThresholds: { short: '49', long: '86' }, orderGrossMarginThresholds: { low: '-5', high: '35' }, fbaEstimatedDaysInitialized: true };
  const save = vm.runInNewContext(`${section('  async function saveLayout(', '\n  async function refreshLibrary(')}\nsaveLayout`, { state, send: async (message) => message });
  const message = await save();
  assert.equal(message.orderGrossMarginThresholds.low, '-5');
  assert.equal(message.inventoryDaysThresholds.short, '30');
  assert.equal(message.fbaEstimatedDaysThresholds.short, '49');
});
