import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
const start = content.indexOf('  const cargoSixMonthRange = ');
const end = content.indexOf('\n  const skuQueryFromMsku', start);
assert.ok(start >= 0 && end > start, '无法定位货件近 6 个月日期计算');
const { cargoSixMonthRange, cargoScanWindows } = vm.runInNewContext(`${content.slice(start, end)}\n({ cargoSixMonthRange, cargoScanWindows })`, { Date });

test('货件范围为当天向前 6 个日历月，并在短月截断月末', () => {
  assert.equal(JSON.stringify(cargoSixMonthRange(new Date(2026, 9, 15))), JSON.stringify({ start: '2026-04-15', end: '2026-10-15' }));
  assert.equal(JSON.stringify(cargoSixMonthRange(new Date(2026, 7, 31))), JSON.stringify({ start: '2026-02-28', end: '2026-08-31' }));
  assert.equal(JSON.stringify(cargoSixMonthRange(new Date(2024, 7, 31))), JSON.stringify({ start: '2024-02-29', end: '2024-08-31' }));
  assert.equal(JSON.stringify(cargoSixMonthRange(new Date(2026, 0, 31))), JSON.stringify({ start: '2025-07-31', end: '2026-01-31' }));
});

test('六个月按自然月拆成无重叠、无缺口的窗口，缩短产品虚拟滚动表', () => {
  assert.equal(JSON.stringify(cargoScanWindows({ start: '2026-04-16', end: '2026-10-16' })), JSON.stringify([
    { start: '2026-10-01', end: '2026-10-16' },
    { start: '2026-09-01', end: '2026-09-30' },
    { start: '2026-08-01', end: '2026-08-31' },
    { start: '2026-07-01', end: '2026-07-31' },
    { start: '2026-06-01', end: '2026-06-30' },
    { start: '2026-05-01', end: '2026-05-31' },
    { start: '2026-04-16', end: '2026-04-30' }
  ]));
  assert.equal(JSON.stringify(cargoScanWindows({ start: '2026-02-28', end: '2026-08-31' })), JSON.stringify([
    { start: '2026-08-01', end: '2026-08-31' },
    { start: '2026-07-01', end: '2026-07-31' },
    { start: '2026-06-01', end: '2026-06-30' },
    { start: '2026-05-01', end: '2026-05-31' },
    { start: '2026-04-01', end: '2026-04-30' },
    { start: '2026-03-01', end: '2026-03-31' },
    { start: '2026-02-28', end: '2026-02-28' }
  ]));
});
