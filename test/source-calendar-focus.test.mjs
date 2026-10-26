import test from 'node:test';
import assert from 'node:assert/strict';

test('日历前台回退仅接受本批销量页；结束时仅在来源仍活动时恢复主表', async () => {
  let onMessage;
  let nextId = 100;
  let activeId = 1;
  const tabs = new Map();
  const updates = [];
  globalThis.chrome = {
    runtime: { getManifest: () => ({ version: '1.4.66' }), onInstalled: { addListener() {} }, onMessage: { addListener(fn) { onMessage = fn; } } },
    storage: { local: { async get() { return {}; } } },
    tabs: {
      async query() { return []; },
      async create(options) { const tab = { id: ++nextId, ...options }; tabs.set(tab.id, tab); return tab; },
      async get(id) { return { ...tabs.get(id), active: id === activeId }; },
      async update(id, options) { updates.push(id); if (options.active) activeId = id; return { ...tabs.get(id), active: id === activeId }; },
      async sendMessage(_id, message) {
        return message.type === 'LX_FORMAL_RUNTIME' ? { ok: true, version: '1.4.66', route: 'sales' } : { ok: true };
      },
      async remove() {}
    }
  };
  await import(`../background.js?calendar-focus-test=${Date.now()}`);
  const master = { tab: { id: 1, url: 'https://example.lingxing.com/erp/productExpressionNew' } };
  const request = (message, sender = master) => new Promise((resolve) => onMessage(message, sender, resolve));
  const start = () => request({ type: 'LX_FORMAL_BACKFILL_SOURCE', sourceKind: 'sales', mskus: ['A-US'], dateRange: { start: '2026-10-18', end: '2026-10-18' } });
  const first = await start();
  const sender = { tab: tabs.get(nextId) };
  assert.equal((await request({ type: 'LX_FORMAL_SOURCE_FOCUS', requestId: first.requestId })).ok, false);
  assert.deepEqual(updates, []);
  assert.equal((await request({ type: 'LX_FORMAL_SOURCE_FOCUS', requestId: first.requestId }, sender)).ok, true);
  await request({ type: 'LX_FORMAL_SOURCE_RESULT', result: { requestId: first.requestId, ok: false, error: 'test' } }, sender);
  assert.deepEqual(updates, [sender.tab.id, 1]);
  const second = await start();
  const secondSender = { tab: tabs.get(nextId) };
  await request({ type: 'LX_FORMAL_SOURCE_FOCUS', requestId: second.requestId }, secondSender);
  activeId = 777; // 用户自行切换到其他标签后，不应抢回主表。
  await request({ type: 'LX_FORMAL_SOURCE_RESULT', result: { requestId: second.requestId, ok: true } }, secondSender);
  assert.deepEqual(updates, [sender.tab.id, 1, secondSender.tab.id]);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  delete globalThis.chrome;
});
