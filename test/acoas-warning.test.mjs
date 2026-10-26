import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const toneSource = section('  function acoasTone(', '\n  function renderAcoasWarnings(');
const clean = (value) => String(value ?? '').trim();

test('ACoAS 只在超过百分数上限时标红，零值和等于边界不标红，留空关闭', () => {
  const state = { acoasThresholds: { high: '5.5' } };
  const tone = vm.runInNewContext(`${toneSource}\nacoasTone`, { clean, state });
  for (const value of ['0%', '-1%', '5.5%', '5.50%', '5.49%']) assert.equal(tone(value), '', value);
  for (const value of ['5.51%', '10 %', '105％']) assert.equal(tone(value), 'high', value);
  for (const value of ['', '—', '未命中', '0.6', '6', 'Infinity%', '$10', '6% 5%']) assert.equal(tone(value), '', value);
  state.acoasThresholds.high = '0'; assert.equal(tone('0%'), ''); assert.equal(tone('0.01%'), 'high');
  state.acoasThresholds.high = ''; assert.equal(tone('999%'), '');
});

test('ACoAS 编辑框只有非负上限，不复用毛利率上下限或黄色高亮', async () => {
  const state = { acoasThresholds: { high: '0' }, orderGrossMarginThresholds: { low: '20', high: '30' } };
  const html = vm.runInNewContext(`${section('  function thresholdBarHtml(', '\n  function render(')}\nthresholdBarHtml`, { state, esc: clean })({ key: 'acoasThresholds' });
  assert.match(html, /ACoAS上限阈值/); assert.match(html, /value="0"/); assert.match(html, /min="0"/);
  assert.equal((html.match(/<input /g) || []).length, 1); assert.doesNotMatch(html, /标黄/);
  const calls = [];
  const bar = { dataset: { thresholdKey: 'acoasThresholds' }, querySelectorAll: () => [input] };
  const input = { value: '6.5', dataset: { threshold: 'high' }, validity: { badInput: false }, closest: () => bar, setCustomValidity(value) { this.error = value; }, reportValidity() {} };
  vm.runInNewContext(section('    root.querySelectorAll(".threshold-inputs input").forEach(', '\n    root.querySelector(".batch-toggle")'), { state, root: { querySelectorAll: () => [input] }, thresholdSaveTimer: null, thresholdSavePending: false, clearTimeout() {}, setTimeout(fn) { fn(); }, saveLayout: async () => calls.push('save'), injectColumns: () => calls.push('paint') });
  input.oninput(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.acoasThresholds.high, '6.5'); assert.deepEqual(calls, ['save', 'paint']);
  for (const bad of ['-1', '100001', 'Infinity']) { input.value = bad; input.oninput(); assert.equal(state.acoasThresholds.high, '6.5'); }
  input.value = ''; input.oninput(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.acoasThresholds.high, ''); assert.deepEqual(state.orderGrossMarginThresholds, { low: '20', high: '30' });
});

test('原生列严格区分 ACoAS、ACOS、ASoAS，仅标记数据单元格并清理复用行', () => {
  const attr = 'data-lx-formal-acoas-tone';
  const makeCell = (text) => ({ innerText: text, style: { cssText: 'color:green' }, attrs: new Map(), classList: { contains: () => false }, getAttribute(name) { return this.attrs.get(name) ?? null; }, setAttribute(name, value) { this.attrs.set(name, value); }, removeAttribute(name) { this.attrs.delete(name); } });
  const high = makeCell('6%'), normal = makeCell('5%'), acos = makeCell('99%'), asoas = makeCell('99%');
  const cells = [high, normal, acos, asoas];
  const wrappers = [{ label: 'ACoAS', cells: [high, normal] }, { label: 'ACOS', cells: [acos] }, { label: 'ASoAS', cells: [asoas] }];
  wrappers.forEach((w) => { w.querySelectorAll = () => w.cells.map((cell) => ({ querySelector: () => cell })); });
  let product = true;
  let visible = true;
  const styles = new Map();
  const document = { querySelectorAll: (selector) => selector === '.vxe-table' ? [{ querySelectorAll: () => wrappers }] : cells.filter((cell) => cell.attrs.has(attr)), getElementById: (id) => styles.get(id), createElement: () => ({ remove() { styles.delete(this.id); } }), documentElement: { append: (style) => styles.set(style.id, style) } };
  const state = { acoasThresholds: { high: '5' } };
  const paint = vm.runInNewContext(`${toneSource}\n${section('  function renderAcoasWarnings(', '\n  function thresholdBarHtml(')}\nrenderAcoasWarnings`, { state, clean, document, CSS: { escape: (value) => value }, isProductExpressionPage: () => product, isRendered: () => visible, headerMap: (w) => new Map([['column', w.label]]) });
  paint(); assert.equal(high.getAttribute(attr), 'high');
  assert.equal(normal.getAttribute(attr), null); assert.equal(acos.getAttribute(attr), null); assert.equal(asoas.getAttribute(attr), null);
  assert.equal(high.style.cssText, 'color:green');
  assert.match([...styles.values()][0].textContent, /background:#fee2e2!important;background-image:none!important/);
  assert.doesNotMatch([...styles.values()][0].textContent, /#fef3c7/);
  high.innerText = '—'; paint(); assert.equal(high.getAttribute(attr), null); assert.equal(styles.size, 0);
  high.innerText = '7%'; paint(); visible = false; paint(); assert.equal(high.getAttribute(attr), null);
  visible = true; paint(); state.acoasThresholds.high = ''; paint(); assert.equal(high.getAttribute(attr), null);
  state.acoasThresholds.high = '5'; paint(); product = false; paint(); assert.equal(high.getAttribute(attr), null); assert.equal(styles.size, 0);
});

test('ACoAS 设置独立保存/恢复，接入无跨页字段及虚拟表重绘的生命周期', async () => {
  const state = { selected: [], panel: {}, dateRanges: {}, acoasThresholds: { high: '5' }, orderGrossMarginThresholds: { low: '20', high: '30' } };
  const save = vm.runInNewContext(`${section('  async function saveLayout(', '\n  async function refreshLibrary(')}\nsaveLayout`, { state, send: async (message) => message });
  const message = await save(); assert.equal(message.acoasThresholds.high, '5'); assert.equal(message.orderGrossMarginThresholds.low, '20');
  assert.match(source, /if \(!thresholdSavePending\) state.acoasThresholds = result.data.layout\?\.acoasThresholds/);
  assert.match(section('  function syncRoute(', '\n  async function startPageSession('), /state.acoasThresholds = \{ high: "" \}/);
  assert.match(section('  function install(', '\n  function panelX('), /renderAcoasWarnings\(\)/);
  const inject = section('  function injectColumns(', '\n  chrome.runtime.onMessage.addListener(');
  assert.ok(inject.indexOf('renderAcoasWarnings();') < inject.indexOf('findTableMount()'));
});
