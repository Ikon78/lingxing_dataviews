import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../page-table.js', import.meta.url), 'utf8');

test('销量 MSKU 模式通过搜索选择器本身的原生选项处理提交，后台菜单不可见也可验证', async () => {
  const listeners = new Map();
  const messages = [];
  const input = { value: 'ASIN' };
  let accepted = true;
  let calls = 0;
  const option = { currentLabel: 'MSKU', value: 'merchant-sku-mode' };
  const select = {
    $options: { name: 'ElSelect' }, options: [option],
    handleOptionSelect(selected, byClick) {
      assert.equal(selected, option);
      assert.equal(byClick, true);
      calls += 1;
      if (accepted) input.value = selected.currentLabel;
    },
    $nextTick: (callback) => callback()
  };
  const element = { __vue__: select, getBoundingClientRect: () => ({ width: 65 }), querySelector: () => input };
  const location = { pathname: '/erp/mreport/salesStat', origin: 'https://example.lingxing.com' };
  const window = { addEventListener: (type, callback) => listeners.set(type, callback), postMessage: (message) => messages.push(message) };
  vm.runInNewContext(source, { window, location, document: { querySelectorAll: (selector) => selector === '.ak-search-wrapper .field-select' ? [element] : [] } });
  const request = async (action = 'selectSalesMsku') => {
    await listeners.get('message')({ source: window, origin: location.origin, data: { type: 'LX_FORMAL_LOADED_TABLE_REQUEST', requestId: 'search', action } });
    return messages.at(-1);
  };
  assert.equal((await request()).ok, true);
  assert.equal(input.value, 'MSKU');
  assert.equal(calls, 1);
  assert.equal((await request()).ok, true);
  assert.equal(calls, 1, '已经是 MSKU 时不重复提交');
  input.value = 'ASIN'; accepted = false;
  assert.equal((await request()).ok, false, '处理函数执行不等同于实际切换成功');
  assert.match(messages.at(-1).reason, /实际 ASIN/);
  option.disabled = true;
  assert.equal((await request()).supported, false);
  assert.equal(calls, 2, '禁用选项不可调用');
  location.pathname = '/erp/productExpressionNew'; option.disabled = false; accepted = true; input.value = '品名';
  assert.equal((await request('selectProductMsku')).ok, true);
  assert.equal(input.value, 'MSKU', '产品表现也选择实际 MSKU 选项而不是改文字');
  const asin = { currentLabel: 'ASIN', value: 'actual-asin-option' };
  select.options.push(asin);
  select.handleOptionSelect = (option, byClick) => { assert.equal(option, asin); assert.equal(byClick, true); input.value = 'ASIN'; };
  for (const path of ['/erp/listing', '/erp/productExpressionNew', '/erp/mreport/salesStat']) {
    location.pathname = path; input.value = 'MSKU';
    assert.equal((await request('selectSourceAsin')).ok, true);
    assert.equal(input.value, 'ASIN');
  }
});
function harness(pathname, data, columns, rowClassName) {
  const listeners = new Map();
  const messages = [];
  const api = {
    getTableData: () => ({ fullData: data, tableData: data.slice(0, 4) }),
    getTableColumn: () => ({ fullColumn: columns, tableColumn: columns.slice(0, 1) }),
    getRowid: (row) => row.id,
    getRowById: (id) => data.find((row) => row.id === id),
    getCellLabel: (row, column) => column.field.split('.').reduce((value, key) => value?.[key], row),
    rowClassName,
    scrollToRow: async (row) => { api.revealed = row.id; }
  };
  const element = { __vue__: api, getBoundingClientRect: () => ({ width: 100 }), querySelectorAll: (selector) =>
    selector === '.vxe-table--main-wrapper tbody tr' ? (api.visibleIds || []).map((id) => ({ getAttribute: () => id })) : [] };
  const location = { pathname, origin: 'https://example.lingxing.com' };
  const window = { addEventListener: (type, callback) => listeners.set(type, callback), postMessage: (message) => messages.push(message) };
  vm.runInNewContext(source, { window, location, document: { querySelectorAll: () => [element],
    querySelector: () => ({ getAttribute: () => api.mskuView === false ? 'false' : 'true' }) } });
  return {
    api,
    async request(options = {}) {
      await listeners.get('message')({ source: window, origin: location.origin, data: { type: 'LX_FORMAL_LOADED_TABLE_REQUEST', requestId: 'r1', ...options } });
      return messages.at(-1);
    }
  };
}

