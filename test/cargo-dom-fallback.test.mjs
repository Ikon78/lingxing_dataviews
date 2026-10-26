import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
const start = content.indexOf('  function cargoTableSignature(');
const end = content.indexOf('\n  function cargoSearchControls(', start);
assert.ok(start >= 0 && end > start, '无法定位货件产品页面兜底函数');
const functionSource = content.slice(start, end);

function setup({ requireVisibleClick = false, jumpPastIntermediate = false, delayedUntilRescan = false, legacy = false } = {}) {
  const wrapper = { clientHeight: 100, scrollHeight: jumpPastIntermediate ? 400 : 200 };
  let scrollTop = 0;
  let rescans = 0;
  Object.defineProperty(wrapper, 'scrollTop', {
    get() { return scrollTop; },
    set(value) { if (value === 0 && scrollTop > 0) rescans += 1; scrollTop = value; }
  });
  let expanded = false;
  let scrolledToControl = false;
  const expandRow = {
    isConnected: false,
    textContent: '展开剩余 1 个商品',
    scrollIntoView() { scrolledToControl = true; if (jumpPastIntermediate) wrapper.scrollTop = 250; },
    querySelector() { return { click() { if (!requireVisibleClick || scrolledToControl) expanded = true; } }; }
  };
  const scan = vm.runInNewContext(`${functionSource}\n${legacy ? 'collectCargoLegacyProductPage' : 'collectCargoProductPage'}`, {
    document: { querySelector: () => wrapper },
    setTimeout: (callback) => callback(),
    clearTimeout: () => {},
    clean: (value) => String(value || '').trim(),
    normalizeMsku: (value) => String(value || '').toUpperCase(),
    cargoProductRows(_state, observed) {
      if (wrapper.scrollTop === 0) {
        observed.shipments.add('FBA1');
        if (delayedUntilRescan && rescans) observed.shipments.add('FBA3');
        if (!expanded) observed.collapsed.push({ shipmentId: 'FBA1', row: expandRow });
        return [{ shipmentId: 'FBA1', msku: 'SKU-1', store: 'DEMO-US', declared: '2', received: '0' },
          ...(delayedUntilRescan && rescans ? [{ shipmentId: 'FBA3', msku: 'SKU-4', store: 'DEMO-US', declared: '1', received: '0' }] : []),
          ...(expanded ? [{ shipmentId: 'FBA1', msku: 'SKU-2', store: 'DEMO-US', declared: '3', received: '0' }] : [])];
      }
      const shipmentId = jumpPastIntermediate && wrapper.scrollTop >= 200 ? 'FBA3' : 'FBA2';
      observed.shipments.add(shipmentId);
      if (jumpPastIntermediate && !expanded && wrapper.scrollTop >= 200) observed.collapsed.push({ shipmentId: 'FBA1', row: expandRow });
      return [{ shipmentId, msku: 'SKU-3', store: 'DEMO-US', declared: '4', received: '0' }];
    }
  });
  return { scan, isExpanded: () => expanded, wasScrolledToControl: () => scrolledToControl };
}

test('网络包未解析时展开 SHIPPED 剩余商品并读到分页底部', async () => {
  const { scan, isExpanded } = setup();
  const result = await scan(2, async () => {});
  assert.equal(isExpanded(), true);
  assert.equal(result.shipmentCount, 2);
  assert.deepEqual(Array.from(result.rows, (row) => row.msku), ['SKU-1', 'SKU-2', 'SKU-3']);
});

test('恢复的 v1.4.54 主路径先把控件滚入视口、展开后继续核对整页', async () => {
  const { scan, isExpanded, wasScrolledToControl } = setup({ legacy: true, requireVisibleClick: true });
  const result = await scan(2, async () => {});
  assert.equal(isExpanded(), true);
  assert.equal(wasScrolledToControl(), true);
  assert.equal(result.shipmentCount, 2);
  assert.deepEqual(Array.from(result.rows, (row) => row.msku), ['SKU-1', 'SKU-2', 'SKU-3']);
});

