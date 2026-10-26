import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');

test('在途明细点击启动整表快照，复用本次会话缓存', () => {
  const start = source.indexOf('  async function onTransitColumnClick(');
  const end = source.indexOf('\n  function cargoSnapshotResult(', start);
  assert.ok(start >= 0 && end > start);
  const clickHandler = source.slice(start, end);
  assert.match(clickHandler, /type: 'LX_FORMAL_CARGO_SNAPSHOT_QUERY'/);
  assert.doesNotMatch(clickHandler, /type: 'LX_FORMAL_TRANSIT_DETAIL_QUERY'/);
  assert.match(clickHandler, /cargoSnapshotResult\(response\.rows, identity, response\.complete, response\.scope\)/);
});