test('销量已载入业务行补读明确标发在途字段，不混入数组商品或冲突库存，不增加伪字段列', async () => {
  const data = [
    { id: '1', msku: 'A-US', seller_name: 'DEMO-US', seller_info: { afn_inbound_shipped_quantity: 0 } },
    { id: '2', msku: 'B-US', seller_name: 'DEMO-US', afn_inbound_shipped_quantity: 12 },
    { id: '3', msku: 'C-US', seller_name: 'DEMO-US', products: [{ afn_inbound_shipped_quantity: 99 }] },
    { id: '4', msku: 'D-US', seller_name: 'DEMO-US', afn_inbound_shipped_quantity: 1, other: { afn_inbound_shipped_quantity: 2 } }
  ];
  const table = harness('/erp/mreport/salesStat', data, [{ id: 'msku', field: 'msku', title: 'MSKU' }]);
  const result = await table.request();
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.rows, (row) => row.transitQuantity), ['0', '12', undefined, undefined]);
  assert.ok(result.rows.every((row) => !Object.hasOwn(row.fields, '在途数量')));
  assert.equal(result.rows[0].identity.store, 'DEMO-US');
});

test('货件行定位返回目标与实际渲染窗口的业务索引，不按 rowid 字符串排序猜测位置', async () => {
  const data = [{ id: 'row_18' }, { id: 'row_156' }, { id: 'row_24' }];
  const table = harness('/erp/msupply/fbaCargo', data, []);
  table.api.visibleIds = ['row_18', 'row_156'];
  const result = await table.request({ action: 'rowWindow', rowid: 'row_24' });
  assert.equal(result.targetIndex, 2);
  assert.equal(result.firstIndex, 0);
  assert.equal(result.lastIndex, 1);
});

