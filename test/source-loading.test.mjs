import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const start = source.indexOf('  function sourceIsLoading(');
const end = source.indexOf('\n  function submitSourceSearch(', start);
const node = (classes, opacity = '1', rendered = true) => ({
  classList: { contains: (value) => classes.split(' ').includes(value) }, opacity, rendered
});

test('后台透明退场遮罩不等于加载中，真实可见遮罩仍阻止采集', () => {
  let masks = [];
  const loading = vm.runInNewContext(`${source.slice(start, end)}\nsourceIsLoading`, {
    location: { pathname: '/erp/mreport/salesStat' },
    document: { querySelectorAll: () => masks },
    isRendered: (value) => value.rendered, getComputedStyle: (value) => ({ opacity: value.opacity })
  });
  masks = [node('el-loading-mask el-loading-fade-leave-active el-loading-fade-leave-to', '0')];
  assert.equal(loading(), false);
  masks = [node('el-loading-mask el-loading-fade-leave-active', '0.5')];
  assert.equal(loading(), false);
  masks = [node('el-loading-mask', '0')];
  assert.equal(loading(), false);
  masks = [node('el-loading-mask', '1', false)];
  assert.equal(loading(), false);
  masks = [node('vxe-loading ak-loading-mask is--visible')];
  assert.equal(loading(), true);
  masks = [node('el-loading-mask el-loading-fade-leave-to', '0'), node('el-loading-mask', '0.8')];
  assert.equal(loading(), true);
});

test('退场遮罩存在时，已返回且稳定的目标日期结果可以结束等待', async () => {
  const waitStart = source.indexOf('  async function waitForSourceResult(');
  const waitEnd = source.indexOf('\n  function salesReportMatchesDate(', waitStart);
  let now = 1000;
  const wait = vm.runInNewContext(`${source.slice(start, end)}\n${source.slice(waitStart, waitEnd)}\nwaitForSourceResult`, {
    location: { pathname: '/erp/mreport/salesStat' },
    document: { querySelectorAll: () => [node('el-loading-mask el-loading-fade-leave-active el-loading-fade-leave-to', '0')] },
    isRendered: (value) => value.rendered, getComputedStyle: (value) => ({ opacity: value.opacity }),
    normalizeMsku: (value) => value, currentTableText: () => 'A-US 39 天',
    isSalesPage: () => true, pageDateRange: () => ({ start: '2026-10-18', end: '2026-10-18' }),
    salesReportMatchesDate: () => true,
    readLoadedTable: async () => ({ ok: true, signature: 'new', loading: false }),
    Date: { now: () => now }, setTimeout: (callback, delay) => { now += delay; callback(); }
  });
  const result = await wait('A-US', 'old report', 8000, { ok: true, signature: 'old' });
  assert.equal(result.settled, true);
  assert.equal(result.matched, true);
  assert.ok(now < 3000);
});
