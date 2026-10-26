import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../page-network.js", import.meta.url), "utf8");

function setup(pathname = "/erp/productExpressionNew") {
  const messages = [];
  const listeners = new Map();
  const window = {
    location: { pathname, origin: "https://example.lingxing.com" },
    postMessage(message) { messages.push(message); },
    addEventListener(type, listener) { listeners.set(type, listener); }
  };
  class FakeXHR {
    status = 200;
    responseType = "";
    responseText = "";
    listeners = new Map();
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    send() { if (!this.defer) this.complete(); }
    complete() { this.listeners.get("loadend")?.(); }
  }
  vm.runInNewContext(source, { window, XMLHttpRequest: FakeXHR, URL, document: { querySelectorAll: () => [] } });
  return { FakeXHR, messages, listeners, window };
}

test("从同页网络响应提取 MSKU 对应的标发在途，保留 0 值", () => {
  const { FakeXHR, messages } = setup();
  const xhr = new FakeXHR();
  xhr.responseText = JSON.stringify({ data: { list: [
    { msku: "TEST-One-US", seller_name: "DEMO-US", asin: "B000000001", seller_info: { afn_inbound_shipped_quantity: 98 } },
    { msku: "TEST-Two-US", seller_name: "DEMO-US", seller_info: { afn_inbound_shipped_quantity: 0 } }
  ] } });
  xhr.send();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "LX_FORMAL_TRANSIT_ROWS");
  assert.deepEqual(Array.from(messages[0].rows, (row) => [row.msku, row.value]), [["TEST-One-US", "98"], ["TEST-Two-US", "0"]]);
});

test("没有 MSKU 的汇总值不写入行；其他页面不发布", () => {
  const first = setup();
  const xhr = new first.FakeXHR();
  xhr.responseText = JSON.stringify({ data: { afn_inbound_shipped_quantity: 15 } });
  xhr.send();
  assert.equal(first.messages.length, 0);
  const other = setup("/erp/listing");
  const next = new other.FakeXHR();
  next.responseText = JSON.stringify({ msku: "TEST-One-US", afn_inbound_shipped_quantity: 15 });
  next.send();
  assert.equal(other.messages.length, 0);
});

test('销量页也读取相同标发在途字段，路由切换不重放另一页的旧数量', () => {
  const { FakeXHR, messages, listeners, window } = setup('/erp/mreport/salesStat');
  const xhr = new FakeXHR();
  xhr.responseText = JSON.stringify({ data: [{ msku: 'A-US', seller_name: 'DEMO-US', seller_info: { afn_inbound_shipped_quantity: 0 } }] });
  xhr.send();
  assert.equal(messages[0].rows[0].value, '0');
  window.location.pathname = '/erp/productExpressionNew';
  listeners.get('message')({ source: window, origin: window.location.origin, data: { type: 'LX_FORMAL_TRANSIT_REQUEST' } });
  assert.equal(messages.length, 1, '不把销量页旧响应当作产品表现当前数量');
});

test('产品表现请求晚于切换销量页才返回时，不把旧响应发布成销量库存', () => {
  const { FakeXHR, messages, window } = setup();
  const xhr = new FakeXHR();
  xhr.defer = true;
  xhr.responseText = JSON.stringify({ msku: 'A-US', seller_name: 'DEMO-US', afn_inbound_shipped_quantity: 99 });
  xhr.send();
  window.location.pathname = '/erp/mreport/salesStat';
  xhr.complete();
  assert.equal(messages.length, 0);
});

test("FBA 货件网络响应仅解析当前 MSKU 的单品申报与签收量", () => {
  const { FakeXHR, messages, listeners, window } = setup("/erp/msupply/fbaCargo");
  listeners.get("message")({ source: window, origin: window.location.origin, data: { type: "LX_FORMAL_CARGO_QUERY_START", requestId: "q1", msku: "TEST One US" } });
  assert.equal(messages.find((message) => message.type === "LX_FORMAL_CARGO_QUERY_STARTED")?.requestId, "q1");
  const xhr = new FakeXHR();
  xhr.responseText = JSON.stringify({ data: { total: 2, list: [
    { shipment_id: "FBA1", shipment_status: "SHIPPED", seller_name: "DEMO-US", products: [
      { msku: "TEST-One-US", declare_num: 30, receive_num: 2, delivery_no: "SP1", shipping_time: "2026-09-20", arrival_time: "2026-10-15" },
      { msku: "OTHER-US", declare_num: 90, receive_num: 0 }
    ] },
    { shipment_id: "FBA2", shipment_status: "RECEIVING", seller_name: "DEMO-US", products: [
      { msku: "TEST-One-US", declare_num: 40, receive_num: 10 }
    ] }
  ] } });
  xhr.send();
  const packet = messages.find((message) => message.type === "LX_FORMAL_CARGO_ROWS");
  const diagnostic = messages.filter((message) => message.type === "LX_FORMAL_CARGO_DIAGNOSTIC").at(-1);
  assert.equal(packet.requestId, "q1");
  assert.equal(packet.totalCount, 2);
  assert.equal(diagnostic.responses, 1);
  assert.equal(diagnostic.candidates, 1);
  assert.equal(diagnostic.productRows, 2);
  assert.deepEqual(Array.from(packet.rows, (row) => [row.shipmentId, row.msku, row.declared, row.received, row.status]), [
    ["FBA1", "TEST-One-US", "30", "2", "SHIPPED"], ["FBA2", "TEST-One-US", "40", "10", "RECEIVING"]
  ]);
  const order = new FakeXHR();
  order.responseText = JSON.stringify({ data: { list: [{ shipment_id: "FBA1", delivery_no: "SP1", shipping_time: "2026-09-20", arrival_time: "2026-10-15" }] } });
  order.send();
  const orderPacket = messages.filter((message) => message.type === "LX_FORMAL_CARGO_ROWS").at(-1);
  assert.deepEqual(Array.from(orderPacket.orderRows, (row) => [row.shipmentId, row.orderNumber, row.arrivalAt]), [["FBA1", "SP1", "2026-10-15"]]);
});