test('货件回访先重算展开后的布局，再定位现有业务行，不重载或改写数据', async () => {
  const data = [{ id: 'footer' }];
  const table = harness('/erp/msupply/fbaCargo', data, []);
  const calls = [];
  table.api.recalculate = async (full) => { assert.equal(full, true); calls.push('layout'); };
  table.api.scrollToRow = async (row) => { assert.equal(row, data[0]); calls.push('locate'); };
  const result = await table.request({ action: 'reveal', rowid: 'footer' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['layout', 'locate']);
});

test('销量搜索词先通过输入组件更新并完成渲染，然后在同一搜索框提交 Enter', async () => {
  const listeners = new Map();
  const messages = [];
  const events = [];
  let value = '';
  let queryValue = 'TEST-Product-Epsilon-US';
  let render = true;
  const component = {
    $emit(type, query) { assert.equal(type, 'input'); value = query; events.push('model'); },
    $nextTick(callback) { if (render) input.value = value; events.push('render'); callback(); }
  };
  const input = { value: '', closest: () => ({ __vue__: component }), focus() { events.push('focus'); },
    dispatchEvent(event) { assert.equal(input.value, queryValue); events.push(event.type); } };
  const mode = { value: 'MSKU' };
  const scope = { getBoundingClientRect: () => ({ width: 800 }), querySelector: (selector) =>
    selector === '.field-select input' ? mode : input };
  const location = { pathname: '/erp/mreport/salesStat', origin: 'https://example.lingxing.com' };
  const window = { addEventListener: (type, callback) => listeners.set(type, callback), postMessage: (message) => messages.push(message) };
  vm.runInNewContext(source, { window, location, KeyboardEvent: class { constructor(type) { this.type = type; } },
    document: { querySelectorAll: (selector) => selector === '.ak-search-wrapper' ? [scope] : [] } });
  const query = async (action = 'querySalesMsku') => {
    await listeners.get('message')({ source: window, origin: location.origin, data: {
      type: 'LX_FORMAL_LOADED_TABLE_REQUEST', requestId: 'query', action, query: queryValue
    } });
    return messages.at(-1);
  };
  assert.equal((await query()).submitted, 'TEST-Product-Epsilon-US');
  assert.deepEqual(events, ['model', 'render', 'focus', 'keydown', 'keypress', 'keyup']);
  input.value = ''; render = false; events.length = 0;
  assert.equal((await query()).ok, false);
  assert.deepEqual(events, ['model', 'render'], '输入未生效时不能发出空搜索');
  location.pathname = '/erp/productExpressionNew'; render = true; events.length = 0;
  assert.equal((await query('queryProductMsku')).submitted, 'TEST-Product-Epsilon-US');
  assert.deepEqual(events, ['model', 'render', 'focus', 'keydown', 'keypress', 'keyup']);
  mode.value = 'SKU'; events.length = 0;
  const wrongMode = await query('queryProductMsku');
  assert.equal(wrongMode.supported, true);
  assert.equal(wrongMode.ok, false, '产品表现切回 SKU 时必须停止，不能用 SKU 发出完整 MSKU 查询');
  assert.equal(events.length, 0);
  queryValue = 'B012345678';
  for (const path of ['/erp/listing', '/erp/productExpressionNew', '/erp/mreport/salesStat']) {
    location.pathname = path; mode.value = 'ASIN'; events.length = 0;
    assert.equal((await query('querySourceAsin')).submitted, queryValue);
    assert.deepEqual(events, ['model', 'render', 'focus', 'keydown', 'keypress', 'keyup']);
    mode.value = 'MSKU'; events.length = 0;
    assert.equal((await query('querySourceAsin')).ok, false, 'ASIN 查询不能在 MSKU 条件下提交');
    assert.equal(events.length, 0);
  }
});

test('Listing 关联所需 ASIN 从完整业务列读取，不取父 ASIN，保留视口外行的身份', async () => {
  for (const path of ['/erp/listing', '/erp/mreport/salesStat', '/erp/productExpressionNew']) {
    const data = [
      { id: 'r1', msku: 'A-US', parent_asin: 'B099999999', detail: { asin: 'B012345678' } },
      { id: 'r2', msku: 'B-US', parent_asin: 'B099999999', detail: { asin: 'B087654321' } }
    ];
    const table = harness(path, data, [
      { id: 'c1', field: 'msku', title: 'MSKU' },
      { id: 'c2', field: 'parent_asin', title: '父ASIN' },
      { id: 'c3', field: 'detail.asin', title: 'ASIN' }
    ]);
    const result = await table.request({ samples: [{ rowid: 'r1', msku: 'A-US', asin: 'B012345678', store: 'DEMO-US', marketplace: '美国' }] });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.rows[0].identity.asin, 'B012345678');
    assert.equal(result.rows[1].identity.asin, 'B087654321');
  }
});

test('ASIN 列展示值非纯 ASIN 时仍使用经过校准的有效业务值，不让展示文字遮挡身份', async () => {
  const data = [
    { id: 'r1', msku: 'A-US', asin: 'B012345678', asinLabel: '查看商品 B012345678' },
    { id: 'r2', msku: 'B-US', asin: 'B087654321', asinLabel: '查看商品 B087654321' }
  ];
  const table = harness('/erp/mreport/salesStat', data, [
    { id: 'c1', field: 'msku', title: 'MSKU' }, { id: 'c2', field: 'asinLabel', title: 'ASIN' }
  ]);
  const result = await table.request({ samples: [{ rowid: 'r1', msku: 'A-US', asin: 'B012345678', store: 'DEMO-US', marketplace: '美国' }] });
  assert.equal(result.rows[0].identity.asin, 'B012345678');
  assert.equal(result.rows[1].identity.asin, 'B087654321');
});

