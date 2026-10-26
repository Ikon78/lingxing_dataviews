(() => {
  "use strict";
  if (window.__LX_FORMAL_TRANSIT_NETWORK_HOOK__) return;
  window.__LX_FORMAL_TRANSIT_NETWORK_HOOK__ = true;

  const FIELD = "afn_inbound_shipped_quantity";
  const PAGES = ["/erp/productExpressionNew", "/erp/mreport/salesStat"];
  const CARGO_PAGE = "/erp/msupply/fbaCargo";
  let lastRows = [];
  let lastDateKey = "";
  let lastPage = "";
  let cargoQuery = null;
  const firstText = (object, keys) => keys.map((key) => object?.[key]).find((value) => typeof value === "string" && value.trim())?.trim() || "";
  const normalize = (value) => String(value || "").trim().toUpperCase().replace(/[\u2010-\u2015\s-]+/g, "-");
  function dateKey() {
    const editor = [...document.querySelectorAll(".el-date-editor--daterange")].find((node) => node.getBoundingClientRect().width > 0);
    const dates = editor?.querySelectorAll("input.el-range-input");
    const start = dates?.[0]?.value || "";
    const end = dates?.[1]?.value || "";
    return /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) ? `${start}:${end}` : "";
  }

  function extractRows(payload) {
    const found = new Map();
    let visited = 0;
    function walk(node, inherited, depth) {
      if (!node || typeof node !== "object" || depth > 14 || ++visited > 20_000) return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, inherited, depth + 1);
        return;
      }
      const identity = {
        msku: firstText(node, ["msku", "seller_sku", "sellerSku", "merchant_sku", "merchantSku", "msku_name"]) || inherited.msku,
        store: firstText(node, ["seller_name", "sellerName", "store_name", "shop_name", "store"] ) || inherited.store,
        asin: firstText(node, ["asin", "asin_code"]) || inherited.asin
      };
      const value = node[FIELD];
      if (identity.msku && value !== null && value !== undefined && /^\d+$/.test(String(value))) {
        const row = { ...identity, value: String(value) };
        found.set(`${normalize(row.msku)}|${row.store.toUpperCase()}|${row.asin.toUpperCase()}`, row);
      }
      for (const child of Object.values(node)) if (child && typeof child === "object") walk(child, identity, depth + 1);
    }
    walk(payload, { msku: "", store: "", asin: "" }, 0);
    return [...found.values()].slice(0, 500);
  }

  function publish(rows, scope = dateKey()) {
    const page = window.location.pathname.replace(/\/+$/, "");
    if (!PAGES.includes(page)) return;
    lastRows = rows;
    lastDateKey = scope;
    lastPage = page;
    window.postMessage({ type: "LX_FORMAL_TRANSIT_ROWS", rows, dateKey: scope }, window.location.origin);
  }

  const firstValue = (object, keys) => keys.map((key) => object?.[key]).find((value) => value !== null && value !== undefined && String(value).trim() !== "");
  const valueText = (object, keys) => String(firstValue(object, keys) ?? "").trim();
  function cargoRows(payload, target = "") {
    const found = new Map();
    let visited = 0;
    const aliases = {
      msku: ["msku", "seller_sku", "sellerSku", "merchant_sku", "merchantSku", "msku_name", "product_msku"],
      shipmentId: ["shipment_id", "shipmentId", "shipment_no", "shipmentNo", "shipment_code", "shipmentCode", "fba_shipment_id", "fbaShipmentId", "货件单号"],
      store: ["seller_name", "sellerName", "store_name", "storeName", "shop_name", "shopName", "store", "shop", "店铺"],
      status: ["shipment_status", "shipmentStatus", "status", "fba_status", "fbaStatus", "货件状态"],
      declared: ["declare_num", "declareNum", "declare_quantity", "declareQuantity", "declared_quantity", "declaredQuantity", "declare_qty", "declareQty", "declared", "report_num", "reportNum", "申报量"],
      received: ["receive_num", "receiveNum", "receive_quantity", "receiveQuantity", "received_quantity", "receivedQuantity", "received_qty", "receivedQty", "received", "sign_num", "signNum", "签收量"],
      orderNumber: ["delivery_no", "deliveryNo", "shipping_order_no", "shippingOrderNo", "order_no", "orderNo", "发货单号"],
      shippedAt: ["shipping_time", "shippingTime", "shipped_at", "shippedAt", "ship_time", "shipTime", "发货时间"],
      arrivalAt: ["arrival_time", "arrivalTime", "arrival_at", "arrivalAt", "estimated_arrival_time", "estimatedArrivalTime", "eta", "到货时间"],
      shippingMethod: ["shipping_method", "shippingMethod", "logistics_channel", "logisticsChannel", "transport_method", "transportMethod", "物流渠道", "运输方式"]
    };
    function walk(node, inherited, depth) {
      if (!node || typeof node !== "object" || depth > 14 || ++visited > 200_000) return;
      if (Array.isArray(node)) { for (const item of node) walk(item, inherited, depth + 1); return; }
      const context = { ...inherited };
      for (const [key, keys] of Object.entries(aliases)) {
        if (key === "status") continue;
        context[key] = valueText(node, keys) || context[key] || "";
      }
      // 子商品的通用 status 可能是商品状态，不能覆盖父货件的 SHIPPED 状态。
      context.status = valueText(node, ["shipment_status", "shipmentStatus", "fba_status", "fbaStatus", "货件状态"])
        || context.status || valueText(node, ["status"]);
      // 仅把同时包含完整 MSKU、货件号和申报/签收量的响应行作为单品数量；
      // 订单或整票货件级字段只能补日期/单号，不能冒充该产品的数量。
      if ((!target || normalize(context.msku) === target) && context.shipmentId && context.msku &&
          (firstValue(node, aliases.declared) !== undefined || firstValue(node, aliases.received) !== undefined)) {
        const row = { ...context, declared: valueText(node, aliases.declared), received: valueText(node, aliases.received) };
        found.set(`${row.shipmentId}|${normalize(row.msku)}|${row.store.toUpperCase()}`, row);
      }
      for (const child of Object.values(node)) if (child && typeof child === "object") walk(child, context, depth + 1);
    }
    walk(payload, {}, 0);
    return [...found.values()];
  }

  function cargoOrderRows(payload, wanted) {
    if (!wanted.size) return [];
    const found = new Map();
    let visited = 0;
    const pick = (node, keys) => valueText(node, keys);
    function walk(node, inherited, depth) {
      if (!node || typeof node !== "object" || depth > 12 || ++visited > 200_000) return;
      if (Array.isArray(node)) { for (const item of node) walk(item, inherited, depth + 1); return; }
      const shipmentId = pick(node, ["shipment_id", "shipmentId", "shipment_no", "shipmentNo", "shipment_code", "shipmentCode", "fba_shipment_id", "fbaShipmentId", "货件单号"]) || inherited;
      if (wanted.has(shipmentId)) {
        const row = {
          shipmentId,
          orderNumber: pick(node, ["delivery_no", "deliveryNo", "shipping_order_no", "shippingOrderNo", "order_no", "orderNo", "发货单号"]),
          shippedAt: pick(node, ["shipping_time", "shippingTime", "shipped_at", "shippedAt", "ship_time", "shipTime", "发货时间"]),
          arrivalAt: pick(node, ["arrival_time", "arrivalTime", "arrival_at", "arrivalAt", "estimated_arrival_time", "estimatedArrivalTime", "eta", "到货时间"]),
          shippingMethod: pick(node, ["shipping_method", "shippingMethod", "logistics_channel", "logisticsChannel", "transport_method", "transportMethod", "物流渠道", "运输方式"])
        };
        if (row.orderNumber || row.shippedAt || row.arrivalAt) found.set(shipmentId, { ...found.get(shipmentId), ...Object.fromEntries(Object.entries(row).filter(([, value]) => value)) });
      }
      for (const child of Object.values(node)) if (child && typeof child === "object") walk(child, shipmentId, depth + 1);
    }
    walk(payload, "", 0);
    return [...found.values()].slice(0, 500);
  }

  function cargoDiagnostic(reason, url = "") {
    if (!cargoQuery) return;
    const diagnostic = cargoQuery.diagnostic;
    diagnostic.lastReason = reason;
    try { diagnostic.lastPath = new URL(url || window.location.origin + window.location.pathname, window.location.origin).pathname.slice(0, 120); }
    catch { diagnostic.lastPath = "未知地址"; }
    window.postMessage({ type: "LX_FORMAL_CARGO_DIAGNOSTIC", requestId: cargoQuery.requestId, ...diagnostic }, window.location.origin);
  }

  function inspectCargo(body, url = "", status = 200, startedRequestId = "") {
    // 只接收监听启动后发起的请求；旧筛选的在途响应不能混进本次六个月快照。
    if (window.location.pathname.replace(/\/+$/, "") !== CARGO_PAGE || !cargoQuery || cargoQuery.requestId !== startedRequestId) return;
    cargoQuery.diagnostic.responses += 1;
    try {
      const pathname = new URL(url, window.location.origin).pathname;
      if (status >= 200 && status < 300 && /(?:\/fba\/|\/msupply\/|shipment|fbaCargo)/i.test(pathname)) cargoQuery.diagnostic.businessResponses += 1;
    } catch { /* 只影响诊断计数，不影响响应解析 */ }
    if (status < 200 || status >= 300) {
      cargoQuery.diagnostic.httpErrors += 1;
      cargoDiagnostic(`HTTP ${status}`, url);
      return;
    }
    try {
      if (typeof body === "string") {
        if (body.length > 50_000_000) { cargoDiagnostic("响应超过 50MB", url); return; }
        if (!/msku|seller_sku|merchant_sku/i.test(body) && !cargoQuery.shipmentIds.size) {
          cargoDiagnostic("响应未含 MSKU 字段", url);
          return;
        }
        body = JSON.parse(body);
      }
      if (!body || typeof body !== "object") { cargoDiagnostic("响应不是 JSON 对象", url); return; }
      cargoQuery.diagnostic.candidates += 1;
      const rows = cargoRows(body, cargoQuery.all ? "" : cargoQuery.msku);
      for (const row of rows) cargoQuery.shipmentIds.add(row.shipmentId);
      const orderRows = cargoOrderRows(body, cargoQuery.shipmentIds);
      cargoQuery.diagnostic.productRows += rows.length;
      cargoQuery.diagnostic.orderRows += orderRows.length;
      cargoDiagnostic(rows.length || orderRows.length ? `产品 ${rows.length} 行、发货单 ${orderRows.length} 行` : "候选 JSON 未解析出货件行", url);
      if (!rows.length && !orderRows.length) return;
      const total = Number(firstValue(body?.data, ["total", "totalCount", "count"]) ?? firstValue(body, ["total", "totalCount", "count"]));
      window.postMessage({ type: "LX_FORMAL_CARGO_ROWS", requestId: cargoQuery.requestId, rows, orderRows,
        totalCount: Number.isSafeInteger(total) && total > 0 ? total : 0 }, window.location.origin);
    } catch (error) {
      cargoQuery.diagnostic.parseErrors += 1;
      cargoDiagnostic(error instanceof SyntaxError ? "JSON 解析失败" : `货件字段解析失败：${String(error?.message || error).slice(0, 60)}`, url);
    }
  }

  const reportContext = () => ({ page: window.location.pathname.replace(/\/+$/, ''), dateKey: dateKey() });

  function inspect(body, url = "", status = 200, startedRequestId = "", report = null) {
    if (window.location.pathname.replace(/\/+$/, "") === CARGO_PAGE) { inspectCargo(body, url, status, startedRequestId); return; }
    if (!PAGES.includes(window.location.pathname.replace(/\/+$/, ""))) return;
    if (!report || report.page !== window.location.pathname.replace(/\/+$/, '') || report.dateKey !== dateKey()) return;
    if (status < 200 || status >= 300) return;
    try {
      if (typeof body === "string") {
        if (body.length > 8_000_000 || !body.includes(FIELD)) return;
        body = JSON.parse(body);
      }
      if (!body || typeof body !== "object") return;
      const rows = extractRows(body);
      if (rows.length) publish(rows, report.dateKey);
    } catch { /* 不是目标 JSON 响应时保持领星原有请求行为。 */ }
  }

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    const startedRequestId = cargoQuery?.requestId || "";
    const report = reportContext();
    this.addEventListener("loadend", () => {
      try {
        inspect(this.status >= 200 && this.status < 300 ? (this.responseType === "json" ? this.response : this.responseText) : null, this.responseURL, this.status, startedRequestId, report);
      } catch { /* 部分 responseType 不允许读取 responseText。 */ }
    }, { once: true });
    return originalSend.apply(this, args);
  };

  if (typeof window.fetch === "function") {
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
      const startedRequestId = cargoQuery?.requestId || "";
      const report = reportContext();
      return originalFetch.apply(this, args).then((response) => {
        try {
          if (response.ok) response.clone().text().then((body) => inspect(body, response.url, response.status, startedRequestId, report)).catch(() => {});
          else inspect(null, response.url, response.status, startedRequestId, report);
        } catch { /* 不支持克隆的响应不影响页面。 */ }
        return response;
      });
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.type === "LX_FORMAL_TRANSIT_REQUEST" && lastRows.length && lastPage === window.location.pathname.replace(/\/+$/, "")) publish(lastRows, lastDateKey);
    if (window.location.pathname.replace(/\/+$/, "") !== CARGO_PAGE) return;
    if (event.data?.type === "LX_FORMAL_CARGO_QUERY_START") {
      const msku = normalize(event.data.msku).slice(0, 150);
      const requestId = String(event.data.requestId || "").slice(0, 100);
      if ((msku || event.data.all === true) && requestId) {
        cargoQuery = { msku, all: event.data.all === true, requestId, shipmentIds: new Set(),
          diagnostic: { responses: 0, businessResponses: 0, candidates: 0, productRows: 0, orderRows: 0, parseErrors: 0, httpErrors: 0, lastPath: "", lastReason: "监听已启动，等待响应" } };
        window.postMessage({ type: "LX_FORMAL_CARGO_QUERY_STARTED", requestId }, window.location.origin);
        cargoDiagnostic("监听已启动，等待响应");
      }
    }
    if (event.data?.type === "LX_FORMAL_CARGO_SHIPMENTS" && cargoQuery?.requestId === event.data.requestId) {
      for (const id of Array.isArray(event.data.shipmentIds) ? event.data.shipmentIds.slice(0, 500) : []) {
        if (typeof id === "string" && id.length <= 100) cargoQuery.shipmentIds.add(id);
      }
    }
    if (event.data?.type === "LX_FORMAL_CARGO_QUERY_STOP" && cargoQuery?.requestId === event.data.requestId) cargoQuery = null;
  });
})();
