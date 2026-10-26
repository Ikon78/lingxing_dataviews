import { clean, normalizeAsin, dateRangeKey, fieldCatalog, mergeRows, sanitizeCapture, sourceKindFromUrl, withoutFields, FBA_ESTIMATED_DAYS_FIELD } from "./core.js";

const pendingSourceQueries = new Map();
const pendingSourceReadyByTab = new Map();
const SOURCE_PENDING_KEY = 'formalSourcePendingQueries';
let sourceStateRestored = false;
let restoringSourceState = null;
let sourceStateWrite = Promise.resolve();
const pendingTransitDetails = new Map();
const pendingTransitReadyByTab = new Map();
const CARGO_SNAPSHOT_KEY = 'formalCargoSessionSnapshot';
const CARGO_MSKU_KEY = 'formalCargoMskuSession';
const CARGO_PENDING_KEY = 'formalCargoPendingScan';
let pendingCargoSnapshot = null;
let restoringCargoScan = null;
let cargoStateWrite = Promise.resolve();
let libraryWrite = Promise.resolve();

function armCargoTimeout(scan) {
  clearTimeout(scan.timeoutId);
  scan.deadline ||= Date.now() + 480_000;
  scan.timeoutId = setTimeout(() => finishCargoSnapshot(scan, '整表抓取超过 480 秒，未缓存不完整数据'), Math.max(1, scan.deadline - Date.now()));
}
async function persistCargoScan(scan) {
  if (!chrome.storage.session || pendingCargoSnapshot !== scan) return;
  // 后台 Worker 会被浏览器回收；仅把小型任务登记写入会话存储，不把半成品当快照。
  const saved = { scanId: scan.scanId, sourceTabId: scan.sourceTabId, requesterTabId: scan.requesterTabId,
    waiters: [...scan.waiters], deadline: scan.deadline, started: Boolean(scan.started), focusedSource: Boolean(scan.focusedSource),
    stage: scan.stage || '', diagnosticText: scan.diagnosticText || '' };
  cargoStateWrite = cargoStateWrite.catch(() => {}).then(() => chrome.storage.session.set({ [CARGO_PENDING_KEY]: saved }));
  await cargoStateWrite;
}
async function currentCargoScan() {
  if (pendingCargoSnapshot || !chrome.storage.session) return pendingCargoSnapshot;
  if (!restoringCargoScan) restoringCargoScan = (async () => {
    await cargoStateWrite;
    const saved = (await chrome.storage.session.get(CARGO_PENDING_KEY))[CARGO_PENDING_KEY];
    if (!saved?.scanId || !Number.isInteger(saved.sourceTabId) || !Array.isArray(saved.waiters)) return null;
    const scan = { ...saved, waiters: new Map(saved.waiters), timeoutId: null };
    pendingCargoSnapshot = scan;
    armCargoTimeout(scan);
    if (Date.now() >= scan.deadline) { await finishCargoSnapshot(scan, '整表抓取超过 480 秒，未缓存不完整数据'); return null; }
    return scan;
  })().finally(() => { restoringCargoScan = null; });
  return restoringCargoScan;
}

const cargoSku = (value) => clean(value).toUpperCase().replace(/[\u2010-\u2015\s-]+/g, '-');
const cargoIdentityKey = (identity) => `${cargoSku(identity.msku)}|${clean(identity.store).toUpperCase()}`;
async function cargoMskuCache() {
  if (!chrome.storage.session) return {};
  const stored = (await chrome.storage.session.get(CARGO_MSKU_KEY))[CARGO_MSKU_KEY];
  return stored && new Date(stored.capturedAt).toDateString() === new Date().toDateString() ? stored.results || {} : {};
}
async function cargoProgress(scan, stage, diagnosticText = '', options = {}) {
  if (stage && !options.telemetryOnly) scan.stage = clean(stage).slice(0, 200);
  if (diagnosticText) scan.diagnosticText = clean(diagnosticText).slice(0, 300);
  await persistCargoScan(scan);
  await Promise.allSettled([...scan.waiters].map(([requestId, waiter]) => chrome.tabs.sendMessage(waiter.tabId, {
    type: 'LX_FORMAL_TRANSIT_DETAIL_PROGRESS', requestId, stage: scan.stage || '',
    diagnosticText: scan.diagnosticText || '', telemetryOnly: options.telemetryOnly === true
  })));
}
function cargoRowsFor(snapshot, identity) {
  const wantedSku = cargoSku(identity.msku);
  const wantedStore = clean(identity.store).toUpperCase();
  return (snapshot.rows || []).filter((row) => cargoSku(row.msku) === wantedSku && (!wantedStore || clean(row.store).toUpperCase() === wantedStore));
}

async function cargoSessionSnapshot() {
  if (!chrome.storage.session) return null;
  const stored = await chrome.storage.session.get(CARGO_SNAPSHOT_KEY);
  const snapshot = stored[CARGO_SNAPSHOT_KEY];
  if (snapshot?.complete !== true) return null;
  if (new Date(snapshot.capturedAt).toDateString() === new Date().toDateString()) return snapshot;
  await chrome.storage.session.remove(CARGO_SNAPSHOT_KEY);
  return null;
}