test('销量统计可读取视口外的目标列，并用可见行校准真实 MSKU 和店铺字段', async () => {
  const data = [
    { id: 'r1', merchantCode: 'A-US', context: { shop: 'DEMO-US', country: '美国' }, available: 253, days: 6 },
    { id: 'r2', merchantCode: 'B-US', context: { shop: 'DEMO-US', country: '美国' }, available: 0, days: 0 }
  ];
  const table = harness('/erp/mreport/salesStat', data, [
    { id: 'c1', field: 'merchantCode', title: 'MSKU/售价' },
    { id: 'c2', field: 'available', title: '可用库存' },
    { id: 'c3', field: 'days', title: '可用库存可售天数' }
  ]);
  const result = await table.request({ samples: [{ rowid: 'r1', msku: 'A-US', store: 'DEMO-US', marketplace: '美国' }] });
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[1].identity.store, 'DEMO-US');
  assert.equal(result.rows[0].fields.可用库存可售天数, '6');
  assert.equal(result.rows[1].fields.可用库存可售天数, '0');
});

test('产品表现 MSKU 业务表读取视口外 FBA 可售天数，保留多店铺和零值', async () => {
  const data = [
    { id: 'r1', merchantCode: 'A-EU', context: { shop: 'SAMPLE-DE', country: '德国' }, forecast: 27 },
    { id: 'r2', merchantCode: 'A-EU', context: { shop: 'SAMPLE-FR', country: '法国' }, forecast: 0 }
  ];
  const table = harness('/erp/productExpressionNew', data, [
    { id: 'c1', field: 'info', title: '商品信息' },
    { id: 'c2', field: 'forecast', title: 'FBA可售天数预估' }
  ]);
  const result = await table.request({ samples: [
    { rowid: 'r1', msku: 'A-EU', store: 'SAMPLE-DE', marketplace: '德国' }
  ] });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.rows[0].fields.FBA可售天数预估, '27');
  assert.equal(result.rows[1].fields.FBA可售天数预估, '0');
  assert.equal(result.rows[1].identity.store, 'SAMPLE-FR');
  assert.equal(result.rows[1].identity.marketplace, '法国');
  table.api.mskuView = false;
  assert.equal((await table.request()).ok, false, 'ASIN 汇总不能冒充逐 MSKU 数据');
});

const cargoColumns = [
  { id: 'c1', field: 'merchantCode', title: 'MSKU' },
  { id: 'c2', field: 'quantity.reported', title: '申报量' },
  { id: 'c3', field: 'quantity.signed', title: '签收量' }
];
const cargoClasses = ({ row }) => row.kind === 'parent' ? 'special-row' : row.kind === 'more' ? 'loading-row' : '';
test('货件读取完整的已载入数据，不受只渲染四行的虚拟视口限制', async () => {
  const data = [];
  for (let i = 0; i < 21; i += 1) data.push(
    { id: `parent-${i}`, kind: 'parent', business: { number: `FBA${i}`, shop: 'DEMO-US', state: 'SHIPPED' } },
    { id: `item-${i}`, shipment_id: i + 1000, store: 12, merchantCode: `A${i}-US`, quantity: { reported: 30, signed: 2 } }
  );
  const table = harness('/erp/msupply/fbaCargo', data, cargoColumns, cargoClasses);
  const result = await table.request({ shippedOnly: true, samples: [{ rowid: 'parent-0', kind: 'parent', shipmentId: 'FBA0', store: 'DEMO-US', status: 'SHIPPED' }] });
  assert.equal(result.rows.length, 21);
  assert.equal(result.shipments.length, 21);
  assert.equal(result.rows[20].shipmentId, 'FBA20');
  assert.equal(result.rows[20].store, 'DEMO-US');
  assert.equal(result.unknownRows, 0);
  const afterParentScrollsOut = await table.request({ shippedOnly: true, samples: [] });
  assert.equal(afterParentScrollsOut.rows.length, 21);
  assert.equal(afterParentScrollsOut.rows[20].store, 'DEMO-US');
});

