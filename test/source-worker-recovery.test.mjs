import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as core from '../core.js';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '');
function fixture() {
  const session = {};
  const delivered = [];
  const removed = [];
  const timers = [];
  let listener;
  let now = Date.now();
  const chrome = {
    runtime: { getManifest: () => ({ version: '1.4.68' }), onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
    storage: { session: {
      async get(key) { return { [key]: structuredClone(session[key]) }; },
      async set(values) { Object.assign(session, structuredClone(values)); }, async remove(key) { delete session[key]; }
    } },
    tabs: {
      async query() { return []; }, async create(options) { return { id: 99, ...options }; },
      async get(id) { return { id, active: false }; }, async remove(id) { removed.push(id); },
      async sendMessage(tabId, message) {
        delivered.push({ tabId, message });
        return message.type === 'LX_FORMAL_RUNTIME' ? { ok: true, version: '1.4.68', route: 'sales' } : { ok: true };
      }
    }
  };
  const master = { tab: { id: 1, url: 'https://example.lingxing.com/erp/productExpressionNew' } };
  const sales = { tab: { id: 99, url: 'https://example.lingxing.com/erp/mreport/salesStat' } };
  const boot = () => vm.runInNewContext(source, { ...core, chrome, crypto: webcrypto, URL, console, Date: { now: () => now },
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {} });
  const send = (message, sender = sales) => new Promise((resolve) => listener(message, sender, resolve));
  return { session, delivered, removed, timers, master, sales, boot, send, advance(ms) { now += ms; } };
}

test('销量后台任务回收后恢复原请求、原截止时间，最终结果仍回主表并清理登记', async () => {
  const f = fixture(); f.boot();
  const started = await f.send({ type: 'LX_FORMAL_BACKFILL_SOURCE', sourceKind: 'sales', mskus: ['A-US'], dateRange: { start: '2026-10-18', end: '2026-10-18' } }, f.master);
  assert.equal(started.ok, true, started.error);
  const deadline = f.session.formalSourcePendingQueries[0].deadline;
  f.advance(35000); f.boot();
  assert.equal((await f.send({ type: 'LX_FORMAL_SOURCE_HEARTBEAT', requestId: started.requestId })).ok, true);
  assert.equal(f.session.formalSourcePendingQueries[0].deadline, deadline);
  const done = await f.send({ type: 'LX_FORMAL_SOURCE_RESULT', result: { requestId: started.requestId, ok: true, requested: 1, matched: 1, unresolved: [] } });
  assert.equal(done.ok, true, done.error);
  assert.equal(f.session.formalSourcePendingQueries.length, 0);
  assert.equal(f.delivered.at(-1).tabId, 1);
  assert.equal(f.delivered.at(-1).message.result.matched, 1);
  const close = f.timers.findLast((timer) => timer.delay === 1200); await close.fn();
  assert.deepEqual(f.removed, [99]);
  assert.equal((await f.send({ type: 'LX_FORMAL_SOURCE_HEARTBEAT', requestId: started.requestId })).ok, false, '结束后的心跳不能复活任务');
});

test('恢复后超时仍按原 70 秒终止；其他主表不能取消本批任务', async () => {
  const f = fixture(); f.boot();
  const started = await f.send({ type: 'LX_FORMAL_BACKFILL_SOURCE', sourceKind: 'sales', mskus: ['A-US'], dateRange: { start: '2026-10-18', end: '2026-10-18' } }, f.master);
  assert.equal((await f.send({ type: 'LX_FORMAL_SOURCE_CANCEL', requestId: started.requestId }, { tab: { ...f.master.tab, id: 2 } })).ok, false);
  f.advance(71000); f.boot();
  await f.send({ type: 'LX_FORMAL_SOURCE_HEARTBEAT', requestId: started.requestId });
  assert.equal(f.session.formalSourcePendingQueries.length, 0);
  assert.match(f.delivered.at(-1).message.result.error, /70 秒/);
});