async function finishCargoSnapshot(scan, error, snapshot = null) {
  if (pendingCargoSnapshot !== scan) return;
  pendingCargoSnapshot = null;
  clearTimeout(scan.timeoutId);
  if (chrome.storage.session) {
    cargoStateWrite = cargoStateWrite.catch(() => {}).then(() => chrome.storage.session.remove(CARGO_PENDING_KEY));
    await cargoStateWrite;
  }
  if (snapshot?.complete && chrome.storage.session) {
    try { await chrome.storage.session.set({ [CARGO_SNAPSHOT_KEY]: snapshot }); }
    catch (storageError) { error = `整表已抓取，但会话缓存写入失败：${storageError?.message || storageError}`; snapshot = null; }
  }
  for (const [requestId, waiter] of scan.waiters) {
    await chrome.tabs.sendMessage(waiter.tabId, {
      type: 'LX_FORMAL_CARGO_SNAPSHOT_ROWS', requestId, identity: waiter.identity,
      rows: snapshot ? cargoRowsFor(snapshot, waiter.identity) : [], complete: snapshot?.complete === true,
      scope: snapshot?.scope || '', error: clean(error).slice(0, 600)
    }).catch(() => {});
  }
  if (scan.focusedSource) {
    const source = await chrome.tabs.get(scan.sourceTabId).catch(() => null);
    if (source?.active) await chrome.tabs.update(scan.requesterTabId, { active: true }).catch(() => {});
  }
  chrome.tabs.remove(scan.sourceTabId).catch(() => {});
}

async function restoreTransitRequester(pending) {
  if (!pending?.focusedSource) return;
  const source = await chrome.tabs.get(pending.sourceTabId).catch(() => null);
  // 用户若已自行切到别的标签，不要抢回焦点。
  if (source?.active) await chrome.tabs.update(pending.requesterTabId, { active: true }).catch(() => {});
}

async function restoreSourceRequester(pending) {
  if (!pending?.focusedSource) return;
  const source = await chrome.tabs.get(pending.sourceTabId).catch(() => null);
  if (source?.active) await chrome.tabs.update(pending.requesterTabId, { active: true }).catch(() => {});
}

async function persistSourceQueries() {
  if (!chrome.storage.session) return;
  const saved = [...pendingSourceQueries.values()].map(({ timeoutId, ...pending }) => ({ ...pending }));
  sourceStateWrite = sourceStateWrite.catch(() => {}).then(() => chrome.storage.session.set({ [SOURCE_PENDING_KEY]: saved }));
  await sourceStateWrite;
}

async function finishSourceQuery(pending, result) {
  if (pendingSourceQueries.get(pending.requestId) !== pending) return;
  pendingSourceQueries.delete(pending.requestId);
  clearTimeout(pending.timeoutId);
  const waiting = pendingSourceReadyByTab.get(pending.sourceTabId);
  if (waiting?.requestId === pending.requestId) pendingSourceReadyByTab.delete(pending.sourceTabId);
  await persistSourceQueries();
  if (pending.requesterTabId) await chrome.tabs.sendMessage(pending.requesterTabId, {
    type: 'LX_FORMAL_SOURCE_RESULT', result: {
      requestId: pending.requestId, sourceKind: pending.sourceKind, ok: result.ok === true,
      requested: Math.max(0, Math.min(20, Number(result.requested) || pending.mskus.length)),
      matched: Math.max(0, Math.min(20, Number(result.matched) || 0)),
      unresolved: (Array.isArray(result.unresolved) ? result.unresolved : pending.mskus).map((value) => String(value).slice(0, 300)).slice(0, 20),
      error: String(result.error || '').slice(0, 300), note: String(result.note || '').slice(0, 300)
    }
  }).catch(() => {});
  await restoreSourceRequester(pending);
  if (pending.temporarySourceTab) setTimeout(() => chrome.tabs.remove(pending.sourceTabId).catch(() => {}), 1200);
}

function armSourceTimeout(pending) {
  clearTimeout(pending.timeoutId);
  const due = pending.started ? pending.deadline : Math.min(pending.deadline, pending.readyDeadline);
  pending.timeoutId = setTimeout(() => finishSourceQuery(pending, { ok: false,
    error: pending.started ? '来源页补查 70 秒无结果，已停止等待' : '后台来源页 25 秒内未就绪，请检查登录状态'
  }), Math.max(1, due - Date.now()));
}

async function currentSourceQueries() {
  if (sourceStateRestored || !chrome.storage.session) return;
  if (!restoringSourceState) restoringSourceState = (async () => {
    await sourceStateWrite;
    const saved = (await chrome.storage.session.get(SOURCE_PENDING_KEY))[SOURCE_PENDING_KEY];
    for (const pending of Array.isArray(saved) ? saved.slice(0, 30) : []) {
      if (!pending?.requestId || !Number.isInteger(pending.sourceTabId) || !Number.isFinite(pending.deadline) || !Array.isArray(pending.mskus)) continue;
      pendingSourceQueries.set(pending.requestId, pending);
      if (!pending.started) pendingSourceReadyByTab.set(pending.sourceTabId, { requestId: pending.requestId });
      armSourceTimeout(pending);
    }
    sourceStateRestored = true;
  })().finally(() => { restoringSourceState = null; });
  await restoringSourceState;
}

function serializeLibraryWrite(work) {
  const next = libraryWrite.then(work);
  libraryWrite = next.catch(() => {});
  return next;
}

function validFieldId(fieldId) {
  if (typeof fieldId !== "string" || fieldId.length > 500) return false;
  const separator = fieldId.indexOf(":");
  const sourceKind = fieldId.slice(0, separator);
  return separator > 0 && (sourceKind === "listing" || sourceKind === "sales" || sourceKind.startsWith("page@")) && Boolean(fieldId.slice(separator + 1));
}

async function dispatchSourceQuery(tabId, requestId, mskus, dateRange, fieldLabels = [], matchBy = 'msku') {
  const response = await chrome.tabs.sendMessage(tabId, { type: "LX_FORMAL_RUN_SOURCE_QUERY", requestId, matchBy, ...(matchBy === 'asin' ? { asins: mskus } : { mskus }), dateRange, fieldLabels });
  if (!response?.ok) throw new Error("来源页未确认启动补查");
}