test("FBA 货件整表模式从同一包提取不同 MSKU，并保留货件状态供精确筛选", () => {
  const { FakeXHR, messages, listeners, window } = setup("/erp/msupply/fbaCargo");
  listeners.get("message")({ source: window, origin: window.location.origin, data: { type: "LX_FORMAL_CARGO_QUERY_START", requestId: "bulk", all: true } });
  const xhr = new FakeXHR();
  xhr.responseText = JSON.stringify({ data: { total: 501, list: [
    { shipment_id: "FBA1", shipment_status: "SHIPPED", seller_name: "DEMO-US", products: [
      { msku: "TEST-One-US", declare_num: 30, receive_num: 2 },
      { msku: "TEST-Two-US", declare_num: 12, receive_num: 0 }
    ] },
    { shipment_id: "FBA2", shipment_status: "RECEIVING", seller_name: "DEMO-US", products: [
      { msku: "TEST-Three-US", declare_num: 8, receive_num: 3 }
    ] }
  ] } });
  xhr.send();
  const packet = messages.find((message) => message.type === "LX_FORMAL_CARGO_ROWS");
  assert.equal(packet.totalCount, 501);
  assert.deepEqual(Array.from(packet.rows, (row) => [row.msku, row.status]), [
    ["TEST-One-US", "SHIPPED"], ["TEST-Two-US", "SHIPPED"], ["TEST-Three-US", "RECEIVING"]
  ]);
});

test("货件响应未带 MSKU 时只上报抓包计数及过滤原因，不伪造数据行", () => {
  const { FakeXHR, messages, listeners, window } = setup("/erp/msupply/fbaCargo");
  listeners.get("message")({ source: window, origin: window.location.origin, data: { type: "LX_FORMAL_CARGO_QUERY_START", requestId: "diag", all: true } });
  const xhr = new FakeXHR();
  xhr.responseURL = "https://example.lingxing.com/api/fba/list?token=REDACTED_TEST_VALUE";
  xhr.responseText = JSON.stringify({ data: { list: [{ shipment_id: "FBA1", status: "SHIPPED" }] } });
  xhr.send();
  const diagnostic = messages.filter((message) => message.type === "LX_FORMAL_CARGO_DIAGNOSTIC").at(-1);
  assert.equal(diagnostic.responses, 1);
  assert.equal(diagnostic.businessResponses, 1);
  assert.equal(diagnostic.candidates, 0);
  assert.equal(diagnostic.lastPath, "/api/fba/list");
  assert.match(diagnostic.lastReason, /未含 MSKU/);
  assert.equal(messages.filter((message) => message.type === "LX_FORMAL_CARGO_ROWS").length, 0);
  const analytics = new FakeXHR();
  analytics.responseURL = 'https://example.lingxing.com/sa.gif';
  analytics.responseText = '';
  analytics.send();
  assert.equal(messages.filter((message) => message.type === "LX_FORMAL_CARGO_DIAGNOSTIC").at(-1).businessResponses, 1);
});

test("启动监听前已经发出的旧货件响应不混入本次扫描", () => {
  const { FakeXHR, messages, listeners, window } = setup("/erp/msupply/fbaCargo");
  const oldRequest = new FakeXHR();
  oldRequest.defer = true;
  oldRequest.responseText = JSON.stringify({ data: { list: [{ shipment_id: "OLD", shipment_status: "SHIPPED", msku: "OLD-US", declare_num: 10, receive_num: 0 }] } });
  oldRequest.send();
  listeners.get("message")({ source: window, origin: window.location.origin, data: { type: "LX_FORMAL_CARGO_QUERY_START", requestId: "fresh", all: true } });
  oldRequest.complete();
  assert.equal(messages.filter((message) => message.type === "LX_FORMAL_CARGO_ROWS").length, 0);
  const freshRequest = new FakeXHR();
  freshRequest.responseText = JSON.stringify({ data: { list: [{ shipment_id: "FRESH", shipment_status: "SHIPPED", msku: "NEW-US", declare_num: 8, receive_num: 1 }] } });
  freshRequest.send();
  assert.equal(messages.filter((message) => message.type === "LX_FORMAL_CARGO_ROWS").at(-1)?.rows[0].shipmentId, "FRESH");
});
