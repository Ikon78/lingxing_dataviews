import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
const start = content.indexOf('  async function setSourceDateRange(');
const end = content.indexOf('\n  function masterReportDateRange(', start);
assert.ok(start >= 0 && end > start, '无法定位货件日期控件操作');
const setDateSource = `${content.slice(start, end)}\nsetSourceDateRange`;

test('后台页等待异步选中起始日，再点击较早窗口的结束日', async () => {
  let currentRange = { start: '2026-07-16', end: '2026-10-16' };
  let leftMonth = 6;
  let rightMonth = 9;
  let pickerVisible = false;
  let editorClicks = 0;
  let pickedStart = '';
  const observers = new Set();
  const changed = () => { for (const observer of [...observers]) observer.callback(); };
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const year = 2026;
  const header = (side) => ({
    get textContent() { return `${year} 年 ${(side === 'left' ? leftMonth : rightMonth) + 1} 月`; },
    querySelector(selector) {
      return {
        disabled: false,
        click() {
          if (side === 'left') leftMonth += selector.includes('arrow-left') ? -1 : 1;
          else rightMonth += selector.includes('arrow-left') ? -1 : 1;
          changed();
        }
      };
    }
  });
  const panel = {
    visible: true,
    querySelector(selector) {
      if (selector.includes('is-left') && selector.includes('__header')) return header('left');
      if (selector.includes('is-right') && selector.includes('__header')) return header('right');
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes('td.start-date')) {
        const side = selector.includes('is-left') ? 'left' : 'right';
        const month = (side === 'left' ? leftMonth : rightMonth) + 1;
        return pickedStart && Number(pickedStart.slice(5, 7)) === month
          ? [{ querySelector: () => ({ textContent: String(Number(pickedStart.slice(8))) }) }]
          : [];
      }
      const side = selector.includes('is-left') ? 'left' : 'right';
      return Array.from({ length: 31 }, (_, index) => ({
        matches: () => false,
        querySelector: () => ({ textContent: String(index + 1) }),
        click() {
          const month = (side === 'left' ? leftMonth : rightMonth) + 1;
          const date = `${year}-${String(month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`;
          if (!pickedStart) setTimeout(() => { pickedStart = date; changed(); }, 5);
          else { currentRange = { start: pickedStart, end: date }; pickerVisible = false; }
          changed();
        }
      }));
    }
  };
  const editor = { visible: true, click() { editorClicks += 1; pickerVisible = true; changed(); } };
  const context = {
    document: {
      documentElement: {},
      querySelectorAll(selector) {
        if (selector === '.el-date-editor--daterange') return [editor];
        if (selector === '.el-picker-panel.el-date-range-picker') return pickerVisible ? [panel] : [];
        return [];
      }
    },
    MutationObserver: FakeMutationObserver,
    isRendered: (node) => node.visible,
    clean: (value) => String(value || '').replace(/\s+/g, ' ').trim(),
    dateRangeKey: (range) => `${range?.start}:${range?.end}`,
    pageDateRange: () => currentRange,
    setTimeout,
    clearTimeout
  };
  const setDate = vm.runInNewContext(setDateSource, context);
  assert.equal(await setDate({ start: '2026-04-16', end: '2026-07-15' }), true);
  assert.deepEqual(currentRange, { start: '2026-04-16', end: '2026-07-15' });
  assert.equal(leftMonth, 6);
  assert.equal(observers.size, 0);
  assert.equal(editorClicks, 1);
  // 输入框提交失败后面板可能已经打开；再次点击会把它关闭。
  pickerVisible = true;
  pickedStart = '';
  assert.equal(await setDate({ start: '2026-03-16', end: '2026-04-15' }), true);
  assert.equal(editorClicks, 1);
  assert.deepEqual(currentRange, { start: '2026-03-16', end: '2026-04-15' });
});

test('整段日期提交成功但抓包计数未增加时，不再误报日历未打开', async () => {
  let currentRange = { start: '2026-07-16', end: '2026-10-16' };
  let calendarClicks = 0;
  const cargoNetworkCapture = { diagnostic: { businessResponses: 0 } };
  const observers = new Set();
  const changed = () => { for (const observer of [...observers]) observer.callback(); };
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  class FakeInput {
    get value() { return this._value || ''; }
    set value(value) { this._value = value; }
    focus() {}
    blur() {}
    dispatchEvent(event) {
      if (event.type === 'keydown' && event.key === 'Enter') {
        currentRange = { start: inputs[0].value, end: inputs[1].value };
        changed();
      }
    }
  }
  const inputs = [new FakeInput(), new FakeInput()];
  const editor = { visible: true, querySelectorAll: () => inputs, click() { calendarClicks += 1; } };
  const context = {
    document: { documentElement: {}, querySelectorAll: (selector) => selector === '.el-date-editor--daterange' ? [editor] : [] },
    location: { pathname: '/erp/msupply/fbaCargo' },
    cargoNetworkCapture,
    HTMLInputElement: FakeInput,
    Event: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type, options) { this.type = type; this.key = options.key; } },
    MutationObserver: FakeMutationObserver,
    isRendered: (node) => node.visible,
    clean: (value) => String(value || '').trim(),
    dateRangeKey: (range) => `${range?.start}:${range?.end}`,
    pageDateRange: () => currentRange,
    setTimeout,
    clearTimeout
  };
  const setDate = vm.runInNewContext(setDateSource, context);
  assert.equal(await setDate({ start: '2026-04-16', end: '2026-07-15' }), true);
  assert.deepEqual(currentRange, { start: '2026-04-16', end: '2026-07-15' });
  assert.equal(calendarClicks, 0);
  assert.equal(cargoNetworkCapture.diagnostic.businessResponses, 0);
  assert.equal(observers.size, 0);
  currentRange = { start: '2026-10-10', end: '2026-10-19' };
  context.location.pathname = '/erp/mreport/salesStat';
  assert.equal(await setDate({ start: '2026-10-18', end: '2026-10-18' }), true);
  assert.deepEqual(currentRange, { start: '2026-10-18', end: '2026-10-18' });
  assert.equal(calendarClicks, 0);
});

const settleStart = content.indexOf('  async function waitLoadedTableSettled(');
const settleEnd = content.indexOf('\n  async function captureCurrentPage(', settleStart);
assert.ok(settleStart >= 0 && settleEnd > settleStart);
const settleSource = `${content.slice(settleStart, settleEnd)}\nwaitLoadedTableSettled`;

test('业务表接口不可用时仍须等待 DOM 数据变化，不能把日期文字更新当成报表成功', async () => {
  let now = 1000;
  const context = {
    Date: { now: () => now }, sourceIsLoading: () => false,
    currentTableText: () => '旧表 A-US 库存 253',
    setTimeout: (callback, delay) => { now += delay; callback(); }
  };
  const wait = vm.runInNewContext(settleSource, context);
  assert.equal(await wait({ ok: false, domSignature: '旧表 A-US 库存 253' }, true, 900), false);
});

test('日期条件与表格返回分别校验，新数据稳定后才继续读取', async () => {
  let now = 1000;
  const context = {
    Date: { now: () => now }, sourceIsLoading: () => false,
    currentTableText: () => now >= 1300 ? '新表 A-US 库存 200' : '旧表 A-US 库存 253',
    setTimeout: (callback, delay) => { now += delay; callback(); }
  };
  const wait = vm.runInNewContext(settleSource, context);
  assert.equal(await wait({ ok: false, domSignature: '旧表 A-US 库存 253' }, true, 3000), true);
  assert.ok(now >= 1700);
});