function sourceUrlForKind(sourceKind, currentUrl) {
  const origin = new URL(currentUrl).origin;
  if (sourceKind === "listing") return `${origin}/erp/listing`;
  if (sourceKind === "sales") return `${origin}/erp/mreport/salesStat`;
  if (sourceKind.startsWith("page@")) {
    const path = decodeURIComponent(sourceKind.slice(5));
    if (path.startsWith("/erp/") && path.length <= 220) return `${origin}${path}`;
  }
  throw new Error("无法确定字段来源页地址");
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
  chrome.storage.session?.remove(CARGO_SNAPSHOT_KEY).catch(() => {});
  chrome.storage.session?.remove(CARGO_MSKU_KEY).catch(() => {});
  chrome.storage.session?.remove(CARGO_PENDING_KEY).catch(() => {});
  chrome.storage.session?.remove(SOURCE_PENDING_KEY).catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => {
  chrome.storage.session?.remove(CARGO_SNAPSHOT_KEY).catch(() => {});
  chrome.storage.session?.remove(CARGO_MSKU_KEY).catch(() => {});
  chrome.storage.session?.remove(CARGO_PENDING_KEY).catch(() => {});
  chrome.storage.session?.remove(SOURCE_PENDING_KEY).catch(() => {});
});

async function notifyPages(sourceKind, excludeTabId, recapture = false) {
  const tabs = await chrome.tabs.query({ url: "https://*.lingxing.com/erp/*" });
  await Promise.allSettled(tabs.filter((tab) => tab.id && tab.id !== excludeTabId).map((tab) =>
    chrome.tabs.sendMessage(tab.id, { type: "LX_FORMAL_LIBRARY_UPDATED", sourceKind, recapture })
  ));
}

