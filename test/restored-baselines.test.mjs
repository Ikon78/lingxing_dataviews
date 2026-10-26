import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const content = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
test('销量优先使用日历 pick 生命周期，不调用货件模型提交或修改只读输入值', () => {
  const restored = content.slice(content.indexOf('  async function setSalesDateRange('), content.indexOf('  async function setSourceDateRange('));
  assert.match(restored, /action: 'pickSalesDate'/);
  assert.doesNotMatch(restored, /action: 'setDate'|emitInput|emitChange|\.value\s*=/);
  assert.match(restored, /MutationObserver/);
  assert.doesNotMatch(restored, /pause\(/);
});

test('货件主链路保留可见行展开，不先经过整页占位行自动定位', () => {
  const main = content.slice(content.indexOf('  async function runCargoSnapshot('), content.indexOf('  async function runFocusedTransitDetailQuery('));
  assert.match(main, /await collectCargoLegacyProductPage\(expected, pageReport\)/);
  assert.doesNotMatch(main, /await collectCargoLoadedPage/);
});

test('业务表日期列须对应实际目标；旧十天表包含目标日也不能冒充单日报表', () => {
  const start = content.indexOf('  function salesReportMatchesDate(');
  const end = content.indexOf('  async function waitSalesReportReady(', start);
  let headers = ['可用库存可售天数', '10-19 周一', '10-18 周日', '10-15 周四'];
  const run = vm.runInNewContext(`${content.slice(start, end)}\nsalesReportMatchesDate`, {
    dateRangeKey: (range) => range?.start && range?.end ? `${range.start}:${range.end}` : '',
    findTableMount: () => ({ querySelectorAll: () => headers.map((textContent) => ({ textContent })) }),
    clean: (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  });
  const wanted = { start: '2026-10-15', end: '2026-10-15' };
  assert.equal(run(wanted), false);
  headers = ['可用库存可售天数', '小时维度趋势图', '10-15\n周四'];
  assert.equal(run(wanted), true);
  headers = [];
  assert.equal(run(wanted), false);
});

test('同日期业务表已有目标 MSKU 时无需再等待表格改变，错误日期仍拒绝读取', async () => {
  const start = content.indexOf('  async function waitForSourceResult(');
  const end = content.indexOf('\n  function salesReportMatchesDate(', start);
  let now = 1000;
  let datesMatch = true;
  const run = vm.runInNewContext(`${content.slice(start, end)}\nwaitForSourceResult`, {
    Date: { now: () => now }, setTimeout: (callback, delay) => { now += delay; callback(); },
    currentTableText: () => 'TEST-Product-Epsilon-US 45 天', sourceIsLoading: () => false,
    normalizeMsku: (value) => value, isSalesPage: () => true,
    pageDateRange: () => ({ start: '2026-10-15', end: '2026-10-15' }),
    salesReportMatchesDate: () => datesMatch
  });
  assert.equal((await run('TEST-Product-Epsilon-US', 'TEST-Product-Epsilon-US 45 天')).settled, true);
  datesMatch = false;
  assert.equal((await run('TEST-Product-Epsilon-US', 'TEST-Product-Epsilon-US 45 天')).settled, false);
});
