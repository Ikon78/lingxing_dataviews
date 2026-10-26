import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as core from '../core.js';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '');

test('任务结束后的延迟回执不得复活已删除的任务登记', async () => {
  const start = source.indexOf('async function persistCargoScan(');
  const end = source.indexOf('\nasync function currentCargoScan(', start);
  const persist = vm.runInNewContext(`${source.slice(start, end)}\npersistCargoScan`, {
    pendingCargoSnapshot: null,
    chrome: { storage: { session: { set() { throw new Error('已结束的任务不能重写'); } } } }
  });
  await persist({ scanId: 'finished' });
});

test('后台 Worker 被回收后从会话任务登记恢复，继续回传进度并保存完整货件快照', async () => {
  const session = {};
  const delivered = [];
  const removed = [];
  let listener;
  let created = 0;
  const chrome = {
    runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} },
      onMessage: { addListener(value) { listener = value; } } },
    storage: { session: {
      async get(key) { return { [key]: structuredClone(session[key]) }; },
      async set(values) { Object.assign(session, structuredClone(values)); },
      async remove(key) { delete session[key]; }
    } },
    tabs: {
      async create(options) { created += 1; return { id: 99, ...options }; },
      async sendMessage(tabId, message) {
        delivered.push({ tabId, message });
        if (message.type === 'LX_FORMAL_RUNTIME') return { ok: true, route: 'page@%2Ferp%2Fmsupply%2FfbaCargo' };
        return { ok: true };
      },
      async get(id) { return { id, active: false }; },
      async remove(id) { removed.push(id); }
    }
  };
  const startWorker = () => vm.runInNewContext(source, { ...core, chrome, crypto: webcrypto, URL, console,
    setTimeout: () => 1, clearTimeout() {} });
  const requester = { tab: { id: 1, url: 'https://example.lingxing.com/erp/productExpressionNew' } };
  const cargo = { tab: { id: 99, url: 'https://example.lingxing.com/erp/msupply/fbaCargo' } };
  const send = (message, sender = cargo) => new Promise((resolve) => listener(message, sender, resolve));
  startWorker();
  const first = await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_QUERY', identity: { msku: 'A-US', store: 'DEMO-US' } }, requester);
  const scanId = session.formalCargoPendingScan.scanId;
  const deadline = session.formalCargoPendingScan.deadline;
  assert.equal(session.formalCargoPendingScan.started, true);
  await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_PROGRESS', requestId: scanId, stage: '已读取业务表 19 票、633 行' });

  // 新的 JS 全局环境，原来的 pendingCargoSnapshot/timeout 均已消失。
  startWorker();
  const resumed = await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_PROGRESS', requestId: scanId, telemetryOnly: true,
    diagnosticText: '响应 90；网络产品行 0' });
  assert.equal(resumed.ok, true, resumed.error);
  assert.equal(session.formalCargoPendingScan.deadline, deadline, '恢复不能重置 480 秒上限');
  const progress = delivered.at(-1).message;
  assert.equal(progress.requestId, first.requestId);
  assert.equal(progress.stage, '已读取业务表 19 票、633 行', '诊断回执不得覆盖业务阶段');
  assert.equal(progress.telemetryOnly, true);

  const second = await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_QUERY', identity: { msku: 'A-US', store: 'DEMO-US' } },
    { tab: { ...requester.tab, id: 2 } });
  assert.equal(second.scanning, true);
  assert.equal(created, 1, '恢复中的任务不能重复创建货件扫描页');
  const done = await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_READY', requestId: scanId, complete: true,
    rows: [{ shipmentId: 'FBA1', msku: 'A-US', store: 'DEMO-US', status: 'SHIPPED', declared: '30', received: '2' }] });
  assert.equal(done.ok, true, done.error);
  assert.equal(session.formalCargoSessionSnapshot.complete, true);
  assert.equal(session.formalCargoPendingScan, undefined);
  assert.equal(delivered.filter(({ message }) => message.type === 'LX_FORMAL_CARGO_SNAPSHOT_ROWS').length, 2);
  assert.deepEqual(removed, [99]);
});
