import assert from 'node:assert/strict';
import test from 'node:test';

test('完整 MSKU 结果按店铺缓存，重启清除且不缓存缺失日期的详情', async () => {
  let listener;
  let startup;
  const session = {};
  const created = [];
  const sent = [];
  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener(callback) { startup = callback; } },
      onMessage: { addListener(callback) { listener = callback; } }
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
      async create(options) { const tab = { id: 500 + created.length, url: options.url }; created.push(tab); return tab; },
      async sendMessage(tabId, message) {
        sent.push({ tabId, message });
        if (message.type === 'LX_FORMAL_RUNTIME') return { ok: true, route: 'page@%2Ferp%2Fmsupply%2FfbaCargo' };
        return { ok: true };
      },
      async remove() {},
      async get(tabId) { return { id: tabId, active: false }; }
    }
  };
  await import(`../background.js?cargo-msku-cache=${Date.now()}`);
  const requester = { tab: { id: 1, url: 'https://example.lingxing.com/erp/productExpressionNew', windowId: 1 } };
  const send = (message, sender = requester) => new Promise((resolve) => listener(message, sender, resolve));
  const identity = { msku: 'TEST-Product Zeta-001-US', store: 'DEMO-US' };
  const first = await send({ type: 'LX_FORMAL_TRANSIT_DETAIL_QUERY', identity });
  assert.equal(created.length, 1);
  await send({ type: 'LX_FORMAL_TRANSIT_DETAIL_RESULT', requestId: first.requestId, result: {
    complete: true, scope: '2026-04-16 至 2026-10-16',
    shipments: [{ shipmentId: 'FBA1', quantity: 28, orderNumber: 'SP1', shippedAt: '2026-09-24', arrivalDay: '2026-11-13' }]
  } }, { tab: created[0] });
  const cached = await send({ type: 'LX_FORMAL_TRANSIT_DETAIL_QUERY', identity });
  assert.equal(cached.cached, true);
  assert.equal(cached.result.total, 28);
  assert.equal(created.length, 1);
  const other = await send({ type: 'LX_FORMAL_TRANSIT_DETAIL_QUERY', identity: { ...identity, store: 'SAMPLE-US' } });
  assert.equal(other.cached, undefined);
  assert.equal(created.length, 2);
  await send({ type: 'LX_FORMAL_TRANSIT_DETAIL_RESULT', requestId: other.requestId, result: {
    complete: true, shipments: [{ shipmentId: 'FBA2', quantity: 2, orderNumber: '', shippedAt: '', arrivalDay: '' }]
  } }, { tab: created[1] });
  const incompleteDates = await send({ type: 'LX_FORMAL_TRANSIT_DETAIL_QUERY', identity: { ...identity, store: 'SAMPLE-US' } });
  assert.equal(incompleteDates.cached, undefined);
  assert.equal(created.length, 3);
  await send({ type: 'LX_FORMAL_TRANSIT_DETAIL_RESULT', requestId: incompleteDates.requestId, error: '测试结束' }, { tab: created[2] });
  startup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const restarted = await send({ type: 'LX_FORMAL_TRANSIT_DETAIL_QUERY', identity });
  assert.equal(restarted.cached, undefined);
  assert.equal(created.length, 4);
  await send({ type: 'LX_FORMAL_TRANSIT_DETAIL_RESULT', requestId: restarted.requestId, error: '测试结束' }, { tab: created[3] });
  delete globalThis.chrome;
});
