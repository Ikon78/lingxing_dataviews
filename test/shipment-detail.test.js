import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const context = {};
vm.runInNewContext(readFileSync(new URL('../shipment-detail.js', import.meta.url), 'utf8'), context);
const { fromRows } = context.LXShipmentDetail;

test('只汇总相同 MSKU 和店铺的 SHIPPED 产品申报减签收，按到货日合并', () => {
  const result = fromRows([
    { shipmentId: 'FBA2', status: 'SHIPPED', msku: 'TEST-One-US', store: 'DEMO-US', declared: '50', received: '8', orderNumber: 'SP2', arrivalAt: '2026-10-25', shippedAt: '2026-09-20 10:00' },
    { shipmentId: 'FBA1', status: 'SHIPPED', msku: 'TEST One US', store: 'DEMO-US', declared: '30', received: '2', orderNumber: 'SP1', arrivalAt: '2026-10-25', shippedAt: '2026-09-18 08:00' },
    { shipmentId: 'FBA3', status: 'RECEIVING', msku: 'TEST-One-US', store: 'DEMO-US', declared: '98', received: '0' },
    { shipmentId: 'FBA4', status: 'SHIPPED', msku: 'TEST-One-US', store: 'OTHER-US', declared: '100', received: '0' },
    { shipmentId: 'FBA5', status: 'SHIPPED', msku: 'TEST-Two-US', store: 'DEMO-US', declared: '50', received: '0' }
  ], { msku: 'TEST-One-US', store: 'DEMO-US' }, 5);
  assert.deepEqual(Array.from(result.shipments, (row) => row.orderNumber), ['SP1', 'SP2']);
  assert.equal(result.total, 70);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].arrivalDay, '2026-10-25');
  assert.equal(result.groups[0].shipmentCount, 2);
  assert.equal(result.groups[0].quantity, 70);
  assert.equal(result.complete, true);
});

test('虚拟列表未读全时不宣称总计完整；未知数量和非 SHIPPED 不纳入', () => {
  const result = fromRows([
    { shipmentId: 'FBA1', status: 'SHIPPED', msku: 'TEST-One-US', store: 'DEMO-US', declared: '0', received: '0' },
    { shipmentId: 'FBA2', status: 'SHIPPED', msku: 'TEST-One-US', store: 'DEMO-US', declared: '-', received: '0' },
    { shipmentId: 'FBA3', status: 'RECEIVING', msku: 'TEST-One-US', store: 'DEMO-US', declared: '5', received: '0' }
  ], { msku: 'TEST-One-US', store: 'DEMO-US' }, 10);
  assert.equal(result.total, 0);
  assert.equal(result.complete, false);
  assert.equal(result.shipments.length, 1);
});

test('签收超过申报时保留公式差额，不悄悄改成零', () => {
  const result = fromRows([{ shipmentId: 'FBA1', status: 'SHIPPED', msku: 'A', store: 'DEMO-US', declared: '3', received: '5', arrivalAt: '2026-10-15' }], { msku: 'A', store: 'DEMO-US' });
  assert.equal(result.total, -2);
  assert.equal(result.groups[0].quantity, -2);
});

test('US/MX 使用系统日期；所有其他站点按明确运输渠道加天数，缺少渠道不猜测', () => {
  const base = { shipmentId: 'FBA1', status: 'SHIPPED', msku: 'TEST-One', declared: '10', received: '3', shippedAt: '2026-09-01 08:00', arrivalAt: '2026-10-15' };
  const day = (store, shippingMethod, arrivalAt = base.arrivalAt) => fromRows([{ ...base, store, shippingMethod, arrivalAt }], { msku: 'TEST-One', store }).shipments[0].arrivalDay;
  assert.equal(day('DEMO-US', '普船'), '2026-10-15');
  assert.equal(day('DEMO-MX', '空派'), '2026-10-15');
  assert.equal(day('DEMO-CA', '普船'), '2026-10-31');
  assert.equal(day('DEMO-UK', '加班船'), '2026-10-01');
  assert.equal(day('DEMO-DE', '空派'), '2026-09-15');
  for (const site of ['FR', 'IT', 'ES', 'NL', 'PL', 'SE', 'JP', 'AU', 'EU', 'AE', 'SA', 'BR']) {
    assert.equal(day(`DEMO-${site}`, '普船'), '2026-10-31', site);
    assert.equal(day(`DEMO-${site}`, '加班船'), '2026-10-01', site);
    assert.equal(day(`DEMO-${site}`, '空派'), '2026-09-15', site);
  }
  assert.equal(day('SAMPLE-DE', '德国-铁路'), '2026-10-31');
  assert.equal(day('DEMO-FR', '普船/空派'), '');
  assert.equal(day('', '普船'), '');
  assert.equal(day('DEMO-DE', '海运'), '');
  assert.equal(day('DEMO-US', '普船', ''), '');
});

test('德国铁路按已确认规则加 60 天，并按计算日期拆分合并而非沿用系统日', () => {
  const base = { status: 'SHIPPED', msku: 'SAMPLE-Product Alpha-001-EU', store: 'SAMPLE-DE', received: '0', shippingMethod: '德国-铁路', arrivalAt: '2026-12-31' };
  const result = fromRows([
    { ...base, shipmentId: 'FBA1', orderNumber: 'SP000000001', declared: '11', shippedAt: '2025-01-01' },
    { ...base, shipmentId: 'FBA2', orderNumber: 'SP000000002', declared: '17', shippedAt: '2025-01-16' }
  ], { msku: base.msku, store: base.store }, 2);
  assert.deepEqual(Array.from(result.groups, (group) => group.arrivalDay), ['2025-03-02', '2025-03-17']);
  assert.equal(result.total, 28);
  assert.equal(result.complete, true);
});