test('视口外的剩余商品占位行会阻止完整快照，并可按行定位展开', async () => {
  const data = [
    { id: 'p1', kind: 'parent', business: { number: 'FBA1', shop: 'DEMO-US' } },
    { id: 'i1', merchantCode: 'A-US', quantity: { reported: 30, signed: 2 } },
    { id: 'more1', kind: 'more' }
  ];
  const table = harness('/erp/msupply/fbaCargo', data, cargoColumns, cargoClasses);
  const samples = [{ rowid: 'p1', kind: 'parent', shipmentId: 'FBA1', store: 'DEMO-US' }];
  const first = await table.request({ shippedOnly: true, samples });
  assert.equal(first.collapsed.length, 1);
  await table.request({ action: 'reveal', rowid: first.collapsed[0].rowid });
  assert.equal(table.api.revealed, 'more1');
  const resolved = await table.request({ shippedOnly: true, samples, resolvedRows: ['more1'] });
  assert.equal(resolved.collapsed.length, 0);
});

test('未知占位行不被当作完整商品数据', async () => {
  const data = [
    { id: 'p1', business: { number: 'FBA1', shop: 'DEMO-US' } },
    { id: 'i1', merchantCode: 'A-US', quantity: { reported: 30, signed: 2 } },
    { id: 'unrecognized-placeholder' }
  ];
  const table = harness('/erp/msupply/fbaCargo', data, cargoColumns);
  const result = await table.request({ shippedOnly: true, samples: [{ rowid: 'p1', kind: 'parent', shipmentId: 'FBA1', store: 'DEMO-US' }] });
  assert.equal(result.unknownRows, 1);
});

test('原生控件已显示收起时登记为展开完成，滚出视口后不再误报待展开', async () => {
  const data = [
    { id: 'p1', kind: 'parent', business: { number: 'FBA1', shop: 'DEMO-US' } },
    { id: 'i1', merchantCode: 'A-US', quantity: { reported: 30, signed: 2 } },
    { id: 'more1', kind: 'more' }
  ];
  const table = harness('/erp/msupply/fbaCargo', data, cargoColumns, cargoClasses);
  const parent = { rowid: 'p1', kind: 'parent', shipmentId: 'FBA1', store: 'DEMO-US' };
  assert.equal((await table.request({ shippedOnly: true, samples: [parent] })).collapsed.length, 1);
  assert.equal((await table.request({ shippedOnly: true, samples: [parent, { rowid: 'more1', kind: 'expanded' }] })).collapsed.length, 0);
  assert.equal((await table.request({ shippedOnly: true, samples: [] })).collapsed.length, 0);
  // 新月份若复用同一行号但换了对象，不能沿用上一月的展开证明。
  data[2] = { id: 'more1', kind: 'more' };
  assert.equal((await table.request({ shippedOnly: true, samples: [parent] })).collapsed.length, 1);
});

test('相同主键和库存值的新响应仍能识别为新一批业务表数据', async () => {
  const data = [{ id: 'r1', msku: 'A-US', days: 6 }];
  const table = harness('/erp/mreport/salesStat', data, [{ id: 'c1', field: 'days', title: '可用库存可售天数' }]);
  const first = await table.request({ action: 'state' });
  const unchanged = await table.request({ action: 'state' });
  assert.equal(unchanged.signature, first.signature);
  data.splice(0, 1, { id: 'r1', msku: 'A-US', days: 6 });
  const refreshed = await table.request({ action: 'state' });
  assert.notEqual(refreshed.signature, first.signature);
});

