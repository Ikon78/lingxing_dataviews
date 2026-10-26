import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const content = fs.readFileSync(path.join(projectDir, 'content.js'), 'utf8');
const start = content.indexOf('  const COMMON_FIELD_IDS = ');
const end = content.indexOf('\n  const state = ', start);
assert.ok(start >= 0 && end > start, '无法定位字段库分组与滚动逻辑');
const { groupLibraryFields, libraryDragScrollDelta } = vm.runInNewContext(
  `${content.slice(start, end)}\n({ groupLibraryFields, libraryDragScrollDelta })`,
  { FBA_ESTIMATED_DAYS_ID: 'page@%2Ferp%2FproductExpressionNew:FBA可售天数预估' }
);

test('指定的三个字段固定归入常用字段，其他字段保持原顺序且不重复', () => {
  const fields = [
    { id: 'listing:库存' }, { id: 'listing:优惠价' },
    { id: 'sales:可用库存可售天数' }, { id: 'listing:价格' }, { id: 'sales:销量' }
  ];
  const result = groupLibraryFields(fields);
  assert.deepEqual(Array.from(result.common, (field) => field.id), [
    'sales:可用库存可售天数', 'listing:价格', 'listing:优惠价'
  ]);
  assert.deepEqual(Array.from(result.other, (field) => field.id), ['listing:库存', 'sales:销量']);
});

test('产品表现 FBA 可售天数预估列固定为常用字段且不重复', () => {
  const id = 'page@%2Ferp%2FproductExpressionNew:FBA可售天数预估';
  const result = groupLibraryFields([{ id: 'listing:库存' }, { id }]);
  assert.deepEqual(Array.from(result.common, (field) => field.id), [id]);
  assert.deepEqual(Array.from(result.other, (field) => field.id), ['listing:库存']);
});

test('拖拽靠近字段滚动区上下边缘时才自动滚动', () => {
  assert.equal(libraryDragScrollDelta(110, 100, 300), -22);
  assert.equal(libraryDragScrollDelta(200, 100, 300), 0);
  assert.equal(libraryDragScrollDelta(290, 100, 300), 22);
});
