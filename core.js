export const PRODUCT_EXPRESSION_KIND = "page@%2Ferp%2FproductExpressionNew";
export const FBA_ESTIMATED_DAYS_FIELD = { id: `${PRODUCT_EXPRESSION_KIND}:FBA可售天数预估`, sourceKind: PRODUCT_EXPRESSION_KIND, label: "FBA可售天数预估", sourceLabel: "产品表现" };
export const SOURCE_LABELS = { listing: "Listing", sales: "销量统计", [PRODUCT_EXPRESSION_KIND]: "产品表现" };

export function sourceKindFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !(url.hostname === "lingxing.com" || url.hostname.endsWith(".lingxing.com"))) return null;
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/erp/listing") return "listing";
    if (path === "/erp/mreport/salesStat") return "sales";
    if (path.startsWith("/erp/") && path.length <= 220) return `page@${encodeURIComponent(path)}`;
  } catch {}
  return null;
}

export const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
export const normalizeMsku = (value) => clean(value).toUpperCase().replace(/[\u2010-\u2015\s-]+/g, "-");
export const normalizeAsin = (value) => /^[A-Z0-9]{10}$/.test(clean(value).toUpperCase()) ? clean(value).toUpperCase() : "";
export function dateRangeKey(range) {
  const start = String(range?.start || "");
  const end = String(range?.end || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end) && start <= end ? `${start}:${end}` : "";
}
const MARKETPLACE_SUFFIX = /[-\s](US|CA|UK|GB|DE|FR|IT|ES|JP|AU|MX|BR|NL|SE|PL|TR|IN|AE|SA|SG|BE|EU)$/i;
export const skuQueryFromMsku = (value) => clean(value).replace(MARKETPLACE_SUFFIX, "");

export function normalizeMarketplace(value) {
  const text = clean(value).toUpperCase().replace(/\s+/g, "");
  const aliases = {
    US: "US", USA: "US", 美国: "US", 美国站: "US",
    CA: "CA", CANADA: "CA", 加拿大: "CA", 加拿大站: "CA",
    UK: "UK", GB: "UK", 英国: "UK", 英国站: "UK",
    DE: "DE", GERMANY: "DE", 德国: "DE", 德国站: "DE",
    FR: "FR", FRANCE: "FR", 法国: "FR", 法国站: "FR",
    IT: "IT", ITALY: "IT", 意大利: "IT", 意大利站: "IT",
    ES: "ES", SPAIN: "ES", 西班牙: "ES", 西班牙站: "ES",
    JP: "JP", JAPAN: "JP", 日本: "JP", 日本站: "JP",
    AU: "AU", AUSTRALIA: "AU", 澳大利亚: "AU", 澳大利亚站: "AU"
  };
  return aliases[text] || text;
}

export function warehouseIdentity(value) {
  const text = clean(value);
  const store = text.match(/\b([A-Z0-9]{2,12}-(?:US|CA|UK|GB|DE|FR|IT|ES|JP|AU))\b/i)?.[1]?.toUpperCase() || "";
  const marketplace = store ? normalizeMarketplace(store.split("-").at(-1)) : normalizeMarketplace(text.replace(/仓库?|海外仓|FBA/gi, ""));
  return { store, marketplace };
}

function effectiveIdentity(row) {
  const warehouse = warehouseIdentity(row?.fields?.仓库);
  return {
    ...row?.identity,
    store: clean(row?.identity?.store) || warehouse.store,
    marketplace: clean(row?.identity?.marketplace) || warehouse.marketplace
  };
}

export function identityKey(identity) {
  const msku = clean(identity?.msku);
  if (!msku) return "";
  return JSON.stringify([clean(identity?.store), clean(identity?.marketplace), normalizeMsku(msku)]);
}

