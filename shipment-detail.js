(() => {
  "use strict";
  const text = (value) => String(value ?? "").replace(/[\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").trim();
  const sku = (value) => text(value).toUpperCase().replace(/[\u2010-\u2015\s-]+/g, "-");
  const number = (value) => {
    const raw = text(value).replace(/,/g, "");
    return /^\d+$/.test(raw) ? Number(raw) : null;
  };
  const date = (value) => {
    const match = text(value).match(/\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?/);
    return match?.[0] || "";
  };
  const exactStatus = (value) => text(value).toUpperCase() === "SHIPPED";
  const shippingDays = (value) => {
    const method = text(value);
    const days = new Set([/普船|铁路/.test(method) ? 60 : null, /加班船/.test(method) ? 30 : null,
      /空派/.test(method) ? 14 : null].filter((value) => value !== null));
    // 多种互相冲突的渠道不能随意选择其中一个日期。
    return days.size === 1 ? [...days][0] : null;
  };
  const plusDays = (value, days) => {
    const day = date(value).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || days === null) return "";
    const stamp = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(stamp.getTime())) return "";
    stamp.setUTCDate(stamp.getUTCDate() + days);
    return stamp.toISOString().slice(0, 10);
  };
  const arrivalDay = (row) => {
    const site = text(row.store).toUpperCase().match(/-([A-Z]{2})$/)?.[1] || "";
    if (site === "US" || site === "MX") return date(row.arrivalAt).slice(0, 10);
    if (site) return plusDays(row.shippedAt, shippingDays(row.shippingMethod));
    return "";
  };
  function groupByDate(shipments) {
    const groups = new Map();
    for (const row of shipments || []) {
      const key = text(row.arrivalDay);
      const group = groups.get(key) || { arrivalDay: key, shipmentCount: 0, quantity: 0, orderNumbers: [], shippedAts: [], shipmentIds: [] };
      group.shipmentCount += 1;
      group.quantity += Number(row.quantity) || 0;
      if (row.orderNumber) group.orderNumbers.push(row.orderNumber);
      if (row.shippedAt) group.shippedAts.push(row.shippedAt);
      group.shipmentIds.push(row.shipmentId);
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => (a.arrivalDay || "9999").localeCompare(b.arrivalDay || "9999"));
  }
  function fromRows(rows, identity, totalCount = rows.length) {
    const wantedSku = sku(identity?.msku);
    const wantedStore = text(identity?.store).toUpperCase();
    const byShipment = new Map();
    let invalidQuantity = false;
    for (const row of rows || []) {
      if (!exactStatus(row.status) || sku(row.msku) !== wantedSku) continue;
      if (wantedStore && text(row.store).toUpperCase() !== wantedStore) continue;
      const declared = number(row.declared);
      const received = number(row.received);
      if (declared === null || received === null || !text(row.shipmentId)) { invalidQuantity = true; continue; }
      const quantity = declared - received;
      const key = `${text(row.shipmentId)}|${sku(row.msku)}|${text(row.store).toUpperCase()}`;
      byShipment.set(key, {
        shipmentId: text(row.shipmentId), orderNumber: text(row.orderNumber), quantity,
        shippedAt: date(row.shippedAt), arrivalAt: date(row.arrivalAt),
        arrivalDay: arrivalDay(row), shippingMethod: text(row.shippingMethod),
        arrivalWindow: text(row.arrivalWindow)
      });
    }
    const shipments = [...byShipment.values()].sort((a, b) => {
      const left = a.arrivalDay || "9999";
      const right = b.arrivalDay || "9999";
      return left.localeCompare(right) || a.shipmentId.localeCompare(b.shipmentId);
    });
    const loadedShipments = new Set((rows || []).map((row) => text(row.shipmentId)).filter(Boolean)).size;
    return { shipments, groups: groupByDate(shipments), total: shipments.reduce((sum, row) => sum + row.quantity, 0), complete: !invalidQuantity && Number(totalCount) > 0 && loadedShipments >= Number(totalCount) };
  }
  globalThis.LXShipmentDetail = { fromRows, groupByDate, number, date, sku, plusDays, arrivalDay };
})();
