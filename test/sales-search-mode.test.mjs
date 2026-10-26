import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const content = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
const start = content.indexOf('  async function chooseSourceSearchMode(');
const source = content.slice(start, content.indexOf('  async function waitForSearchInput(', start));
test('销量自动切换优先使用原生选项接口，并重新读取当前搜索条件证明生效', async () => {
  let actual = 'ASIN';
  const requests = [];
  const choose = vm.runInNewContext(`${source}\nchooseSourceSearchMode`, {
    isSalesPage: () => true, clean: (value) => String(value || '').trim(),
    sourceSearchControls: () => ({ mode: actual }),
    readLoadedTable: async (options) => { requests.push(options.action); actual = 'MSKU'; return { ok: true }; }
  });
  assert.equal(await choose({ click() { throw new Error('无需模拟菜单点击'); } }, 'MSKU'), true);
  assert.deepEqual(requests, ['selectSalesMsku']);
});

test('产品表现也通过原生选项处理选择 MSKU，并验证实际搜索类型', async () => {
  let actual = '品名';
  const choose = vm.runInNewContext(`${source}\nchooseSourceSearchMode`, {
    isSalesPage: () => false, isProductExpressionPage: () => true, clean: (value) => String(value ?? '').trim(),
    sourceSearchControls: () => ({ mode: actual }),
    readLoadedTable: async ({ action }) => { assert.equal(action, 'selectProductMsku'); actual = 'MSKU'; return { ok: true }; }
  });
  assert.equal(await choose({ click() { throw new Error('原生选项成功时无需模拟点击'); } }, 'MSKU'), true);
});

test('产品表现默认品名模式也能定位搜索类型，再切换到 SKU，不能误报控件未就绪', () => {
  const modeInput = { value: '品名', type: 'text', readOnly: true };
  const fuzzy = { value: '模糊', type: 'text', readOnly: true };
  const query = { value: '', type: 'text', readOnly: false };
  const scope = { querySelectorAll: () => [modeInput, fuzzy, query] };
  const start = content.indexOf('  function sourceSearchControls(');
  const end = content.indexOf('\n  async function chooseSourceSearchMode(', start);
  const controls = vm.runInNewContext(`${content.slice(start, end)}\nsourceSearchControls`, {
    document: { querySelectorAll: () => [scope] }, isRendered: () => true, clean: (value) => String(value ?? '').trim()
  });
  assert.equal(controls().modeInput, modeInput);
  assert.equal(controls().mode, '品名');
  assert.equal(controls().input, query);
  modeInput.value = 'SKU';
  assert.equal(controls().mode, 'SKU');
  query.disabled = true;
  assert.equal(controls(), null, '禁用搜索输入仍不能提交');
});
