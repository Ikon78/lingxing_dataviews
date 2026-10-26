import test from 'node:test';
import assert from 'node:assert/strict';

test('货件整表仅抓一次，按 MSKU 和店铺分发；会话重启后清除旧快照', async () => {
  let onMessage;
  let onStartup;
  const session = {};
  const created = [];
  const delivered = [];
  const updates = [];
  const activeTabs = new Set();
  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener(listener) { onStartup = listener; } },
      onMessage: { addListener(listener) { onMessage = listener; } }
    },
    storage: {
      local: { async setAccessLevel() {} },
      session: {
        async get(key) { return { [key]: session[key] }; },
        async set(values) { Object.assign(session, structuredClone(values)); },
        async remove(key) { delete session[key]; }
      }
    },
    tabs: {
      async create(options) { const tab = { id: 90 + created.length, url: options.url }; created.push(tab); return tab; },
      async update(tabId, options) { updates.push(tabId); if (options.active) { activeTabs.clear(); activeTabs.add(tabId); } return { id: tabId, active: activeTabs.has(tabId) }; },
      async get(tabId) { return { id: tabId, active: activeTabs.has(tabId) }; },
      async sendMessage(tabId, message) {
        delivered.push({ tabId, message });
        if (message.type === 'LX_FORMAL_RUNTIME') return { ok: true, route: 'page@%2Ferp%2Fmsupply%2FfbaCargo' };
        if (message.type === 'LX_FORMAL_RUN_CARGO_SNAPSHOT') return { ok: true };
        return { ok: true };
      },
      async remove() {}
    }
  };
  await import('../background.js?cargo-snapshot-test');
  const requester = (id) => ({ tab: { id, url: 'https://example.lingxing.com/erp/productExpressionNew', windowId: 1 } });
  const source = () => ({ tab: { id: created[0].id, url: created[0].url } });
  const send = (message, sender) => new Promise((resolve) => onMessage(message, sender, resolve));
  const first = await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_QUERY', identity: { msku: 'TEST-One-US', store: 'DEMO-US' } }, requester(1));
  const second = await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_QUERY', identity: { msku: 'TEST-Two-US', store: 'DEMO-US' } }, requester(2));
  assert.equal(first.scanning, true);
  assert.equal(second.scanning, true);
  assert.equal(created.length, 1);
  const scanId = delivered.find(({ message }) => message.type === 'LX_FORMAL_RUN_CARGO_SNAPSHOT').message.requestId;
  assert.equal((await send({ type: 'LX_FORMAL_CARGO_FOCUS_SOURCE', requestId: scanId }, source())).ok, true);
  await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_READY', requestId: scanId, complete: true, scope: '全部创建时间', rows: [
    { shipmentId: 'FBA1', msku: 'TEST-One-US', store: 'DEMO-US', status: 'SHIPPED', declared: '30', received: '2' },
    { shipmentId: 'FBA2', msku: 'TEST-Two-US', store: 'DEMO-US', status: 'SHIPPED', declared: '10', received: '0' }
  ] }, source());
  const pushed = delivered.filter(({ message }) => message.type === 'LX_FORMAL_CARGO_SNAPSHOT_ROWS');
  assert.equal(pushed.length, 2);
  assert.deepEqual(pushed.map(({ message }) => message.rows[0].msku), ['TEST-One-US', 'TEST-Two-US']);
  assert.deepEqual(updates, [created[0].id, 1]);
  const cached = await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_QUERY', identity: { msku: 'TEST-One-US', store: 'DEMO-US' } }, requester(1));
  assert.equal(cached.cached, true);
  assert.equal(cached.rows.length, 1);
  assert.equal(created.length, 1);
  const sales = { tab: { id: 3, url: 'https://example.lingxing.com/erp/mreport/salesStat', windowId: 1 } };
  const salesCached = await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_QUERY', identity: { msku: 'TEST-One-US', store: 'DEMO-US' } }, sales);
  assert.equal(salesCached.cached, true);
  assert.equal(salesCached.rows[0].declared, '30');
  assert.equal(created.length, 1, '销量和产品表现共享完整快照，不再次爬取');
  const missingStore = await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_QUERY', identity: { msku: 'TEST-One-US' } }, sales);
  assert.equal(missingStore.ok, false);
  const wrongPage = await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_QUERY', identity: { msku: 'TEST-One-US', store: 'DEMO-US' } }, { tab: { id: 5, url: 'https://example.lingxing.com/erp/listing' } });
  assert.equal(wrongPage.ok, false);
  session.formalCargoSessionSnapshot.capturedAt = Date.now() - 48 * 60 * 60 * 1000;
  const fresh = await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_QUERY', identity: { msku: 'TEST-One-US', store: 'DEMO-US' } }, requester(1));
  assert.equal(fresh.scanning, true);
  assert.equal(created.length, 2);
  const freshScanId = delivered.filter(({ message }) => message.type === 'LX_FORMAL_RUN_CARGO_SNAPSHOT').at(-1).message.requestId;
  await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_READY', requestId: freshScanId, error: '测试结束', complete: false }, { tab: created[1] });
  await onStartup();
  const afterRestart = await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_QUERY', identity: { msku: 'TEST-One-US', store: 'DEMO-US' } }, requester(1));
  assert.equal(afterRestart.scanning, true);
  assert.equal(created.length, 3);
  const restartScanId = delivered.filter(({ message }) => message.type === 'LX_FORMAL_RUN_CARGO_SNAPSHOT').at(-1).message.requestId;
  await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_READY', requestId: restartScanId, error: '测试结束', complete: false }, { tab: created[2] });
});
