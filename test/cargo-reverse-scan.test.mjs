import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content.js'), 'utf8');
const start = source.indexOf('  async function collectCargoProductPage(');
const end = source.indexOf('\n  function cargoSearchControls(', start);
assert.ok(start >= 0 && end > start);
const collectSource = `${source.slice(start, end)}\ncollectCargoProductPage`;

test('产品虚拟表正向漏一票时反向复扫补齐，仍须核对总票数', async () => {
  const wrapper = { scrollTop: 0, scrollHeight: 300, clientHeight: 100 };
  let lastTop = 0;
  let movingUp = false;
  const visits = [];
  const collect = vm.runInNewContext(collectSource, {
    document: { querySelector: () => wrapper },
    cargoTableSignature: () => String(wrapper.scrollTop),
    waitCargoTableRender: async () => {},
    cargoProductRows: (_state, observed) => {
      const top = wrapper.scrollTop;
      if (top < lastTop) movingUp = true;
      lastTop = top;
      visits.push(top);
      const ids = top < 80 ? ['FBAONE'] : ['FBATWO'];
      if (movingUp && top <= 80) ids.push('FBATHREE');
      for (const id of ids) observed.shipments.add(id);
      return ids.map((id) => ({ shipmentId: id, msku: 'SKU-US', store: 'DEMO-US' }));
    },
    normalizeMsku: (value) => value,
    clean: (value) => String(value || '').trim(),
    Date, Math, Map, Set
  });
  const result = await collect(3, async () => {});
  assert.equal(result.shipmentCount, 3);
  assert.ok(visits.includes(200), '应先到表格底部');
  assert.ok(visits.slice(visits.indexOf(200) + 1).some((top) => top < 200), '应从底部向上复扫');
});
