import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const matchSource = section('  const libraryFieldMatchesSearch = ', '\n  const state = ');
const routeLabel = (kind) => ({ listing: 'Listing', sales: '销量统计', product: '产品表现' })[kind] || kind || '';
const match = vm.runInNewContext(`${matchSource}\nlibraryFieldMatchesSearch`, { routeLabel });
const fields = [
  { id: 'listing:广告费', label: '7|14|30天广告费', sourceKind: 'listing' },
  { id: 'listing:库存', label: '库存', sourceKind: 'listing' },
  { id: 'product:ACoAS', label: 'ACoAS', sourceKind: 'product' },
  { id: 'sales:库存', label: '可用库存', sourceKind: 'sales', sourceLabel: '每日销售' },
  { id: 'listing:价格', label: '价格', sourceKind: 'listing' }
];

test('其他字段搜索支持字段名、来源、多词、英文大小写和全角输入，空词显示全部', () => {
  assert.equal(match(fields[0], 'listing 广告'), true);
  assert.equal(match(fields[0], '  ＬＩＳＴＩＮＧ  广告  '), true);
  assert.equal(match(fields[0], 'listing 库存'), false);
  assert.equal(match(fields[2], '产品表现 acoas'), true);
  assert.equal(match(fields[3], '每日销售 库存'), true);
  assert.equal(match(fields[3], '销量统计'), true);
  for (const query of ['', '  ', '\n\t']) assert.ok(fields.every((field) => match(field, query)));
  assert.equal(match(fields[0], '.*'), false, '按字面匹配，不执行正则');
  assert.equal(match(fields[0], '<script>'), false);
});

test('只隐藏其他字段卡片，不重建拖拽节点，不影响常用字段、已选字段和源数据', () => {
  const chips = fields.slice(0, 4).map((field) => ({ dataset: { id: field.id }, hidden: false, draggable: true, handler: {} }));
  const originalHandlers = chips.map((chip) => chip.handler);
  const state = { data: { fields }, fieldSearch: 'listing 广告', selected: ['product:ACoAS'], batchDeleteMode: false };
  const status = {}, empty = {}, clear = {}, scroll = { scrollTop: 100 };
  const root = { querySelectorAll: (selector) => { assert.equal(selector, '.other-fields .chip'); return chips; },
    querySelector: (selector) => ({ '.field-search-status': status, '.search-empty': empty, '.clear-field-search': clear, '.library-scroll': scroll })[selector] };
  const update = vm.runInNewContext(`${section('  function updateLibrarySearch(', '\n  function updateBatchControls(')}\nupdateLibrarySearch`, { state, root, libraryFieldMatchesSearch: match });
  update(true);
  assert.deepEqual(chips.map((chip) => chip.hidden), [false, true, true, true]);
  assert.equal(status.textContent, '匹配 1 / 共 4 个其他字段');
  assert.equal(empty.hidden, true);
  assert.equal(scroll.scrollTop, 0);
  assert.deepEqual(state.selected, ['product:ACoAS']);
  assert.equal(fields.length, 5);
  chips.forEach((chip, index) => { assert.equal(chip.handler, originalHandlers[index]); assert.equal(chip.draggable, true); });
  state.fieldSearch = '不存在字段'; update();
  assert.ok(chips.every((chip) => chip.hidden)); assert.equal(empty.hidden, false);
  state.fieldSearch = ''; update();
  assert.ok(chips.every((chip) => !chip.hidden)); assert.equal(clear.disabled, true);
});

test('连续输入原地筛选，中文组合输入完成后再处理待重绘，清空不保存布局', () => {
  const state = { fieldSearch: '' };
  const input = { value: 'Listing', focus() { calls.push('focus'); } };
  const clear = {};
  const calls = [];
  const context = { state, root: { querySelector: (selector) => selector === '.field-search' ? input : clear },
    updateLibrarySearch: (reset) => calls.push(`filter:${reset}`), librarySearchComposing: false, renderPending: true, render: () => calls.push('render') };
  vm.runInNewContext(section('    const search = root.querySelector(\'.field-search\');', '\n    root.querySelector(\'.scroll-up\')'), context);
  input.oninput(); assert.equal(state.fieldSearch, 'Listing'); assert.deepEqual(calls, ['filter:true']);
  input.oncompositionstart(); input.value = '产品'; input.oninput();
  assert.deepEqual(calls, ['filter:true']);
  input.oncompositionend(); assert.deepEqual(calls, ['filter:true', 'filter:true', 'render']);
  clear.onclick(); assert.equal(state.fieldSearch, ''); assert.equal(input.value, '');
  assert.deepEqual(calls.slice(-2), ['filter:true', 'focus']);
  const render = section('  function render(', '\n  function chipHtml(');
  assert.match(render, /root\.activeElement === oldSearch/);
  assert.match(render, /input\.focus\(\{ preventScroll: true \}\)/);
  assert.match(render, /input\.setSelectionRange\(searchFocus\.start, searchFocus\.end/);
  assert.match(render, /if \(state\.dragging \|\| librarySearchComposing\)/);
  assert.match(render, /value="\$\{esc\(state.fieldSearch\)\}"/);
});

test('搜索中的全选仅覆盖可见字段，不勾选被过滤项，筛选外已选数量明确提示', () => {
  const state = { data: { fields }, fieldSearch: 'Listing 广告', batchDeleteMode: true, batchSelected: new Set(['sales:库存']) };
  const scopeSource = section('  function visibleBatchFields(', '\n  function updateLibrarySearch(');
  const scope = vm.runInNewContext(`${scopeSource}\nvisibleBatchFields`, { state, COMMON_FIELD_IDS: ['listing:价格'], libraryFieldMatchesSearch: match });
  assert.deepEqual(Array.from(scope(), (field) => field.id), ['listing:广告费', 'listing:价格']);
  let toggle;
  const root = { querySelector: () => ({ addEventListener: (_name, fn) => { toggle = fn; } }), querySelectorAll: () => [] };
  vm.runInNewContext(section('    root.querySelector(".batch-select-all")', '\n    root.querySelector(".batch-delete")'), { state, root, visibleBatchFields: scope, updateBatchControls() {} });
  toggle(); assert.deepEqual([...state.batchSelected].sort(), ['listing:价格', 'listing:广告费', 'sales:库存'].sort());
  assert.equal(state.batchSelected.has('listing:库存'), false);
  toggle(); assert.deepEqual([...state.batchSelected], ['sales:库存'], '取消全选不丢弃先前筛选外的显式勾选');
  assert.match(section('  function updateLibrarySearch(', '\n  function updateBatchControls('), /个已选字段在筛选外/);
});