test('先把预渲染的展开控件滚入视口，再读取剩余商品', async () => {
  const { scan, isExpanded, wasScrolledToControl } = setup({ requireVisibleClick: true });
  const result = await scan(2, async () => {});
  assert.equal(wasScrolledToControl(), true);
  assert.equal(isExpanded(), true);
  assert.equal(result.rows.length, 3);
});

test('展开控件跳过中间货件后返回断点继续扫描', async () => {
  const { scan } = setup({ jumpPastIntermediate: true });
  const result = await scan(3, async () => {});
  assert.equal(result.shipmentCount, 3);
  assert.deepEqual(Array.from(new Set(result.rows.map((row) => row.shipmentId))).sort(), ['FBA1', 'FBA2', 'FBA3']);
});

test('首次滚到底仍缺票时从顶部复扫并补齐', async () => {
  const progress = [];
  const { scan } = setup({ delayedUntilRescan: true });
  const result = await scan(3, async (stage) => progress.push(stage));
  assert.equal(result.shipmentCount, 3);
  assert.ok(progress.some((stage) => stage.includes('密集复扫')));
});

test('页面货件票数不足时拒绝缓存不完整快照', async () => {
  const { scan } = setup();
  await assert.rejects(scan(3, async () => {}), /仅核对 2\/3 票/);
});

function longPage({ frozen = false, jumpGap = false } = {}) {
  let now = 1000;
  let top = 0;
  let first = 0;
  let reads = 0;
  const totalRows = 361;
  const rowHeight = 48;
  const wrapper = {
    isConnected: true, clientHeight: 542, scrollHeight: totalRows * rowHeight,
    get scrollTop() { return top; },
    set scrollTop(value) {
      const previous = top;
      top = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value));
      if (!frozen) first = Math.min(totalRows - 16, Math.max(0, Math.floor(top / rowHeight) - 2 + (jumpGap && top - previous >= 600 ? 20 : 0)));
    },
    getBoundingClientRect: () => ({ top: 212 }),
    querySelectorAll() {
      return Array.from({ length: Math.min(16, totalRows - first) }, (_, offset) => {
        const index = first + offset;
        return {
          index,
          getAttribute: () => `row_${index}`,
          getBoundingClientRect: () => ({ top: 212 + index * rowHeight - top, bottom: 212 + (index + 1) * rowHeight - top })
        };
      });
    }
  };
  const scan = vm.runInNewContext(`${functionSource}\ncollectCargoLegacyProductPage`, {
    document: { querySelector: () => wrapper },
    Date: { now: () => now },
    setTimeout(callback, delay) { now += Math.max(delay, 1000); callback(); },
    clearTimeout() {},
    clean: (value) => String(value || '').trim(), normalizeMsku: (value) => value,
    cargoProductRows(_state, observed) {
      // 模拟繁重业务 DOM 读取和后台时钟限速，不能假定每步只消耗几毫秒。
      now += 3000;
      reads += 1;
      return wrapper.querySelectorAll().map(({ index }) => {
        const shipmentId = `FBA${Math.floor(index / 20)}`;
        observed.shipments.add(shipmentId);
        return { shipmentId, msku: `SKU-${index}`, store: 'DEMO-US', declared: '1', received: '0' };
      });
    }
  });
  return { scan, elapsed: () => now - 1000, reads: () => reads, wrapper };
}

test('一万七千像素长表按已读窗口推进，保留重叠且不遗漏中间商品', async () => {
  const f = longPage();
  const result = await f.scan(19, async () => {});
  assert.equal(result.shipmentCount, 19);
  assert.equal(result.rows.length, 361);
  assert.ok(f.reads() < 40, `无需旧版逐小步扫描，实际 ${f.reads()} 次`);
  assert.ok(f.elapsed() < 150000);
  assert.equal(f.wrapper.scrollTop + f.wrapper.clientHeight, f.wrapper.scrollHeight);
});

test('虚拟表不再换入新行时按无数据进展中止，而不是不断滚动假装有进度', async () => {
  const f = longPage({ frozen: true });
  await assert.rejects(f.scan(19, async () => {}), /30 秒未出现新数据/);
  assert.ok(f.elapsed() < 60000);
});