async function libraryPayload(targetKind) {
  const stored = await chrome.storage.local.get(["formalDatasets", "formalLayouts", "formalHiddenFields"]);
  const datasets = stored.formalDatasets || {};
  const hiddenFields = Array.isArray(stored.formalHiddenFields) ? stored.formalHiddenFields : [];
  const hidden = new Set(hiddenFields);
  const fields = Object.entries(datasets).flatMap(([sourceKind, dataset]) => fieldCatalog(dataset.rows || [], sourceKind).map((field) => ({ ...field, sourceLabel: dataset.label || "" }))).filter((field) => !hidden.has(field.id));
  // 先登记明确请求的内置跨页列，未采集过产品表现时也能启动自动补查。
  if (!hidden.has(FBA_ESTIMATED_DAYS_FIELD.id) && !fields.some((field) => field.id === FBA_ESTIMATED_DAYS_FIELD.id)) fields.push({ ...FBA_ESTIMATED_DAYS_FIELD });
  return {
    datasets,
    fields,
    hiddenFields,
    layout: stored.formalLayouts?.[targetKind] || { fieldIds: [], panel: { x: null, y: 88 } }
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const pageKind = sourceKindFromUrl(sender.tab?.url);
    if (message?.type === "LX_FORMAL_CLEAR") {
      await serializeLibraryWrite(() => chrome.storage.local.remove(["formalDatasets", "formalLayouts", "formalHiddenFields"]));
      sendResponse({ ok: true });
      return;
    }
    if (!pageKind) throw new Error("仅支持领星 ERP 页面");
    if (message?.type === "LX_FORMAL_PAGE_OPENED") {
      if (message.sourceKind !== pageKind) throw new Error("页面来源不一致");
      sendResponse({ ok: true, sourceKind: pageKind });
      return;
    }
    if (message?.type === "LX_FORMAL_CAPTURE") {
      if (message.sourceKind !== pageKind) throw new Error("页面来源不一致");
      const incoming = sanitizeCapture(message.capture, pageKind);
      const outcome = await serializeLibraryWrite(async () => {
        const stored = await chrome.storage.local.get(["formalDatasets", "formalHiddenFields"]);
        const datasets = stored.formalDatasets || {};
        const previous = datasets[pageKind] || { rows: [] };
        const filtered = withoutFields(incoming.rows, pageKind, stored.formalHiddenFields || []);
        const rows = mergeRows(previous.rows, filtered, 1000);
        const label = clean(message.sourceLabel).slice(0, 80) || previous.label || "";
        const next = { sourceKind: pageKind, label, rows, dateRange: incoming.dateRange || previous.dateRange || null, capturedAt: incoming.capturedAt };
        const changed = JSON.stringify(previous.rows) !== JSON.stringify(rows) || previous.label !== label || dateRangeKey(previous.dateRange) !== dateRangeKey(next.dateRange);
        if (changed) await chrome.storage.local.set({ formalDatasets: { ...datasets, [pageKind]: next } });
        return { changed, visibleRows: incoming.rows.length, cachedRows: rows.length };
      });
      if (outcome.changed) await notifyPages(pageKind, sender.tab?.id);
      sendResponse({ ok: true, ...outcome });
      return;
    }
    if (message?.type === "LX_FORMAL_GET_LIBRARY") {
      await libraryWrite;
      sendResponse({ ok: true, data: await libraryPayload(pageKind), targetKind: pageKind });
      return;
    }
    if (message?.type === 'LX_FORMAL_CARGO_SNAPSHOT_QUERY') {
      const path = new URL(sender.tab?.url || 'https://invalid.example').pathname;
      if (!['/erp/productExpressionNew', '/erp/mreport/salesStat'].includes(path)) throw new Error('仅产品表现或销量统计页可以查询途中货件');
      const identity = { msku: clean(message.identity?.msku), store: clean(message.identity?.store) };
      if (!identity.msku || identity.msku.length > 150 || identity.store.length > 80) throw new Error('货件查询的 MSKU 或店铺无效');
      if (path === '/erp/mreport/salesStat' && !identity.store) throw new Error('销量在途明细缺少店铺身份，不能合并不同店铺货件');
      const requestId = crypto.randomUUID();
      const cached = await cargoSessionSnapshot();
      if (cached) {
        sendResponse({ ok: true, requestId, rows: cargoRowsFor(cached, identity), complete: true, scope: cached.scope, cached: true });
        return;
      }
      const runningScan = await currentCargoScan();
      if (runningScan) {
        runningScan.waiters.set(requestId, { tabId: sender.tab.id, identity });
        await persistCargoScan(runningScan);
        sendResponse({ ok: true, requestId, scanning: true });
        return;
      }
      const sourceUrl = `${new URL(sender.tab.url).origin}/erp/msupply/fbaCargo`;
      const sourceTab = await chrome.tabs.create({ active: false, windowId: sender.tab.windowId, url: sourceUrl });
      if (!sourceTab?.id) throw new Error('无法打开 FBA 货件页');
      const scan = { scanId: crypto.randomUUID(), sourceTabId: sourceTab.id, requesterTabId: sender.tab.id,
        waiters: new Map([[requestId, { tabId: sender.tab.id, identity }]]), timeoutId: null, focusedSource: false };
      armCargoTimeout(scan);
      pendingCargoSnapshot = scan;
      await cargoProgress(scan, '后台货件页已创建；等待插件脚本就绪…');
      const runtime = await chrome.tabs.sendMessage(sourceTab.id, { type: 'LX_FORMAL_RUNTIME' }).catch(() => null);
      if (runtime?.ok && runtime.route === 'page@%2Ferp%2Fmsupply%2FfbaCargo' && pendingCargoSnapshot === scan && !scan.started) {
        scan.started = true;
        await cargoProgress(scan, '货件页脚本已就绪；正在启动扫描…');
        const started = await chrome.tabs.sendMessage(sourceTab.id, { type: 'LX_FORMAL_RUN_CARGO_SNAPSHOT', requestId: scan.scanId }).catch(() => null);
        if (!started?.ok) await finishCargoSnapshot(scan, 'FBA 货件页未能启动整表抓取');
      } else if (!runtime?.ok) {
        await cargoProgress(scan, '货件页尚未就绪；等待页面脚本的就绪回执…');
      }
      sendResponse({ ok: true, requestId, scanning: true });
      return;
    }
    if (message?.type === 'LX_FORMAL_CARGO_SNAPSHOT_PROGRESS') {
      const scan = await currentCargoScan();
      if (!scan || scan.sourceTabId !== sender.tab?.id || scan.scanId !== message.requestId || new URL(sender.tab.url).pathname !== '/erp/msupply/fbaCargo') throw new Error('货件抓取进度来源无效');
      await cargoProgress(scan, message.stage, message.diagnosticText, { telemetryOnly: message.telemetryOnly });
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'LX_FORMAL_CARGO_FOCUS_SOURCE') {
      const scan = await currentCargoScan();
      if (!scan || scan.sourceTabId !== sender.tab?.id || scan.scanId !== message.requestId || new URL(sender.tab.url).pathname !== '/erp/msupply/fbaCargo') throw new Error('货件抓取前台切换来源无效');
      const tab = await chrome.tabs.update(scan.sourceTabId, { active: true });
      scan.focusedSource = Boolean(tab?.active);
      await persistCargoScan(scan);
      sendResponse({ ok: scan.focusedSource });
      return;
    }
    if (message?.type === 'LX_FORMAL_CARGO_SNAPSHOT_READY') {
      const scan = await currentCargoScan();
      if (!scan || scan.sourceTabId !== sender.tab?.id || scan.scanId !== message.requestId || new URL(sender.tab.url).pathname !== '/erp/msupply/fbaCargo') throw new Error('货件整表数据来源无效');
      const rows = Array.isArray(message.rows) ? message.rows : [];
      const valid = rows.length <= 100000 && rows.every((row) => row && typeof row === 'object' &&
        clean(row.shipmentId).length <= 100 && clean(row.msku).length <= 150 && clean(row.store).length <= 80 &&
        /^SHIPPED$/i.test(clean(row.status)) && /^\d+$/.test(clean(row.declared)) && /^\d+$/.test(clean(row.received)));
      if (message.complete !== true || !valid) {
        await finishCargoSnapshot(scan, clean(message.error) || '货件抓包未完成或数据校验失败，不缓存不完整数据');
      } else {
        await finishCargoSnapshot(scan, '', { rows, complete: true, scope: clean(message.scope).slice(0, 80), capturedAt: Date.now() });
      }
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "LX_FORMAL_TRANSIT_DETAIL_QUERY") {
      if (new URL(sender.tab?.url || 'https://invalid.example').pathname !== '/erp/productExpressionNew') throw new Error('仅产品表现页可以查询途中货件');
      const msku = clean(message.identity?.msku);
      const store = clean(message.identity?.store);
      if (!msku || msku.length > 150 || store.length > 80) throw new Error('货件查询的 MSKU 或店铺无效');
      const cached = (await cargoMskuCache())[cargoIdentityKey({ msku, store })];
      if (cached?.complete === true) {
        sendResponse({ ok: true, requestId: crypto.randomUUID(), cached: true, result: cached });
        return;
      }
      const sourceUrl = `${new URL(sender.tab.url).origin}/erp/msupply/fbaCargo`;
      const sourceTab = await chrome.tabs.create({ active: false, windowId: sender.tab.windowId, url: sourceUrl });
      if (!sourceTab?.id) throw new Error('无法打开 FBA 货件后台页');
      const requestId = crypto.randomUUID();
      const timeoutId = setTimeout(async () => {
        const pending = pendingTransitDetails.get(requestId);
        if (!pending) return;
        pendingTransitDetails.delete(requestId);
        pendingTransitReadyByTab.delete(pending.sourceTabId);
        chrome.tabs.sendMessage(pending.requesterTabId, { type: 'LX_FORMAL_TRANSIT_DETAIL_RESULT', requestId, error: 'FBA 货件页 180 秒内未返回完整查询结果' }).catch(() => {});
        await restoreTransitRequester(pending);
        chrome.tabs.remove(pending.sourceTabId).catch(() => {});
      }, 180_000);
      pendingTransitDetails.set(requestId, { requesterTabId: sender.tab.id, sourceTabId: sourceTab.id, timeoutId, identity: { msku, store } });
      pendingTransitReadyByTab.set(sourceTab.id, { requestId, identity: { msku, store } });
      const runtime = await chrome.tabs.sendMessage(sourceTab.id, { type: 'LX_FORMAL_RUNTIME' }).catch(() => null);
      if (runtime?.ok && runtime.route === 'page@%2Ferp%2Fmsupply%2FfbaCargo' && pendingTransitReadyByTab.get(sourceTab.id)?.requestId === requestId) {
        pendingTransitReadyByTab.delete(sourceTab.id);
        chrome.tabs.sendMessage(sourceTab.id, { type: 'LX_FORMAL_RUN_TRANSIT_DETAIL_QUERY', requestId, identity: { msku, store } }).catch(() => {});
      }
      sendResponse({ ok: true, requestId });
      return;
    }
    if (message?.type === 'LX_FORMAL_TRANSIT_DETAIL_PROGRESS') {
      const pending = pendingTransitDetails.get(message.requestId);
      if (!pending || pending.sourceTabId !== sender.tab?.id || new URL(sender.tab.url).pathname !== '/erp/msupply/fbaCargo') throw new Error('途中货件进度来源无效');
      await chrome.tabs.sendMessage(pending.requesterTabId, {
        type: 'LX_FORMAL_TRANSIT_DETAIL_PROGRESS', requestId: message.requestId, stage: clean(message.stage).slice(0, 160),
        diagnosticText: clean(message.diagnosticText).slice(0, 300)
      }).catch(() => {});
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'LX_FORMAL_TRANSIT_FOCUS_SOURCE') {
      const pending = pendingTransitDetails.get(message.requestId);
      if (!pending || pending.sourceTabId !== sender.tab?.id || new URL(sender.tab.url).pathname !== '/erp/msupply/fbaCargo') throw new Error('途中货件前台切换来源无效');
      const tab = await chrome.tabs.update(pending.sourceTabId, { active: true });
      pending.focusedSource = Boolean(tab?.active);
      sendResponse({ ok: pending.focusedSource });
      return;
    }
    if (message?.type === 'LX_FORMAL_TRANSIT_DETAIL_RESULT') {
      const pending = pendingTransitDetails.get(message.requestId);
      if (!pending || pending.sourceTabId !== sender.tab?.id || new URL(sender.tab.url).pathname !== '/erp/msupply/fbaCargo') throw new Error('途中货件结果来源无效');
      pendingTransitDetails.delete(message.requestId);
      pendingTransitReadyByTab.delete(pending.sourceTabId);
      clearTimeout(pending.timeoutId);
      const result = message.result;
      const shipments = Array.isArray(result?.shipments) ? result.shipments.slice(0, 500).map((row) => ({
        shipmentId: clean(row.shipmentId).slice(0, 100), orderNumber: clean(row.orderNumber).slice(0, 100),
        quantity: Number.isSafeInteger(row.quantity) ? row.quantity : 0,
        shippedAt: clean(row.shippedAt).slice(0, 40), arrivalAt: clean(row.arrivalAt).slice(0, 40), arrivalDay: clean(row.arrivalDay).slice(0, 10),
        shippingMethod: clean(row.shippingMethod).slice(0, 60), arrivalWindow: clean(row.arrivalWindow).slice(0, 80)
      })) : [];
      const safeResult = result ? { shipments, total: shipments.reduce((sum, row) => sum + row.quantity, 0), complete: result.complete === true,
        orderMissing: Number.isSafeInteger(result.orderMissing) ? Math.max(0, result.orderMissing) : 0, scope: clean(result.scope).slice(0, 80) } : null;
      if (!message.error && safeResult?.complete && safeResult.shipments.every((row) => row.orderNumber && row.shippedAt && row.arrivalDay) && chrome.storage.session) {
        const results = await cargoMskuCache();
        results[cargoIdentityKey(pending.identity)] = safeResult;
        await chrome.storage.session.set({ [CARGO_MSKU_KEY]: { capturedAt: Date.now(), results } }).catch(() => {});
      }
      await chrome.tabs.sendMessage(pending.requesterTabId, {
        type: 'LX_FORMAL_TRANSIT_DETAIL_RESULT', requestId: message.requestId,
        error: clean(message.error).slice(0, 300), result: safeResult
      }).catch(() => {});
      await restoreTransitRequester(pending);
      chrome.tabs.remove(pending.sourceTabId).catch(() => {});
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "LX_FORMAL_DELETE_FIELD" || message?.type === "LX_FORMAL_DELETE_FIELDS") {
      const requested = message.type === "LX_FORMAL_DELETE_FIELD" ? [message.fieldId] : message.fieldIds;
      if (!Array.isArray(requested) || !requested.length || requested.length > 5000 || !requested.every(validFieldId)) throw new Error("待删除字段列表无效或超过 5000 项");
      const fieldIds = [...new Set(requested)];
      const deleted = new Set(fieldIds);
      const sourceKinds = new Set(fieldIds.map((id) => id.slice(0, id.indexOf(":"))));
      await serializeLibraryWrite(async () => {
        const stored = await chrome.storage.local.get(["formalDatasets", "formalLayouts", "formalHiddenFields"]);
        const hiddenFields = [...new Set([...(stored.formalHiddenFields || []), ...fieldIds])];
        const datasets = { ...(stored.formalDatasets || {}) };
        for (const sourceKind of sourceKinds) {
          if (datasets[sourceKind]) datasets[sourceKind] = { ...datasets[sourceKind], rows: withoutFields(datasets[sourceKind].rows || [], sourceKind, fieldIds) };
        }
        const layouts = Object.fromEntries(Object.entries(stored.formalLayouts || {}).map(([kind, layout]) => [kind, {
          ...layout,
          fieldIds: (layout.fieldIds || []).filter((id) => !deleted.has(id))
        }]));
        await chrome.storage.local.set({ formalDatasets: datasets, formalLayouts: layouts, formalHiddenFields: hiddenFields });
      });
      await notifyPages(null);
      sendResponse({ ok: true, deleted: fieldIds.length });
      return;
    }
    if (message?.type === "LX_FORMAL_RESTORE_FIELD") {
      const fieldId = String(message.fieldId || "");
      await serializeLibraryWrite(async () => {
        const stored = await chrome.storage.local.get("formalHiddenFields");
        const hiddenFields = Array.isArray(stored.formalHiddenFields) ? stored.formalHiddenFields : [];
        if (!hiddenFields.includes(fieldId)) throw new Error("该字段未被删除");
        await chrome.storage.local.set({ formalHiddenFields: hiddenFields.filter((id) => id !== fieldId) });
      });
      await notifyPages(fieldId.split(":")[0], null, true);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "LX_FORMAL_BACKFILL_SOURCE") {
      await currentSourceQueries();
      if ([...pendingSourceQueries.values()].some((pending) => pending.sourceTabId === sender.tab?.id)) throw new Error('正在执行来源查询，不派生反向补查');
      const sourceKind = typeof message.sourceKind === "string" && (message.sourceKind === "listing" || message.sourceKind === "sales" || message.sourceKind.startsWith("page@")) ? message.sourceKind : null;
      if (!sourceKind || sourceKind === pageKind) throw new Error("补查来源页无效");
      const matchBy = sourceKind === 'listing' || pageKind === 'listing' ? 'asin' : 'msku';
      if (message.matchBy && message.matchBy !== matchBy) throw new Error('补查匹配键与 Listing 关联规则不一致');
      const requested = matchBy === 'asin' ? message.asins : message.mskus;
      const mskus = [...new Set((Array.isArray(requested) ? requested : []).map(matchBy === 'asin' ? normalizeAsin : (value) => String(value).trim()).filter(Boolean))].slice(0, 20);
      if (!mskus.length) throw new Error(`没有需要补查的有效 ${matchBy === 'asin' ? 'ASIN' : 'MSKU'}`);
      const dateRange = dateRangeKey(message.dateRange) ? { start: message.dateRange.start, end: message.dateRange.end } : null;
      const fieldLabels = [...new Set((Array.isArray(message.fieldLabels) ? message.fieldLabels : []).map(clean).filter((label) => label && label.length <= 160))].slice(0, 100);
      if (sourceKind === "sales" && !dateRange) throw new Error("请先设置销量统计的查询日期范围");
      const sourceUrl = sourceUrlForKind(sourceKind, sender.tab.url);
      const openedTabs = await chrome.tabs.query({ url: "https://*.lingxing.com/erp/*" });
      // 销量统计的搜索框会保留旧查询，即使输入框短暂清空也可能重新显示旧值。
      // 为它使用干净的临时页，避免把旧结果误当作本批 MSKU 的批量预查；
      // 其他来源仍优先沿用已打开页面的店铺/站点筛选上下文。
      const existing = sourceKind === 'sales' ? null : openedTabs.find((tab) => tab.id && tab.id !== sender.tab?.id && !tab.active && new URL(tab.url || sourceUrl).origin === new URL(sourceUrl).origin && sourceKindFromUrl(tab.url) === sourceKind && ![...pendingSourceQueries.values()].some((pending) => pending.sourceTabId === tab.id));
      const target = existing || await chrome.tabs.create({ active: false, url: sourceUrl });
      if (!target?.id) throw new Error("无法打开字段来源页");
      const temporarySourceTab = !existing;
      const requestId = crypto.randomUUID();
      const requesterTabId = sender.tab?.id;
      const pending = { requestId, requesterTabId, sourceTabId: target.id, sourceKind, mskus, matchBy, dateRange, fieldLabels,
        temporarySourceTab, started: false, deadline: Date.now() + 70_000, readyDeadline: Date.now() + 25_000 };
      pendingSourceQueries.set(requestId, pending);
      pendingSourceReadyByTab.set(target.id, { requestId });
      armSourceTimeout(pending);
      await persistSourceQueries();
      const runtime = await chrome.tabs.sendMessage(target.id, { type: "LX_FORMAL_RUNTIME" }).catch(() => null);
      if (runtime?.ok && runtime.version === chrome.runtime.getManifest().version && runtime.route === sourceKind) {
        pending.started = true;
        pendingSourceReadyByTab.delete(target.id);
        armSourceTimeout(pending);
        await persistSourceQueries();
        await dispatchSourceQuery(target.id, requestId, mskus, dateRange, fieldLabels, matchBy);
        sendResponse({ ok: true, requestId, requested: mskus.length, sourceKind, deadline: pending.deadline, openedSource: true, temporarySource: temporarySourceTab });
        return;
      }
      if (existing) await chrome.tabs.reload(target.id);
      sendResponse({ ok: true, requestId, requested: mskus.length, sourceKind, deadline: pending.deadline, openedSource: !existing, refreshingSource: Boolean(existing), temporarySource: temporarySourceTab });
      return;
    }
    if (message?.type === "LX_FORMAL_SOURCE_READY") {
      await currentSourceQueries();
      await currentCargoScan();
      if (pendingCargoSnapshot?.sourceTabId === sender.tab?.id) {
        const scan = pendingCargoSnapshot;
        if (scan.started) { sendResponse({ ok: true, pending: true }); return; }
        scan.started = true;
        await cargoProgress(scan, '货件页就绪回执已到；正在启动扫描…');
        const started = await chrome.tabs.sendMessage(sender.tab.id, { type: 'LX_FORMAL_RUN_CARGO_SNAPSHOT', requestId: scan.scanId }).catch(() => null);
        if (!started?.ok) await finishCargoSnapshot(scan, 'FBA 货件页未能启动整表抓取');
        sendResponse({ ok: true, pending: true });
        return;
      }
      const transitWaiting = sender.tab?.id ? pendingTransitReadyByTab.get(sender.tab.id) : null;
      if (transitWaiting) {
        pendingTransitReadyByTab.delete(sender.tab.id);
        const pending = pendingTransitDetails.get(transitWaiting.requestId);
        if (pending) {
          const response = await chrome.tabs.sendMessage(sender.tab.id, { type: 'LX_FORMAL_RUN_TRANSIT_DETAIL_QUERY', requestId: transitWaiting.requestId, identity: transitWaiting.identity }).catch(() => null);
          if (!response?.ok) {
            pendingTransitDetails.delete(transitWaiting.requestId);
            clearTimeout(pending.timeoutId);
            chrome.tabs.sendMessage(pending.requesterTabId, { type: 'LX_FORMAL_TRANSIT_DETAIL_RESULT', requestId: transitWaiting.requestId, error: 'FBA 货件页未能启动查询' }).catch(() => {});
            chrome.tabs.remove(pending.sourceTabId).catch(() => {});
          }
        }
        sendResponse({ ok: true, pending: true });
        return;
      }
      const waiting = sender.tab?.id ? pendingSourceReadyByTab.get(sender.tab.id) : null;
      if (!waiting) { sendResponse({ ok: true, pending: false }); return; }
      const pending = pendingSourceQueries.get(waiting.requestId);
      if (!pending || pending.sourceKind !== pageKind) throw new Error("待执行补查与来源页不一致");
      pendingSourceReadyByTab.delete(sender.tab.id);
      pending.started = true;
      armSourceTimeout(pending);
      await persistSourceQueries();
      await dispatchSourceQuery(sender.tab.id, waiting.requestId, pending.mskus, pending.dateRange, pending.fieldLabels, pending.matchBy);
      sendResponse({ ok: true, pending: true, requestId: waiting.requestId });
      return;
    }
    if (message?.type === 'LX_FORMAL_SOURCE_FOCUS') {
      await currentSourceQueries();
      const pending = pendingSourceQueries.get(message.requestId);
      if (!pending || pending.sourceTabId !== sender.tab?.id || pending.sourceKind !== 'sales' || pageKind !== 'sales') throw new Error('销量日历前台切换来源无效');
      const cargo = await currentCargoScan();
      if (cargo?.focusedSource) throw new Error('货件正在读取前台表格，销量日历稍后自动重试');
      const tab = await chrome.tabs.update(pending.sourceTabId, { active: true });
      pending.focusedSource = Boolean(tab?.active);
      await persistSourceQueries();
      sendResponse({ ok: pending.focusedSource });
      return;
    }
    if (message?.type === "LX_FORMAL_SOURCE_PROGRESS") {
      await currentSourceQueries();
      const progress = message.progress || {};
      const pending = pendingSourceQueries.get(progress.requestId);
      if (!pending || pending.sourceTabId !== sender.tab?.id || pending.sourceKind !== pageKind) throw new Error("补查进度来源无效");
      if (pending.requesterTabId) await chrome.tabs.sendMessage(pending.requesterTabId, {
        type: "LX_FORMAL_SOURCE_PROGRESS",
        progress: {
          requestId: progress.requestId,
          sourceKind: pageKind,
          total: Math.max(0, Math.min(20, Number(progress.total) || 0)),
          completed: Math.max(0, Math.min(20, Number(progress.completed) || 0)),
          matched: Math.max(0, Math.min(20, Number(progress.matched) || 0)),
          currentMsku: String(progress.currentMsku || "").slice(0, 300)
        }
      }).catch(() => {});
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === 'LX_FORMAL_SOURCE_HEARTBEAT') {
      await currentSourceQueries();
      const pending = pendingSourceQueries.get(message.requestId);
      if (!pending || pending.sourceTabId !== sender.tab?.id || pending.sourceKind !== pageKind) throw new Error('补查心跳来源无效');
      if (Date.now() >= pending.deadline) await finishSourceQuery(pending, { ok: false, error: '来源页补查超过 70 秒，已停止等待' });
      sendResponse({ ok: true, deadline: pending.deadline });
      return;
    }
    if (message?.type === 'LX_FORMAL_SOURCE_CANCEL') {
      await currentSourceQueries();
      const pending = pendingSourceQueries.get(message.requestId);
      if (pending && pending.requesterTabId !== sender.tab?.id) throw new Error('不能取消其他主表的补查');
      if (pending) await finishSourceQuery(pending, { ok: false, error: '主表已停止等待本批补查，稍后自动重试' });
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "LX_FORMAL_SOURCE_RESULT") {
      await currentSourceQueries();
      const result = message.result || {};
      const pending = pendingSourceQueries.get(result.requestId);
      if (!pending || pending.sourceTabId !== sender.tab?.id || pending.sourceKind !== pageKind) throw new Error("补查结果来源无效");
      await finishSourceQuery(pending, result);
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "LX_FORMAL_SAVE_LAYOUT") {
      const fieldIds = (Array.isArray(message.fieldIds) ? message.fieldIds : []).filter((value) => typeof value === "string").slice(0, 30);
      const panel = {
        x: Number.isFinite(message.panel?.x) ? message.panel.x : null,
        y: Number.isFinite(message.panel?.y) ? message.panel.y : 88
      };
      const dateRanges = Object.fromEntries(Object.entries(message.dateRanges || {}).filter(([kind, range]) =>
        (kind === "sales" || kind.startsWith("page@")) && dateRangeKey(range)
      ).slice(0, 20).map(([kind, range]) => [kind, { start: range.start, end: range.end }]));
      const thresholdValue = (value) => {
        if (value === "" || value == null) return "";
        const text = String(value);
        const number = Number(text);
        if (text.length > 32 || !Number.isFinite(number) || number < 0 || number > 100000) throw new Error("可售天数阈值无效");
        return text;
      };
      const inventoryDaysThresholds = {
        short: thresholdValue(message.inventoryDaysThresholds?.short),
        long: thresholdValue(message.inventoryDaysThresholds?.long)
      };
      if (inventoryDaysThresholds.short !== "" && inventoryDaysThresholds.long !== "" && Number(inventoryDaysThresholds.short) >= Number(inventoryDaysThresholds.long)) throw new Error("过短天数必须小于过长天数");
      const fbaEstimatedDaysThresholds = {
        short: thresholdValue(message.fbaEstimatedDaysThresholds?.short),
        long: thresholdValue(message.fbaEstimatedDaysThresholds?.long)
      };
      if (fbaEstimatedDaysThresholds.short !== "" && fbaEstimatedDaysThresholds.long !== "" && Number(fbaEstimatedDaysThresholds.short) >= Number(fbaEstimatedDaysThresholds.long)) throw new Error("FBA可售天数预估：过短天数必须小于过长天数");
      const marginValue = (value) => {
        if (value === '' || value == null) return '';
        const text = String(value).trim();
        if (!['number', 'string'].includes(typeof value) || !text || text.length > 32 || !Number.isFinite(Number(text)) || Math.abs(Number(text)) > 100000) throw new Error('订单毛利率阈值无效');
        return text;
      };
      const orderGrossMarginThresholds = {
        low: marginValue(message.orderGrossMarginThresholds?.low),
        high: marginValue(message.orderGrossMarginThresholds?.high)
      };
      if (orderGrossMarginThresholds.low !== '' && orderGrossMarginThresholds.high !== '' && Number(orderGrossMarginThresholds.low) >= Number(orderGrossMarginThresholds.high)) throw new Error('过低毛利率必须小于高毛利率');
      const acoasValue = message.acoasThresholds?.high;
      const acoasHigh = acoasValue === '' || acoasValue == null ? '' : String(acoasValue).trim();
      if (acoasHigh !== '' && (!['string', 'number'].includes(typeof acoasValue) || acoasHigh.length > 32 || !Number.isFinite(Number(acoasHigh)) || Number(acoasHigh) < 0 || Number(acoasHigh) > 100000)) throw new Error('ACoAS 上限阈值无效');
      if (acoasValue != null && acoasValue !== '' && acoasHigh === '') throw new Error('ACoAS 上限阈值无效');
      const acoasThresholds = { high: acoasHigh };
      await serializeLibraryWrite(async () => {
        const stored = await chrome.storage.local.get(["formalLayouts", "formalHiddenFields"]);
        const hidden = new Set(stored.formalHiddenFields || []);
        const previous = stored.formalLayouts?.[pageKind] || {};
        await chrome.storage.local.set({ formalLayouts: { ...(stored.formalLayouts || {}), [pageKind]: {
          fieldIds: fieldIds.filter((id) => !hidden.has(id)), panel, dateRanges, inventoryDaysThresholds,
          fbaEstimatedDaysThresholds: Object.hasOwn(message, 'fbaEstimatedDaysThresholds') ? fbaEstimatedDaysThresholds : previous.fbaEstimatedDaysThresholds || fbaEstimatedDaysThresholds,
          orderGrossMarginThresholds: Object.hasOwn(message, 'orderGrossMarginThresholds') ? orderGrossMarginThresholds : previous.orderGrossMarginThresholds || orderGrossMarginThresholds,
          acoasThresholds: Object.hasOwn(message, 'acoasThresholds') ? acoasThresholds : previous.acoasThresholds || acoasThresholds,
          fbaEstimatedDaysInitialized: message.fbaEstimatedDaysInitialized === true || previous.fbaEstimatedDaysInitialized === true
        } } });
      });
      sendResponse({ ok: true });
      return;
    }
    throw new Error("未知消息类型");
  })().catch((error) => sendResponse({ ok: false, error: String(error?.message || error).slice(0, 300) }));
  return true;
});
