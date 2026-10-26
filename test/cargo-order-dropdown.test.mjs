import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');

test('货件固定列只取 FBA 货件号，不把 STA 标签并入匹配键', () => {
  const start = content.indexOf('  function cargoShipmentId(');
  const end = content.indexOf('\n  async function collectCargoRows(', start);
  assert.ok(start >= 0 && end > start);
  const run = vm.runInNewContext(`${content.slice(start, end)}\ncargoShipmentId`, {
    CSS: { escape: (value) => value },
    clean: (value) => String(value ?? '').trim(),
    rowText: () => 'FBA000000001\nSTA'
  });
  const row = { querySelector: () => ({ querySelector: () => ({ textContent: ' FBA000000001 ' }) }) };
  assert.equal(run(row, 'col_3'), 'FBA000000001');
  assert.equal(run({ querySelector: () => ({ querySelector: () => null }) }, 'col_3'), 'FBA000000001');
});

test('发货单下拉按表头读取日期，并优先物流渠道而非宽泛运输方式', async () => {
  const start = content.indexOf('  async function cargoOrderDates(');
  const end = content.indexOf('\n  function cargoPageCount(', start);
  assert.ok(start >= 0 && end > start);
  const headers = ['发货单号', '状态', '发货量', '发货仓库', '运输方式', '物流商', '物流渠道', '到货时间', '发货时间'];
  const cells = ['SP000000003', '已发货', '100', '示例仓库', '海运', '示例物流', '普船', '2025-03-02', '2025-01-01'];
  const popup = { querySelectorAll: (selector) => (selector === 'thead th' ? headers : cells).map((textContent) => ({ textContent })) };
  const reference = { getAttribute: () => 'el-popover-1', dispatchEvent: () => {} };
  const run = vm.runInNewContext(`${content.slice(start, end)}\ncargoOrderDates`, {
    clean: (value) => String(value ?? '').trim(),
    document: { getElementById: () => popup },
    MouseEvent: class { constructor(type) { this.type = type; } },
    setTimeout
  });
  const result = await run({ querySelector: () => reference });
  assert.equal(result.shippedAt, '2025-01-01');
  assert.equal(result.arrivalAt, '2025-03-02');
  assert.equal(result.shippingMethod, '普船');
  assert.equal(result.orderNumber, 'SP000000003');
});

test('发货单 aria-describedby 和表格异步出现时，等待真实数据再读且始终关闭悬停', async () => {
  const start = content.indexOf('  async function cargoOrderDates(');
  const end = content.indexOf('\n  function cargoPageCount(', start);
  let now = 1000;
  const events = [];
  const popup = { querySelectorAll(selector) {
    const text = selector === 'thead th' ? ['发货单号', '发货时间', '到货时间', '物流渠道']
      : now < 1400 ? [] : ['SP000000004', '2026-09-24', '2026-11-13', '普船'];
    return text.map((textContent) => ({ textContent }));
  } };
  const reference = {
    getAttribute: () => now < 1200 ? null : 'async-popup',
    dispatchEvent: (event) => events.push(event.type)
  };
  const run = vm.runInNewContext(`${content.slice(start, end)}\ncargoOrderDates`, {
    clean: (value) => String(value ?? '').trim(), document: { getElementById: () => popup },
    MouseEvent: class { constructor(type) { this.type = type; } }, Date: { now: () => now },
    setTimeout: (callback, delay) => { now += delay; callback(); }
  });
  const result = await run({ querySelector: () => reference });
  assert.equal(result.orderNumber, 'SP000000004');
  assert.equal(result.arrivalAt, '2026-11-13');
  assert.equal(events.at(-1), 'mouseleave');
});

test('发货单逐票上报进度，核齐目标票数立即停止而不再空滚 45 秒', async () => {
  const start = content.indexOf('  async function collectCargoRows(');
  const end = content.indexOf('\n  async function cargoOrderDates(', start);
  let reads = 0;
  const stages = [];
  const wrapper = { scrollTop: 0, clientHeight: 500, scrollHeight: 100000 };
  const run = vm.runInNewContext(`${content.slice(start, end)}\ncollectCargoRows`, {
    document: { querySelector: () => wrapper }, setTimeout: (callback) => callback(), Date
  });
  const rows = await run(() => { reads += 1; return [{ shipmentId: 'FBA1' }, { shipmentId: 'FBA2' }]; },
    async () => ({ arrivalAt: '2026-11-13' }),
    { wantedShipments: new Set(['FBA1', 'FBA2']), report: async (stage) => stages.push(stage), maxMs: 45000 });
  assert.equal(rows.length, 2);
  assert.equal(reads, 1);
  assert.equal(wrapper.scrollTop, 0);
  assert.match(stages[0], /1\/2.*FBA1/);
  assert.match(stages[1], /2\/2.*FBA2/);
});
