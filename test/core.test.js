import test from "node:test";
import assert from "node:assert/strict";
import { dateRangeKey, fieldCatalog, findMatchingRow, mergeRows, normalizeMarketplace, normalizeMsku, sanitizeCapture, skuQueryFromMsku, sourceKindFromUrl, warehouseIdentity, withoutFields } from "../core.js";

test("只识别指定领星页面", () => {
  assert.equal(sourceKindFromUrl("https://example.lingxing.com/erp/listing"), "listing");
  assert.equal(sourceKindFromUrl("https://example.lingxing.com/erp/mreport/salesStat"), "sales");
  assert.equal(sourceKindFromUrl("https://example.lingxing.com/erp/inventory/list?x=1"), "page@%2Ferp%2Finventory%2Flist");
  assert.equal(sourceKindFromUrl("https://example.lingxing.com/erp/inventory/list/"), "page@%2Ferp%2Finventory%2Flist");
  assert.equal(sourceKindFromUrl("https://example.lingxing.com/home"), null);
  assert.equal(sourceKindFromUrl("https://example.com/erp/listing"), null);
});

test("字段库合并同一复合键且保留字段并集", () => {
  const identity = { store: "DEMO-US", marketplace: "美国", msku: "A" };
  const rows = mergeRows([{ identity, fields: { 售价: "$9" } }], [{ identity, fields: { 库存: "10" } }]);
  assert.deepEqual(rows[0].fields, { 售价: "$9", 库存: "10" });
  assert.deepEqual(fieldCatalog(rows, "listing").map((item) => item.id), ["listing:库存", "listing:售价"]);
});

test("带日期约束的来源数据按日期范围隔离", () => {
  const identity = { store: "DEMO-US", marketplace: "美国", msku: "A" };
  const first = sanitizeCapture({ dateRange: { start: "2026-10-01", end: "2026-10-07" }, rows: [{ identity, fields: { 均值: "5" } }] }, "sales");
  const second = sanitizeCapture({ dateRange: { start: "2026-10-08", end: "2026-10-14" }, rows: [{ identity, fields: { 均值: "9" } }] }, "sales");
  const rows = mergeRows(first.rows, second.rows);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.dateScope), ["2026-10-01:2026-10-07", "2026-10-08:2026-10-14"]);
  assert.deepEqual(rows.filter((row) => row.dateScope === dateRangeKey(first.dateRange)).map((row) => row.fields.均值), ["5"]);
  assert.equal(dateRangeKey({ start: "2026-10-14", end: "2026-10-08" }), "");
});

test("只有一个同 MSKU 候选时可用后续上下文补齐记录", () => {
  const rows = mergeRows(
    [{ identity: { store: "", marketplace: "", msku: "A" }, fields: { 售价: "$9" } }],
    [{ identity: { store: "DEMO-US", marketplace: "美国", msku: "A" }, fields: { 库存: "10" } }]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].identity.store, "DEMO-US");
  assert.deepEqual(rows[0].fields, { 售价: "$9", 库存: "10" });
});

test("匹配优先使用店铺站点，MSKU 唯一时允许回退", () => {
  const rows = [
    { identity: { store: "A", marketplace: "US", msku: "X" }, fields: { price: "1" } },
    { identity: { store: "B", marketplace: "UK", msku: "X" }, fields: { price: "2" } }
  ];
  assert.equal(findMatchingRow({ store: "B", marketplace: "UK", msku: "X" }, rows).fields.price, "2");
  assert.equal(findMatchingRow({ msku: "X" }, rows), null);
  assert.equal(findMatchingRow({ msku: "Y" }, [{ identity: { msku: "Y" }, fields: {} }]).identity.msku, "Y");
});

test("MSKU 在不同页面仅空格和连字符不同时可唯一匹配和合并", () => {
  assert.equal(normalizeMsku("TEST-Sample Product-001-US"), "TEST-SAMPLE-PRODUCT-001-US");
  const existing = [{ identity: { store: "DEMO-US", marketplace: "US", msku: "TEST-Sample Product-001-US" }, fields: { 销量: "14" } }];
  const incoming = [{ identity: { store: "DEMO-US", marketplace: "US", msku: "TEST-Sample-Product-001-US" }, fields: { 订单量: "2" } }];
  const merged = mergeRows(existing, incoming);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].fields, { 销量: "14", 订单量: "2" });
  assert.equal(findMatchingRow({ store: "DEMO-US", marketplace: "US", msku: "TEST-Sample-Product-001-US" }, existing)?.fields.销量, "14");
});

test("显式 SKU 模式的通用工具可去掉站点后缀，产品表现 MSKU 查询不使用该工具", () => {
  assert.equal(skuQueryFromMsku("TEST-Product Beta-001-US"), "TEST-Product Beta-001");
  assert.equal(skuQueryFromMsku("TEST-Product-Gamma-001-UK"), "TEST-Product-Gamma-001");
  assert.equal(skuQueryFromMsku("SKU-WITHOUT-SITE"), "SKU-WITHOUT-SITE");
});

test("FBA 仓库字段可以补齐站点身份并在重复 MSKU 中精确匹配", () => {
  const rows = [
    { identity: { msku: "X" }, fields: { 仓库: "DEMO-US美国仓", FBA总库存: "8" } },
    { identity: { msku: "X" }, fields: { 仓库: "DEMO-CA加拿大仓", FBA总库存: "3" } }
  ];
  assert.deepEqual(warehouseIdentity("DEMO-CA加拿大仓"), { store: "DEMO-CA", marketplace: "CA" });
  assert.equal(normalizeMarketplace("加拿大"), "CA");
  assert.equal(findMatchingRow({ store: "DEMO-CA", marketplace: "加拿大", msku: "X" }, rows).fields.FBA总库存, "3");
});

test("捕获数据执行长度限制和字符串清理", () => {
  const result = sanitizeCapture({ rows: [{ identity: { msku: "  X  " }, fields: { " 售价 ": "  $9  " } }] }, "listing");
  assert.equal(result.rows[0].identity.msku, "X");
  assert.equal(result.rows[0].fields["售价"], "$9");
});

test("删除字段后本地记录和再次捕获都不包含该字段", () => {
  const identity = { msku: "A", store: "DEMO-US", marketplace: "美国" };
  const cached = [{ identity, fields: { 价格: "$9", 库存: "10" } }];
  const hidden = ["listing:价格"];
  const result = mergeRows(withoutFields(cached, "listing", hidden), withoutFields(cached, "listing", hidden));
  assert.deepEqual(result[0].fields, { 库存: "10" });
  assert.deepEqual(fieldCatalog(result, "listing").map((field) => field.id), ["listing:库存"]);
});
