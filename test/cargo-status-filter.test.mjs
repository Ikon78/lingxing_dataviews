import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
const start = content.indexOf('  function cargoStatusSelect()');
const end = content.indexOf('  async function chooseCargoShippedStatus()', start);
assert.ok(start >= 0 && end > start);
const source = `${content.slice(start, end)}\n({ cargoStatusSelect, cargoShippedSelected })`;

test('SHIPPED 选中后占位字被清空，仍能定位货件状态控件', () => {
  const select = (placeholder, tags = []) => ({
    querySelector: () => ({ textContent: placeholder }),
    querySelectorAll: () => tags.map((textContent) => ({ textContent }))
  });
  const selects = [select('全部店铺'), select('货件类型'), select('', ['SHIPPED']), select('关联发货单')];
  const api = vm.runInNewContext(source, {
    document: { querySelectorAll: () => selects },
    clean: (value) => String(value ?? '').trim()
  });
  assert.equal(api.cargoStatusSelect(), selects[2]);
  assert.equal(api.cargoShippedSelected(), true);
  selects[2] = select('', ['SHIPPED', 'RECEIVING']);
  assert.equal(api.cargoShippedSelected(), false);
});