test('变高行使虚拟窗口跳过重叠区时退半步重读，不以票数齐全掩盖商品遗漏', async () => {
  const f = longPage({ jumpGap: true });
  const result = await f.scan(19, async () => {});
  assert.equal(result.shipmentCount, 19);
  assert.equal(result.rows.length, 361);
});

test('已读预渲染区覆盖目标视口时无需等待不会发生的 DOM 替换', async () => {
  const f = longPage();
  let timerCalls = 0;
  const context = {
    setTimeout() { timerCalls += 1; }, clearTimeout() {}
  };
  const wait = vm.runInNewContext(`${functionSource}\nwaitCargoTableRender`, context);
  await wait(f.wrapper, `16|row_0|row_15|${f.wrapper.scrollHeight}`, 500, true);
  assert.equal(timerCalls, 0);
});

test('整页业务数据核齐时直接读取全部商品，不要求再逐像素滚到底', async () => {
  const rows = Array.from({ length: 19 }, (_, index) => ({ shipmentId: `FBA${index}`, msku: `SKU-${index}`, store: 'DEMO-US', status: 'SHIPPED', declared: '4', received: '0' }));
  const wrapper = { scrollTop: 0, scrollHeight: 17000, clientHeight: 542, querySelectorAll: () => [] };
  const scan = vm.runInNewContext(`${functionSource}\ncollectCargoLegacyProductPage`, {
    cargoNetworkCapture: null,
    document: { querySelector: () => wrapper },
    cargoProductRows: () => [],
    normalizeMsku: (value) => value,
    readLoadedTable: async () => ({ ok: true, shipments: rows.map((row) => row.shipmentId), rows, collapsed: [], unknownRows: 0 })
  });
  const result = await scan(19, async () => {});
  assert.equal(result.rows.length, 19);
  assert.equal(wrapper.scrollTop, 0);
});

test('全部票数已出现但还有待展开行时，业务数据不得误报完整', async () => {
  const rows = [{ shipmentId: 'FBA1', msku: 'SKU-1', store: 'DEMO-US', status: 'SHIPPED', declared: '4', received: '0' }];
  const coverage = vm.runInNewContext(`${functionSource}\nreadCargoLoadedCoverage`, {
    cargoNetworkCapture: null,
    readLoadedTable: async () => ({ ok: true, shipments: ['FBA1'], rows, collapsed: [{ rowid: 'more1' }], unknownRows: 0 })
  });
  assert.equal((await coverage(1)).complete, false);
});

test('展开后末尾控件移出虚拟视口时按业务行回访，看到点击收起才完成快照', async () => {
  const rows = [{ shipmentId: 'FBA1', msku: 'SKU-1', store: 'DEMO-US', status: 'SHIPPED', declared: '4', received: '0' }];
  const wrapper = { scrollTop: 0, scrollHeight: 100, clientHeight: 100, querySelectorAll: () => [] };
  let revealed = false;
  let reveals = 0;
  const footer = { id: 'more1', textContent: '点击收起', querySelector: () => ({ click() { throw new Error('已展开的控件不能再点击收起'); } }) };
  const progress = [];
  const scan = vm.runInNewContext(`${functionSource}\ncollectCargoLegacyProductPage`, {
    cargoNetworkCapture: null, normalizeMsku: (value) => value, tableRowKey: (row) => row.id,
    setTimeout: (callback) => { callback(); return 1; }, clearTimeout() {},
    clean: (value) => String(value || '').trim(),
    document: { querySelector: () => wrapper, querySelectorAll: () => revealed ? [footer] : [] },
    cargoProductRows(_state, observed) { observed.shipments.add('FBA1'); return rows; },
    readLoadedTable: async (options = {}) => {
      if (options.action === 'reveal') { revealed = true; reveals += 1; return { ok: true }; }
      return { ok: true, shipments: ['FBA1'], rows, unknownRows: 0,
        collapsed: options.resolvedRows?.includes('more1') ? [] : [{ rowid: 'more1', shipmentId: 'FBA1' }] };
    }
  });
  const result = await scan(1, async (stage) => progress.push(stage));
  assert.equal(result.rows.length, 1);
  assert.equal(reveals, 1);
  assert.ok(progress.some((stage) => stage.includes('逐票回访末尾控件')));
});