function dateHarness(pathname, rejectChange = false) {
  const listeners = new Map();
  const messages = [];
  const changes = [];
  const original = ['2026-07-19', '2026-10-19'];
  const component = {
    $options: { name: 'ElDatePicker' }, type: 'daterange', value: [...original], pickerVisible: false,
    userInput: ['2026-10-01', '2026-10-19'],
    isValidValue: () => true,
    emitInput(values) {
      component.value = values.map((date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
    },
    emitChange(values) { changes.push([...values]); if (rejectChange) component.value = [...original]; },
    $nextTick: (callback) => callback()
  };
  const editor = { __vue__: component, getBoundingClientRect: () => ({ width: 200 }) };
  const location = { pathname, origin: 'https://example.lingxing.com' };
  const window = { addEventListener: (type, callback) => listeners.set(type, callback), postMessage: (message) => messages.push(message) };
  vm.runInNewContext(source, { window, location, document: { querySelectorAll: (selector) => selector === '.el-date-editor--daterange' ? [editor] : [] } });
  return {
    component, changes,
    async request(range) {
      await listeners.get('message')({ source: window, origin: location.origin, data: { type: 'LX_FORMAL_LOADED_TABLE_REQUEST', requestId: 'date-1', action: 'setDate', range } });
      return messages.at(-1);
    }
  };
}

test('货件日期整段提交到组件模型，日历保持关闭也能触发一次业务查询', async () => {
  const table = dateHarness('/erp/msupply/fbaCargo');
  const result = await table.request({ start: '2026-10-01', end: '2026-10-19' });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.dateKey, '2026-10-01:2026-10-19');
  assert.deepEqual(table.changes, [['2026-10-01', '2026-10-19']]);
  assert.equal(table.component.userInput, null);
  assert.equal(table.component.pickerVisible, false);
});

test('销量统计使用相同日期提交方式，支持起止同一天', async () => {
  const table = dateHarness('/erp/mreport/salesStat');
  const result = await table.request({ start: '2026-10-18', end: '2026-10-18' });
  assert.equal(result.ok, true);
  assert.deepEqual(table.changes, [['2026-10-18', '2026-10-18']]);
});

test('业务页把日期重置回旧范围时拒绝成功回执', async () => {
  const table = dateHarness('/erp/msupply/fbaCargo', true);
  const result = await table.request({ start: '2026-10-01', end: '2026-10-19' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /业务页修改了日期范围/);
  assert.equal(result.dateKey, '2026-07-19:2026-10-19');
});

test('销量通过原生日历 focus → nextTick → pick → 关闭生命周期提交，而不直接 emitChange', async () => {
  const listeners = new Map();
  const messages = [];
  const sequence = [];
  let changed = false;
  const component = {
    $options: { name: 'ElDatePicker' }, type: 'daterange', value: ['2026-10-10', '2026-10-19'],
    focus() { sequence.push('focus'); this.valueOnOpen = [...this.value]; this.pickerVisible = true; },
    emitInput() { throw new Error('不可跳过原生日历事件'); },
    emitChange() { throw new Error('不可手工替代关闭面板 watcher'); },
    isValidValue: () => true,
    $nextTick(callback) { sequence.push('tick'); callback(); },
    picker: {
      $emit(event, values, visible) {
        sequence.push(event);
        assert.deepEqual(component.valueOnOpen, ['2026-10-10', '2026-10-19']);
        component.value = Array.from(values, (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`);
        component.pickerVisible = visible;
        changed = true;
      }
    }
  };
  const editor = { __vue__: component, getBoundingClientRect: () => ({ width: 200 }) };
  const location = { pathname: '/erp/mreport/salesStat', origin: 'https://example.lingxing.com' };
  const window = { addEventListener: (type, callback) => listeners.set(type, callback), postMessage: (message) => messages.push(message) };
  vm.runInNewContext(source, { window, location, document: { querySelectorAll: () => [editor] } });
  const request = async () => {
    await listeners.get('message')({ source: window, origin: location.origin, data: {
      type: 'LX_FORMAL_LOADED_TABLE_REQUEST', requestId: 'native-date', action: 'pickSalesDate', range: { start: '2026-10-18', end: '2026-10-18' }
    } });
    return messages.at(-1);
  };
  const result = await request();
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.dateKey, '2026-10-18:2026-10-18');
  assert.equal(changed, true);
  assert.deepEqual(sequence, ['focus', 'tick', 'pick', 'tick']);
  await request();
  assert.deepEqual(sequence, ['focus', 'tick', 'pick', 'tick']);
});
