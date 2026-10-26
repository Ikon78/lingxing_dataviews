import test from "node:test";
import assert from "node:assert/strict";

test("批量删除会清理两个来源的缓存和所有主表布局，后续采集不会复活字段", async () => {
  const row = { identity: { msku: "A", store: "DEMO-US", marketplace: "美国" }, fields: { 价格: "$9", 库存: "10" } };
  const data = {
    formalDatasets: {
      listing: { label: "Listing", rows: [structuredClone(row)] },
      sales: { label: "销量统计", rows: [{ ...structuredClone(row), fields: { 销量: "5", 订单: "4" } }] }
    },
    formalLayouts: {
      listing: { fieldIds: ["listing:价格", "sales:销量", "listing:库存"] },
      sales: { fieldIds: ["listing:价格", "sales:销量", "sales:订单"] }
    }
  };
  let onInstalled;
  let onMessage;
  const createdTabs = [];
  const removedTabs = [];
  const sentMessages = [];
  let existingSourceTab = null;
  globalThis.chrome = {
    runtime: {
      getManifest() { return { version: "1.4.28" }; },
      onInstalled: { addListener(listener) { onInstalled = listener; } },
      onMessage: { addListener(listener) { onMessage = listener; } }
    },
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(names.filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
      },
      async set(values) { Object.assign(data, structuredClone(values)); },
      async remove(keys) { for (const key of keys) delete data[key]; }
    } },
    tabs: {
      async query() { return existingSourceTab ? [existingSourceTab] : []; },
      async create(options) { const tab = { id: 99, url: options.url, active: options.active }; createdTabs.push(tab); return tab; },
      async remove(tabId) { removedTabs.push(tabId); },
      async reload() {},
      async sendMessage(tabId, message) {
        sentMessages.push({ tabId, message });
        if (tabId === 22 && message.type === "LX_FORMAL_RUNTIME") return { ok: true, version: "1.4.28", route: "page@%2Ferp%2FproductExpressionNew" };
        if (message.type === "LX_FORMAL_RUN_SOURCE_QUERY") return { ok: true };
        if (message.type === "LX_FORMAL_RUN_TRANSIT_DETAIL_QUERY") return { ok: true };
        return null;
      }
    }
  };
  await import("../background.js");
  const sender = { tab: { id: 1, url: "https://example.lingxing.com/erp/listing" } };
  const requestFrom = (message, from = sender) => new Promise((resolve) => onMessage(message, from, resolve));
  const request = (message) => requestFrom(message);

  await onInstalled({ reason: "update" });
  assert.equal(data.formalDatasets.listing.rows[0].fields.价格, "$9");
  assert.deepEqual(await request({ type: "LX_FORMAL_PAGE_OPENED", sourceKind: "listing" }), { ok: true, sourceKind: "listing" });
  assert.equal(data.formalDatasets.listing.rows[0].fields.价格, "$9");

  assert.deepEqual(await request({ type: "LX_FORMAL_DELETE_FIELDS", fieldIds: ["listing:价格", "sales:销量"] }), { ok: true, deleted: 2 });
  assert.deepEqual(data.formalHiddenFields, ["listing:价格", "sales:销量"]);
  assert.deepEqual(data.formalDatasets.listing.rows[0].fields, { 库存: "10" });
  assert.deepEqual(data.formalDatasets.sales.rows[0].fields, { 订单: "4" });
  assert.deepEqual(data.formalLayouts.listing.fieldIds, ["listing:库存"]);
  assert.deepEqual(data.formalLayouts.sales.fieldIds, ["sales:订单"]);

  const productSender = { tab: { id: 2, url: "https://example.lingxing.com/erp/productExpressionNew" } };
  assert.deepEqual(await requestFrom({ type: "LX_FORMAL_SAVE_LAYOUT", fieldIds: ["sales:可用库存可售天数"], inventoryDaysThresholds: { short: "10", long: "60" } }, productSender), { ok: true });
  assert.deepEqual(data.formalLayouts["page@%2Ferp%2FproductExpressionNew"].inventoryDaysThresholds, { short: "10", long: "60" });
  assert.equal((await requestFrom({ type: "LX_FORMAL_SAVE_LAYOUT", fieldIds: [], inventoryDaysThresholds: { short: "60", long: "10" } }, productSender)).ok, false);
  assert.deepEqual(data.formalLayouts["page@%2Ferp%2FproductExpressionNew"].inventoryDaysThresholds, { short: "10", long: "60" });

  const marginMessage = { type: 'LX_FORMAL_SAVE_LAYOUT', fieldIds: [], inventoryDaysThresholds: { short: '10', long: '60' }, orderGrossMarginThresholds: { low: '-5.5', high: '35' } };
  assert.equal((await requestFrom(marginMessage, productSender)).ok, true);
  assert.deepEqual(data.formalLayouts['page@%2Ferp%2FproductExpressionNew'].orderGrossMarginThresholds, { low: '-5.5', high: '35' });
  for (const invalid of [{ low: '35', high: '35' }, { low: '40', high: '35' }, { low: 'NaN' }, { high: 'Infinity' }, { low: '-100001' }, { high: '100001' }, { low: true }, { low: [] }]) {
    assert.equal((await requestFrom({ ...marginMessage, orderGrossMarginThresholds: invalid }, productSender)).ok, false);
  }
  assert.deepEqual(data.formalLayouts['page@%2Ferp%2FproductExpressionNew'].orderGrossMarginThresholds, { low: '-5.5', high: '35' });
  assert.deepEqual(data.formalLayouts['page@%2Ferp%2FproductExpressionNew'].inventoryDaysThresholds, { short: '10', long: '60' });
  await requestFrom({ type: 'LX_FORMAL_SAVE_LAYOUT', fieldIds: [], inventoryDaysThresholds: { short: '10', long: '60' } }, productSender);
  assert.deepEqual(data.formalLayouts['page@%2Ferp%2FproductExpressionNew'].orderGrossMarginThresholds, { low: '-5.5', high: '35' }, '旧页面保存不擦除毛利率界限');
  assert.equal((await requestFrom({ ...marginMessage, orderGrossMarginThresholds: { low: '', high: '' } }, productSender)).ok, true);
  assert.deepEqual(data.formalLayouts['page@%2Ferp%2FproductExpressionNew'].orderGrossMarginThresholds, { low: '', high: '' }, '可以明确关闭两种预警');
  assert.equal((await requestFrom({ ...marginMessage, acoasThresholds: { high: '5.5' } }, productSender)).ok, true);
  assert.deepEqual(data.formalLayouts['page@%2Ferp%2FproductExpressionNew'].acoasThresholds, { high: '5.5' });
  for (const high of ['-1', 'NaN', 'Infinity', '100001', true, [], ' ']) {
    assert.equal((await requestFrom({ ...marginMessage, acoasThresholds: { high } }, productSender)).ok, false);
  }
  await requestFrom(marginMessage, productSender);
  assert.deepEqual(data.formalLayouts['page@%2Ferp%2FproductExpressionNew'].acoasThresholds, { high: '5.5' }, '旧页面保存不擦除 ACoAS 上限');
  assert.deepEqual(data.formalLayouts['page@%2Ferp%2FproductExpressionNew'].orderGrossMarginThresholds, { low: '-5.5', high: '35' }, '两类百分比阈值独立');
  await requestFrom({ ...marginMessage, acoasThresholds: { high: 0 } }, productSender);
  assert.deepEqual(data.formalLayouts['page@%2Ferp%2FproductExpressionNew'].acoasThresholds, { high: '0' });
  await requestFrom({ ...marginMessage, acoasThresholds: { high: '' } }, productSender);
  assert.deepEqual(data.formalLayouts['page@%2Ferp%2FproductExpressionNew'].acoasThresholds, { high: '' });

  const fbaId = 'page@%2Ferp%2FproductExpressionNew:FBA可售天数预估';
  const salesSender = { tab: { id: 3, url: 'https://example.lingxing.com/erp/mreport/salesStat' } };
  const library = await requestFrom({ type: 'LX_FORMAL_GET_LIBRARY' }, salesSender);
  assert.ok(library.data.fields.some((field) => field.id === fbaId), '未采集来源前也可用该列启动补查');
  assert.deepEqual(await requestFrom({ type: 'LX_FORMAL_SAVE_LAYOUT', fieldIds: [fbaId],
    fbaEstimatedDaysThresholds: { short: '15', long: '90' }, fbaEstimatedDaysInitialized: true }, salesSender), { ok: true });
  assert.deepEqual(data.formalLayouts.sales.fbaEstimatedDaysThresholds, { short: '15', long: '90' });
  assert.equal(data.formalLayouts.sales.fbaEstimatedDaysInitialized, true);
  assert.deepEqual(data.formalLayouts['page@%2Ferp%2FproductExpressionNew'].inventoryDaysThresholds, { short: '10', long: '60' });
  for (const invalid of [{ short: '90', long: '15' }, { short: '-1', long: '' }, { short: 'NaN', long: '' }, { short: '', long: '100001' }]) {
    assert.equal((await requestFrom({ type: 'LX_FORMAL_SAVE_LAYOUT', fieldIds: [fbaId], fbaEstimatedDaysThresholds: invalid }, salesSender)).ok, false);
  }
  assert.deepEqual(data.formalLayouts.sales.fbaEstimatedDaysThresholds, { short: '15', long: '90' }, '无效值不得覆盖保存的界限');
  await requestFrom({ type: 'LX_FORMAL_SAVE_LAYOUT', fieldIds: [fbaId] }, salesSender);
  assert.deepEqual(data.formalLayouts.sales.fbaEstimatedDaysThresholds, { short: '15', long: '90' }, '旧页面保存布局不擦除新阈值');
  assert.equal(data.formalLayouts.sales.fbaEstimatedDaysInitialized, true);
  await requestFrom({ type: 'LX_FORMAL_DELETE_FIELDS', fieldIds: [fbaId] }, salesSender);
  assert.equal((await requestFrom({ type: 'LX_FORMAL_GET_LIBRARY' }, salesSender)).data.fields.some((field) => field.id === fbaId), false, '用户删除内置字段后不得自动复活');

  assert.equal((await request({ type: "LX_FORMAL_CAPTURE", sourceKind: "listing", sourceLabel: "Listing", capture: { rows: [row] } })).ok, true);
  assert.deepEqual(data.formalDatasets.listing.rows[0].fields, { 库存: "10" });

  const sourceKind = "page@%2Ferp%2FproductExpressionNew";
  const started = await request({ type: "LX_FORMAL_BACKFILL_SOURCE", sourceKind, matchBy: 'asin', asins: ['B012345678'] });
  assert.equal(started.ok, true);
  assert.equal(started.temporarySource, true);
  assert.deepEqual(createdTabs, [{ id: 99, url: "https://example.lingxing.com/erp/productExpressionNew", active: false }]);
  const sourceSender = { tab: { id: 99, url: "https://example.lingxing.com/erp/productExpressionNew" } };
  assert.equal((await requestFrom({ type: 'LX_FORMAL_BACKFILL_SOURCE', sourceKind: 'sales', mskus: ['A'], dateRange: { start: '2026-10-19', end: '2026-10-19' } }, sourceSender)).ok, false, '来源工作页不能循环派生反向补查');
  assert.equal((await requestFrom({ type: "LX_FORMAL_SOURCE_READY" }, sourceSender)).pending, true);
  assert.ok(sentMessages.some(({ tabId, message }) => tabId === 99 && message.type === "LX_FORMAL_RUN_SOURCE_QUERY"));
  await requestFrom({ type: "LX_FORMAL_SOURCE_RESULT", result: { requestId: started.requestId, ok: true, requested: 1, matched: 1, unresolved: [] } }, sourceSender);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.deepEqual(removedTabs, [99]);

  existingSourceTab = { id: 22, url: "https://example.lingxing.com/erp/productExpressionNew", active: false };
  const reused = await request({ type: "LX_FORMAL_BACKFILL_SOURCE", sourceKind, matchBy: 'asin', asins: ['B012345678'] });
  assert.equal(reused.ok, true);
  assert.equal(reused.temporarySource, false);
  assert.equal(createdTabs.length, 1);
  assert.ok(sentMessages.some(({ tabId, message }) => tabId === 22 && message.type === "LX_FORMAL_RUN_SOURCE_QUERY"));
  await requestFrom({ type: "LX_FORMAL_SOURCE_RESULT", result: { requestId: reused.requestId, ok: true, requested: 1, matched: 1, unresolved: [] } }, { tab: existingSourceTab });
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.deepEqual(removedTabs, [99]);
  const dateRange = { start: "2026-10-03", end: "2026-10-12" };
  existingSourceTab = { id: 22, url: "https://example.lingxing.com/erp/mreport/salesStat", active: false };
  const dated = await request({ type: "LX_FORMAL_BACKFILL_SOURCE", sourceKind: "sales", matchBy: 'asin', asins: ['B012345678'], dateRange });
  assert.equal(dated.ok, true);
  assert.equal(dated.temporarySource, true, '销量来源页不应复用可能残留旧搜索的用户标签');
  assert.equal(createdTabs.length, 2);
  await requestFrom({ type: "LX_FORMAL_SOURCE_READY" }, { tab: { id: 99, url: "https://example.lingxing.com/erp/mreport/salesStat" } });
  assert.deepEqual(sentMessages.findLast(({ tabId, message }) => tabId === 99 && message.type === "LX_FORMAL_RUN_SOURCE_QUERY")?.message.dateRange, dateRange);
  await requestFrom({ type: "LX_FORMAL_SOURCE_RESULT", result: { requestId: dated.requestId, ok: true, requested: 1, matched: 1, unresolved: [] } }, { tab: { id: 99, url: "https://example.lingxing.com/erp/mreport/salesStat" } });
  assert.equal((await request({ type: "LX_FORMAL_BACKFILL_SOURCE", sourceKind: "sales", mskus: ["A"] })).ok, false);
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const detail = await requestFrom({ type: 'LX_FORMAL_TRANSIT_DETAIL_QUERY', identity: { msku: 'TEST-One-US', store: 'DEMO-US' } }, productSender);
  assert.equal(detail.ok, true);
  assert.equal(createdTabs.at(-1).url, 'https://example.lingxing.com/erp/msupply/fbaCargo');
  await requestFrom({ type: 'LX_FORMAL_SOURCE_READY' }, { tab: { id: 99, url: createdTabs.at(-1).url } });
  assert.ok(sentMessages.some(({ message }) => message.type === 'LX_FORMAL_RUN_TRANSIT_DETAIL_QUERY' && message.requestId === detail.requestId));
  await requestFrom({ type: 'LX_FORMAL_TRANSIT_DETAIL_RESULT', requestId: detail.requestId, result: {
    shipments: [{ shipmentId: 'FBA1', orderNumber: 'SP1', quantity: 28, shippedAt: '2026-09-24', arrivalAt: '2026-11-13' }], complete: true
  } }, { tab: { id: 99, url: createdTabs.at(-1).url } });
  assert.equal(sentMessages.findLast(({ message }) => message.type === 'LX_FORMAL_TRANSIT_DETAIL_RESULT')?.message.result.total, 28);
  assert.equal(removedTabs.at(-1), 99);
  delete globalThis.chrome;
});