test('回访控件不是明确的展开或收起状态时不能登记为完成，缺少数量也不能通过', async () => {
  let controlText = '正在载入商品';
  const rows = [{ shipmentId: 'FBA1', msku: 'SKU-1', store: 'DEMO-US', status: 'SHIPPED', declared: '4', received: '0' }];
  let unknown = true;
  const footer = { id: 'more1', get textContent() { return controlText; }, querySelector: () => ({ click() {} }) };
  const finish = vm.runInNewContext(`${functionSource}\ncollectCargoLoadedPage`, {
    cargoNetworkCapture: null, tableRowKey: (row) => row.id, clean: (value) => String(value || '').trim(),
    setTimeout: (callback) => { callback(); return 1; }, clearTimeout() {},
    document: { querySelector: () => ({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 }), querySelectorAll: () => [footer] },
    readLoadedTable: async (options = {}) => options.action === 'reveal' ? { ok: true }
      : { ok: true, shipments: ['FBA1'], rows, unknownRows: 0, collapsed: unknown && !options.resolvedRows?.includes('more1') ? [{ rowid: 'more1' }] : [] }
  });
  assert.equal(await finish(1, async () => {}), null);
  unknown = false;
  rows[0].declared = '';
  assert.equal(await finish(1, async () => {}), null);
});

test('scrollToRow 估算位置错误时用真实渲染业务索引回访，不能只重复同一个错误位置', async () => {
  const target = { id: 'target', querySelector: () => ({}) };
  let top = 0;
  const wrapper = { scrollHeight: 1100, clientHeight: 100, querySelectorAll: () => [] };
  Object.defineProperty(wrapper, 'scrollTop', { get: () => top, set(value) { top = value; } });
  const windows = [];
  const reveal = vm.runInNewContext(`${functionSource}\nrevealCargoControl`, {
    document: { querySelector: () => wrapper, querySelectorAll: () => top >= 480 && top <= 560 ? [target] : [] },
    tableRowKey: (row) => row.id,
    setTimeout: (callback) => { callback(); return 1; }, clearTimeout() {},
    readLoadedTable: async ({ action }) => {
      if (action === 'reveal') { top = 900; return { ok: true }; }
      windows.push(top);
      return { ok: true, targetIndex: 50, firstIndex: Math.floor(top / 10), lastIndex: Math.floor(top / 10) + 5 };
    }
  });
  const result = await reveal({ rowid: 'target', shipmentId: 'FBA1' }, Date.now() + 5000);
  assert.equal(result.row, target);
  assert.ok(windows.length >= 2);
  assert.ok(top < 900);
});

test('回访期间滚动高度增长时重建二分范围，不让旧上界截掉末尾控件', async () => {
  const target = { id: 'footer', querySelector: () => ({}) };
  const wrapper = { scrollTop: 900, scrollHeight: 1100, clientHeight: 100, querySelectorAll: () => [] };
  let reads = 0;
  const reveal = vm.runInNewContext(`${functionSource}\nrevealCargoControl`, {
    document: { querySelector: () => wrapper, querySelectorAll: () => wrapper.scrollTop >= 1450 && wrapper.scrollTop <= 1600 ? [target] : [] },
    tableRowKey: (row) => row.id,
    setTimeout: (callback) => { callback(); return 1; }, clearTimeout() {},
    readLoadedTable: async ({ action }) => {
      if (action === 'reveal') return { ok: true };
      if (++reads >= 2) wrapper.scrollHeight = 2100;
      return { ok: true, targetIndex: 150, firstIndex: Math.floor(wrapper.scrollTop / 10), lastIndex: Math.floor(wrapper.scrollTop / 10) + 5 };
    }
  });
  const result = await reveal({ rowid: 'footer', shipmentId: 'FBA1' }, Date.now() + 5000);
  assert.equal(result.row, target);
  assert.ok(wrapper.scrollTop > 1000);
});
