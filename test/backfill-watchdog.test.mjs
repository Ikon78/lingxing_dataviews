import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const content = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const functions = content.slice(content.indexOf('  function acceptBackfillMessage('), content.indexOf('  function scheduleSourceBackfill('));

test('主表 75 秒没有结果时独立清除卡住的补查；延迟旧回执不能污染新任务', () => {
  const pending = { requestId: 'r1', sourceKind: 'sales', signature: 'sig', deadline: 75000, startedAt: 0 };
  const sent = [];
  const statuses = [];
  const context = { activeBackfill: pending, Date: { now: () => 76000 }, backfillFailureReasons: new Map(), backfillAttempts: new Map(),
    libraryRefreshTimer: null, setTimeout: () => 1, clearTimeout() {}, refreshLibrary() {},
    updateBackfill: (text) => statuses.push(text), send: (message) => sent.push(message) };
  vm.createContext(context);
  vm.runInContext(functions, context);
  vm.runInContext('checkBackfillTimeout()', context);
  assert.equal(context.activeBackfill, null);
  assert.match(statuses[0], /75 秒/);
  assert.equal(sent[0].type, 'LX_FORMAL_SOURCE_CANCEL');
  assert.equal(vm.runInContext("acceptBackfillMessage({requestId:'r1',sourceKind:'sales'})", context), false);
  context.activeBackfill = { requestId: 'r2', sourceKind: 'sales' };
  assert.equal(vm.runInContext("acceptBackfillMessage({requestId:'r1',sourceKind:'sales'})", context), false);
  assert.equal(vm.runInContext("acceptBackfillMessage({requestId:'r2',sourceKind:'sales'})", context), true);
});
