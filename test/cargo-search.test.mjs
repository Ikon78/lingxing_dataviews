import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
const start = content.indexOf('  async function chooseCargoSearchMode(');
const end = content.indexOf('\n  async function waitForCargoMskuSearch(', start);
assert.ok(start >= 0 && end > start, '无法定位货件搜索模式切换函数');
const functionSource = content.slice(start, end);

test('货件页只选择实际可见的 MSKU 下拉项，并确认输入框已切换', async () => {
  const calls = [];
  const input = {
    isConnected: true,
    value: '货件单号',
    focus() { calls.push('focus'); },
    click() { calls.push('open'); },
    closest() { return null; }
  };
  const hidden = { visible: false, textContent: 'MSKU', dispatchEvent() {}, click() { calls.push('hidden'); } };
  const visible = { visible: true, textContent: 'MSKU', dispatchEvent() {}, click() { calls.push('visible'); input.value = 'MSKU'; } };
  const choose = vm.runInNewContext(`${functionSource}\nchooseCargoSearchMode`, {
    clean: (value) => String(value || '').trim(),
    isRendered: (node) => node.visible,
    document: { querySelectorAll: () => [hidden, visible] },
    MouseEvent: class { constructor(type) { this.type = type; } },
    setTimeout
  });
  assert.equal(await choose(input, 'MSKU'), true);
  assert.deepEqual(calls, ['focus', 'open', 'visible']);
  assert.equal(input.value, 'MSKU');
  assert.equal(await choose(input, 'MSKU'), true);
  assert.deepEqual(calls, ['focus', 'open', 'visible']);
});
