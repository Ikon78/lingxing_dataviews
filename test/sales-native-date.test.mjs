import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const content = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const start = content.indexOf('  async function setSalesDateRange(');
const source = content.slice(start, content.indexOf('  async function setSourceDateRange(', start));

function fixture({ alreadyOpen = false, original = { start: '2026-10-10', end: '2026-10-19' } } = {}) {
  let range = original;
  let leftMonth = 2026 * 12 + 9;
  let panelVisible = alreadyOpen;
  let selectedStart = '';
  let inputClicks = 0;
  let dateClicks = [];
  let pending = false;
  const observers = new Set();
  const changed = () => { for (const observer of [...observers]) observer.callback(); };
  class Observer {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  const month = (side) => leftMonth + (side === 'right' ? 1 : 0);
  const dateString = (side, day) => `${Math.floor(month(side) / 12)}-${String(month(side) % 12 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const panel = {
    visible: true,
    querySelector(selector) {
      const side = selector.includes('is-left') ? 'left' : 'right';
      return {
        get textContent() { return `${Math.floor(month(side) / 12)} 年 ${month(side) % 12 + 1} 月`; },
        querySelector(buttonSelector) {
          return {
            disabled: false,
            click() {
              setTimeout(() => { leftMonth += buttonSelector.includes('arrow-left') ? -1 : 1; changed(); }, 75);
            }
          };
        }
      };
    },
    querySelectorAll(selector) {
      const side = selector.includes('is-left') ? 'left' : 'right';
      if (selector.includes('td.start-date')) return selectedStart && selectedStart.slice(0, 7) === dateString(side, 1).slice(0, 7)
        ? [{ querySelector: () => ({ textContent: selectedStart.slice(8) }) }] : [];
      return Array.from({ length: 31 }, (_, index) => {
        const day = index + 1;
        const digit = {
          textContent: String(day),
          click() {
            if (pending) throw new Error('日期状态更新前不能连续点旧节点');
            const date = dateString(side, day);
            dateClicks.push(date);
            pending = true;
            setTimeout(() => {
              if (!selectedStart) selectedStart = date;
              else { range = { start: selectedStart, end: date }; selectedStart = ''; panelVisible = false; }
              pending = false;
              changed();
            }, 150);
          }
        };
        return { matches: () => false, querySelector: () => digit, click() { throw new Error('应点击日期数字而不是空白 td'); } };
      });
    }
  };
  const input = { focus() {}, click() { inputClicks += 1; panelVisible = true; changed(); } };
  const editor = { visible: true, querySelector: () => input, click() { throw new Error('只读日期外壳不负责聚焦输入'); } };
  const setDate = vm.runInNewContext(`${source}\nsetSalesDateRange`, {
    document: { documentElement: {}, querySelectorAll: (selector) => selector === '.el-date-editor--daterange' ? [editor] : panelVisible ? [panel] : [] },
    MutationObserver: Observer, setTimeout, clearTimeout,
    isRendered: (node) => node.visible,
    clean: (value) => String(value ?? '').replace(/\s+/g, ' ').trim(),
    dateRangeKey: (value) => value?.start && value?.end ? `${value.start}:${value.end}` : '',
    pageDateRange: () => range
  });
  return { setDate, range: () => range, clicks: () => inputClicks, dateClicks: () => dateClicks, observers };
}

test('只读销量日期通过实际输入打开日历，等待异步首选状态后再选同一天', async () => {
  const f = fixture();
  const target = { start: '2026-10-18', end: '2026-10-18' };
  assert.equal(await f.setDate(target), true);
  assert.deepEqual(f.range(), target);
  assert.deepEqual(f.dateClicks(), ['2026-10-18', '2026-10-18']);
  assert.equal(f.clicks(), 1);
  assert.equal(f.observers.size, 0);
});

test('已打开日历不被再次关闭；翻月等待真实月份变化且跨月范围正确提交', async () => {
  const f = fixture({ alreadyOpen: true });
  const target = { start: '2026-09-30', end: '2026-10-02' };
  assert.equal(await f.setDate(target), true);
  assert.deepEqual(f.range(), target);
  assert.equal(f.clicks(), 0);
  assert.equal(f.observers.size, 0);
});

test('日期已正确时不重复打开日历或触发查询', async () => {
  const target = { start: '2026-10-18', end: '2026-10-18' };
  const f = fixture({ original: target });
  assert.equal(await f.setDate(target), true);
  assert.equal(f.clicks(), 0);
  assert.deepEqual(f.dateClicks(), []);
});

test('日历自身 pick 接口可用时不依赖后台弹层是否可见', async () => {
  let range = { start: '2026-10-10', end: '2026-10-19' };
  const requests = [];
  const setDate = vm.runInNewContext(`${source}\nsetSalesDateRange`, {
    dateRangeKey: (value) => `${value.start}:${value.end}`,
    pageDateRange: () => range,
    document: { querySelectorAll() { throw new Error('无需访问模拟点击弹层'); } },
    readLoadedTable: async (request) => {
      requests.push(request.action);
      range = request.range;
      return { ok: true, supported: true, dateKey: `${range.start}:${range.end}` };
    }
  });
  assert.equal(await setDate({ start: '2026-10-18', end: '2026-10-18' }), true);
  assert.deepEqual(requests, ['pickSalesDate']);
});