export function mergeRows(existing = [], incoming = [], limit = 1000) {
  const merged = [];
  for (const row of [...existing, ...incoming]) {
    const msku = clean(row?.identity?.msku);
    if (!msku) continue;
    const scope = row.dateScope || "";
    const compatibleAsin = (item) => !normalizeAsin(item.identity?.asin) || !normalizeAsin(row.identity?.asin) || normalizeAsin(item.identity.asin) === normalizeAsin(row.identity.asin);
    const exactIndex = merged.findIndex((item) => compatibleAsin(item) && (item.dateScope || "") === scope && identityKey(item.identity) === identityKey(row.identity));
    const sameMsku = merged.map((item, index) => ({ item, index })).filter(({ item }) => compatibleAsin(item) && (item.dateScope || "") === scope && normalizeMsku(item.identity?.msku) === normalizeMsku(msku));
    const rowHasContext = clean(row.identity?.store) && clean(row.identity?.marketplace);
    const compatible = sameMsku.length === 1 && (!rowHasContext || !clean(sameMsku[0].item.identity?.store) || !clean(sameMsku[0].item.identity?.marketplace)) ? sameMsku[0].index : -1;
    const index = exactIndex >= 0 ? exactIndex : compatible;
    if (index < 0) merged.push(row);
    else merged[index] = {
      dateScope: scope,
      identity: Object.fromEntries(["store", "marketplace", "msku", "sku", "asin"].map((key) => [key, clean(row.identity?.[key]) || clean(merged[index].identity?.[key])])),
      fields: { ...merged[index].fields, ...row.fields }
    };
  }
  return merged.slice(-limit);
}

export function fieldCatalog(rows = [], sourceKind) {
  const labels = new Set(rows.flatMap((row) => Object.keys(row.fields || {})));
  return [...labels].sort((a, b) => a.localeCompare(b, "zh-CN")).map((label) => ({
    id: `${sourceKind}:${label}`,
    sourceKind,
    label
  }));
}

export function withoutFields(rows = [], sourceKind, fieldIds = []) {
  const hidden = new Set(fieldIds);
  return rows.map((row) => ({
    ...row,
    fields: Object.fromEntries(Object.entries(row.fields || {}).filter(([label]) => !hidden.has(`${sourceKind}:${label}`)))
  }));
}

export function findMatchingRow(masterIdentity, rows = []) {
  const msku = clean(masterIdentity?.msku);
  if (!msku) return null;
  const exactCandidates = rows.filter((row) => clean(row.identity?.msku) === msku);
  const normalizedCandidates = exactCandidates.length ? exactCandidates : rows.filter((row) => normalizeMsku(row.identity?.msku) === normalizeMsku(msku));
  const candidates = normalizedCandidates.length === 1 || exactCandidates.length ? normalizedCandidates : [];
  const masterStore = clean(masterIdentity.store).toUpperCase();
  const masterMarketplace = normalizeMarketplace(masterIdentity.marketplace);
  const exact = candidates.filter((row) => {
    const identity = effectiveIdentity(row);
    return (!masterStore || clean(identity.store).toUpperCase() === masterStore) &&
      (!masterMarketplace || normalizeMarketplace(identity.marketplace) === masterMarketplace);
  });
  if (exact.length === 1) return exact[0];
  return candidates.length === 1 ? candidates[0] : null;
}

export function findAsinMatchingRow(identity, rows = [], label = "") {
  const asin = normalizeAsin(identity?.asin);
  if (!asin) return null;
  const store = clean(identity?.store).toUpperCase();
  const marketplace = normalizeMarketplace(identity?.marketplace);
  const candidates = rows.filter((row) => {
    const context = effectiveIdentity(row);
    return normalizeAsin(row.identity?.asin) === asin
      && (!store || clean(context.store).toUpperCase() === store)
      && (!marketplace || normalizeMarketplace(context.marketplace) === marketplace);
  });
  if (candidates.length === 1) return candidates[0];
  if (!label || !candidates.length) return null;
  const contexts = new Set(candidates.map((row) => {
    const context = effectiveIdentity(row);
    return JSON.stringify([clean(context.store).toUpperCase(), normalizeMarketplace(context.marketplace)]);
  }));
  const values = new Set(candidates.map((row) => clean(row.fields?.[label])));
  // 同 ASIN 多 MSKU 只在同一店铺/站点且目标字段完全一致时复用，不任取价格。
  return contexts.size === 1 && values.size === 1 && !values.has("") ? candidates[0] : null;
}

export function sanitizeCapture(capture, sourceKind) {
  const dateScope = dateRangeKey(capture?.dateRange);
  const rows = (Array.isArray(capture?.rows) ? capture.rows : []).slice(0, 300).map((row) => ({
    dateScope,
    identity: Object.fromEntries(["store", "marketplace", "msku", "sku", "asin"].map((key) => [key, clean(row.identity?.[key]).slice(0, 300)])),
    fields: Object.fromEntries(Object.entries(row.fields || {}).slice(0, 100).map(([key, value]) => [clean(key).slice(0, 160), clean(value).slice(0, 1000)]))
  })).filter((row) => row.identity.msku);
  return { sourceKind, rows, dateRange: dateScope ? { start: capture.dateRange.start, end: capture.dateRange.end } : null, capturedAt: new Date().toISOString() };
}