test("销量统计补查与 FBA 货件查询使用不同后台页并独立返回", async () => {
  let onMessage;
  let nextTabId = 100;
  const createdTabs = [];
  const sentMessages = [];
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "1.4.33" }),
      onInstalled: { addListener() {} },
      onMessage: { addListener(listener) { onMessage = listener; } }
    },
    storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
    tabs: {
      async query() { return []; },
      async create(options) {
        const tab = { id: ++nextTabId, url: options.url, active: options.active };
        createdTabs.push(tab);
        return tab;
      },
      async sendMessage(tabId, message) {
        sentMessages.push({ tabId, message });
        if (/^LX_FORMAL_RUN_/.test(message.type)) return { ok: true };
        return null;
      },
      async remove() {}
    }
  };
  await import(`../background.js?parallel-query-test=${Date.now()}`);
  const requester = { tab: { id: 1, url: "https://example.lingxing.com/erp/productExpressionNew" } };
  const request = (message, sender = requester) => new Promise((resolve) => onMessage(message, sender, resolve));
  const sales = await request({ type: "LX_FORMAL_BACKFILL_SOURCE", sourceKind: "sales", mskus: ["TEST-One-US"], dateRange: { start: "2026-10-14", end: "2026-10-14" } });
  const transit = await request({ type: "LX_FORMAL_TRANSIT_DETAIL_QUERY", identity: { msku: "TEST-One-US", store: "DEMO-US" } });
  assert.equal(sales.ok, true);
  assert.equal(transit.ok, true);
  assert.equal(createdTabs.length, 2);
  assert.notEqual(createdTabs[0].id, createdTabs[1].id);
  assert.equal(new URL(createdTabs[0].url).pathname, "/erp/mreport/salesStat");
  assert.equal(new URL(createdTabs[1].url).pathname, "/erp/msupply/fbaCargo");
  await request({ type: "LX_FORMAL_SOURCE_READY" }, { tab: createdTabs[1] });
  await request({ type: "LX_FORMAL_SOURCE_READY" }, { tab: createdTabs[0] });
  assert.ok(sentMessages.some(({ tabId, message }) => tabId === createdTabs[0].id && message.type === "LX_FORMAL_RUN_SOURCE_QUERY" && message.requestId === sales.requestId));
  assert.ok(sentMessages.some(({ tabId, message }) => tabId === createdTabs[1].id && message.type === "LX_FORMAL_RUN_TRANSIT_DETAIL_QUERY" && message.requestId === transit.requestId));
  await request({ type: "LX_FORMAL_TRANSIT_DETAIL_RESULT", requestId: transit.requestId, result: { shipments: [], complete: true } }, { tab: createdTabs[1] });
  await request({ type: "LX_FORMAL_SOURCE_RESULT", result: { requestId: sales.requestId, ok: true, requested: 1, matched: 1, unresolved: [] } }, { tab: createdTabs[0] });
  assert.ok(sentMessages.some(({ tabId, message }) => tabId === requester.tab.id && message.type === "LX_FORMAL_TRANSIT_DETAIL_RESULT" && message.requestId === transit.requestId));
  assert.ok(sentMessages.some(({ tabId, message }) => tabId === requester.tab.id && message.type === "LX_FORMAL_SOURCE_RESULT" && message.result.requestId === sales.requestId));
  await new Promise((resolve) => setTimeout(resolve, 1300));
  delete globalThis.chrome;
});
