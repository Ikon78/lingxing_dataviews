(() => {
  "use strict";
  if (window.__LX_FORMAL_FIELD_LIBRARY__) return;
  window.__LX_FORMAL_FIELD_LIBRARY__ = true;

  const VERSION = chrome.runtime.getManifest().version;
  const PRODUCT_EXPRESSION_KIND = "page@%2Ferp%2FproductExpressionNew";
  const FBA_ESTIMATED_DAYS_ID = `${PRODUCT_EXPRESSION_KIND}:FBA可售天数预估`;
  const LABELS = { listing: "Listing", sales: "销量统计", [PRODUCT_EXPRESSION_KIND]: "产品表现" };
  const COMMON_FIELD_IDS = ["sales:可用库存可售天数", "listing:价格", "listing:优惠价", FBA_ESTIMATED_DAYS_ID];
  const groupLibraryFields = (fields) => ({
    common: COMMON_FIELD_IDS.map((id) => fields.find((field) => field.id === id)).filter(Boolean),
    other: fields.filter((field) => !COMMON_FIELD_IDS.includes(field.id))
  });
  const libraryDragScrollDelta = (pointerY, top, bottom) => pointerY < top + 32 ? -22 : pointerY > bottom - 32 ? 22 : 0;
  const libraryFieldMatchesSearch = (field, query) => {
    const normalize = (value) => String(value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    const words = normalize(query).split(' ').filter(Boolean);
    const text = normalize(`${field.label || ''} ${field.sourceLabel || ''} ${routeLabel(field.sourceKind)}`);
    return words.every((word) => text.includes(word));
  };
  const state = { data: { datasets: {}, fields: [], hiddenFields: [], layout: null }, selected: [], dateRanges: {}, inventoryDaysThresholds: { short: "", long: "" }, fbaEstimatedDaysThresholds: { short: "", long: "" }, orderGrossMarginThresholds: { low: "", high: "" }, acoasThresholds: { high: "" }, fieldSearch: '', fbaEstimatedDaysInitialized: false, batchDeleteMode: false, batchSelected: new Set(), open: true, panel: { x: null, y: 88 }, dragging: null, captureText: "正在识别当前页面字段…", backfill: { text: "等待检查未命中字段", tone: "idle" } };
  let librarySearchComposing = false;
  let host = null;
  let root = null;
  let pageObserver = null;
  let captureTimer = null;
  let columnRepairTimer = null;
  let columnVerifyTimer = null;
  let transitSyncTimer = null;
  const transitValues = new Map();
  let transitNetworkRows = [];
  let transitNetworkDateKey = "";
  let cargoNetworkCapture = null;
  let transitDetailHost = null;
  let activeTransitDetail = null;
  let libraryRefreshTimer = null;
  let thresholdSaveTimer = null;
  let thresholdSavePending = false;
  let lastCaptureSignature = "";
  let currentRows = [];
  let productRowIdentities = new WeakMap();
  let injecting = false;
  let stopped = false;
  let sourceQueryBusy = false;
  let backfillTimer = null;
  let activeBackfill = null;
  let activeKind = null;
  let pageSessionKind = null;
  let renderPending = false;
  const backfillAttempts = new Map();
  const backfillAttemptCounts = new Map();
  const backfillFailureReasons = new Map();
  const BACKFILL_COOLDOWN_MS = 30_000;
  const BACKFILL_MAX_COOLDOWN_MS = 5 * 60_000;
  const BACKFILL_BATCH_SIZE = 8;
  const SOURCE_QUERY_MAX_MS = 52_000;
  const backfillRetryDelay = (attempts) => Math.min(BACKFILL_MAX_COOLDOWN_MS, BACKFILL_COOLDOWN_MS * 2 ** Math.min(Math.max(0, attempts - 1), 4));

  const routeKind = () => {
    const path = location.pathname.replace(/\/+$/, "");
    if (path === "/erp/listing") return "listing";
    if (path === "/erp/mreport/salesStat") return "sales";
    return path.startsWith("/erp/") && path.length <= 220 ? `page@${encodeURIComponent(path)}` : null;
  };
  const clean = (value) => String(value ?? "").replace(/[\uE000-\uF8FF]/g, "").replace(/\s+/g, " ").trim();
  const normalizeMsku = (value) => clean(value).toUpperCase().replace(/[\u2010-\u2015\s-]+/g, "-");
  const normalizeAsin = (value) => /^[A-Z0-9]{10}$/.test(clean(value).toUpperCase()) ? clean(value).toUpperCase() : "";
  const dateRangeKey = (range) => /^\d{4}-\d{2}-\d{2}$/.test(range?.start || "") && /^\d{4}-\d{2}-\d{2}$/.test(range?.end || "") && range.start <= range.end ? `${range.start}:${range.end}` : "";
  const defaultDateRange = () => {
    const end = new Date();
    const start = new Date(end); start.setDate(start.getDate() - 9);
    const format = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { start: format(start), end: format(end) };
  };
  const cargoSixMonthRange = (now = new Date()) => {
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(end.getFullYear(), end.getMonth() - 6, 1);
    const lastDay = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    start.setDate(Math.min(end.getDate(), lastDay));
    const format = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { start: format(start), end: format(end) };
  };
  const cargoScanWindows = (range) => {
    const end = new Date(`${range.end}T12:00:00`);
    const beginning = new Date(`${range.start}T12:00:00`);
    const format = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    // 产品视图会把每票货件展开成多行，并使用虚拟滚动。三个月一段可能有数万像素，
    // 浏览器回收父行时偶发漏掉一票。按自然月拆段使每次完整性核对落在较短的表格上。
    const windows = [];
    let cursor = end;
    while (cursor >= beginning) {
      const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 12);
      const start = monthStart > beginning ? monthStart : beginning;
      windows.push({ start: format(start), end: format(cursor) });
      cursor = new Date(start);
      cursor.setDate(cursor.getDate() - 1);
    }
    return windows;
  };
  const skuQueryFromMsku = (value) => clean(value).replace(/[-\s](US|CA|UK|GB|DE|FR|IT|ES|JP|AU|MX|BR|NL|SE|PL|TR|IN|AE|SA|SG|BE|EU)$/i, "");
  const isRendered = (node) => {
    if (!node?.isConnected) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const normalizeMarketplace = (value) => {
    const text = clean(value).toUpperCase().replace(/\s+/g, "");
    return ({ US: "US", USA: "US", 美国: "US", 美国站: "US", CA: "CA", CANADA: "CA", 加拿大: "CA", 加拿大站: "CA", UK: "UK", GB: "UK", 英国: "UK", 英国站: "UK", DE: "DE", GERMANY: "DE", 德国: "DE", 德国站: "DE", FR: "FR", FRANCE: "FR", 法国: "FR", 法国站: "FR", IT: "IT", ITALY: "IT", 意大利: "IT", 意大利站: "IT", ES: "ES", SPAIN: "ES", 西班牙: "ES", 西班牙站: "ES", JP: "JP", JAPAN: "JP", 日本: "JP", 日本站: "JP", AU: "AU", AUSTRALIA: "AU", 澳大利亚: "AU", 澳大利亚站: "AU" })[text] || text;
  };
  const contextIdentity = (label, value) => {
    const lines = String(value || "").split(/\n+/).map(clean).filter(Boolean);
    if (!/仓库/.test(label || "")) return { store: lines[0] || "", marketplace: lines[1] || "" };
    const text = lines.join(" ");
    const store = text.match(/\b([A-Z0-9]{2,12}-(?:US|CA|UK|GB|DE|FR|IT|ES|JP|AU))\b/i)?.[1]?.toUpperCase() || "";
    return { store, marketplace: store ? normalizeMarketplace(store.split("-").at(-1)) : normalizeMarketplace(text.replace(/仓库?|海外仓|FBA/gi, "")) };
  };
  function pageDateRange() {
    const editors = [...document.querySelectorAll(".el-date-editor--daterange")].filter(isRendered);
    for (const editor of editors) {
      const inputs = [...editor.querySelectorAll("input.el-range-input")];
      const range = { start: inputs[0]?.value || "", end: inputs[1]?.value || "" };
      if (dateRangeKey(range)) return range;
    }
    return null;
  }
  // 销量统计使用原生日历，不写只读输入框或绕过业务页的日期事件。
  async function setSalesDateRange(range, requestId = '') {
    setSalesDateRange.lastError = '';
    const targetKey = dateRangeKey(range);
    if (!targetKey) { setSalesDateRange.lastError = '目标日期格式无效'; return false; }
    if (dateRangeKey(pageDateRange()) === targetKey) return true;
    if (typeof readLoadedTable === 'function') {
      const picked = await readLoadedTable({ action: 'pickSalesDate', range });
      if (picked.supported) {
        if (picked.ok && picked.dateKey === targetKey) return true;
        setSalesDateRange.lastError = picked.reason || '原生日历选中事件未接受目标日期';
        return false;
      }
    }
    if (requestId && document.hidden) {
      const focused = await send({ type: 'LX_FORMAL_SOURCE_FOCUS', requestId });
      if (!focused?.ok) { setSalesDateRange.lastError = focused?.error || '来源页无法切到前台操作日历'; return false; }
    }
    const wait = (predicate, timeoutMs = 2500) => {
      if (predicate()) return Promise.resolve(true);
      return new Promise((resolve) => {
        let timer;
        const observer = new MutationObserver(() => { if (predicate()) finish(true); });
        const finish = (ok) => { clearTimeout(timer); observer.disconnect(); resolve(ok); };
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        timer = setTimeout(() => finish(Boolean(predicate())), timeoutMs);
        if (predicate()) finish(true);
      });
    };
    const editor = [...document.querySelectorAll(".el-date-editor--daterange")].find(isRendered);
    if (!editor) { setSalesDateRange.lastError = '未找到日期控件'; return false; }
    const picker = () => [...document.querySelectorAll(".el-picker-panel.el-date-range-picker")].find(isRendered);
    // 与手动操作一致：聚焦并点击实际输入框。已有面板不再点外壳，避免将它关掉。
    if (!picker()) {
      const input = editor.querySelector('input.el-range-input');
      input?.focus();
      (input || editor).click();
      if (!(await wait(() => Boolean(picker())))) {
        const panel = [...document.querySelectorAll('.el-picker-panel.el-date-range-picker')][0];
        setSalesDateRange.lastError = `点击开始日期后日历未打开（后台 ${Boolean(document.hidden)}，面板 ${panel ? `${getComputedStyle(panel).display}/${Math.round(panel.getBoundingClientRect().height)}` : '未挂载'}）`;
        return false;
      }
    }
    const monthNumber = (year, month) => Number(year) * 12 + Number(month) - 1;
    const displayedMonth = (side) => {
      const title = clean(picker()?.querySelector(`.el-date-range-picker__content.is-${side} .el-date-range-picker__header div`)?.textContent || "");
      const match = title.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
      return match ? monthNumber(match[1], match[2]) : null;
    };
    const moveToMonth = async (side, target) => {
      for (let steps = 0; steps < 26; steps += 1) {
        const current = displayedMonth(side);
        if (current === null || Math.abs(current - target) > 24) return false;
        if (current === target) return true;
        const header = picker()?.querySelector(`.el-date-range-picker__content.is-${side} .el-date-range-picker__header`);
        const button = header?.querySelector(current > target ? "button.arrow-left.ak-rotate-90" : "button.arrow-right.ak-rotate-270");
        if (!button || button.disabled) return false;
        button.click();
        if (!(await wait(() => displayedMonth(side) !== null && displayedMonth(side) !== current))) return false;
      }
      return false;
    };
    const pick = async (date, edge) => {
      const [year, month, day] = date.split("-").map(Number);
      const target = monthNumber(year, month);
      const left = displayedMonth('left');
      const right = displayedMonth('right');
      const side = right !== null && (left === null || Math.abs(right - target) < Math.abs(left - target)) ? 'right' : 'left';
      if (!(await moveToMonth(side, target))) { setSalesDateRange.lastError = `${edge === 'start' ? '起始' : '结束'}月未切换到 ${date.slice(0, 7)}`; return false; }
      const cells = [...(picker()?.querySelectorAll(`.el-date-range-picker__content.is-${side} .el-date-table td`) || [])];
      const cell = cells.find((node) => !node.matches(".prev-month, .next-month, .disabled") && Number(clean(node.querySelector("span")?.textContent || node.textContent)) === day);
      if (!cell) { setSalesDateRange.lastError = `找不到可选日期 ${date}`; return false; }
      // 点击数字节点，与手动命中的事件目标一致；不在 Vue 更新前连点两次旧 td。
      (cell.querySelector('span') || cell).click();
      await Promise.resolve();
      const selected = edge === 'start'
        ? () => displayedMonth(side) === target && [...(picker()?.querySelectorAll(`.el-date-range-picker__content.is-${side} td.start-date`) || [])]
          .some((node) => Number(clean(node.querySelector('span')?.textContent || node.textContent)) === day)
        : () => dateRangeKey(pageDateRange()) === targetKey;
      const ok = await wait(selected, edge === 'start' ? 2500 : 5000);
      if (!ok) setSalesDateRange.lastError = edge === 'start' ? `起始日 ${date} 未选中` : `结束日 ${date} 点击后范围未提交`;
      return ok;
    };
    return await pick(range.start, 'start') && await pick(range.end, 'end');
  }

  async function setSourceDateRange(range) {
    setSourceDateRange.lastError = '';
    setSourceDateRange.lastChanged = false;
    const targetKey = dateRangeKey(range);
    if (!targetKey) { setSourceDateRange.lastError = '目标日期格式无效'; return false; }
    const originalKey = dateRangeKey(pageDateRange());
    if (typeof readLoadedTable === 'function') {
      const committed = await readLoadedTable({ action: 'setDate', range });
      if (committed.supported) {
        setSourceDateRange.lastChanged = committed.changed === true;
        if (committed.ok && committed.dateKey === targetKey) return true;
        setSourceDateRange.lastError = committed.reason || '日期组件未接受目标范围';
        return false;
      }
    }
    if (originalKey === targetKey) return true;
    setSourceDateRange.lastChanged = true;
    // 后台标签页的短 setTimeout 可能被 Chrome 限速到每次约一秒；
    // 观察日期面板真实变化，避免翻月和轮询被放大成几十秒的“无进度”。
    const waitForDom = (predicate, timeoutMs = 1800) => {
      const initial = predicate();
      if (initial) return Promise.resolve(initial);
      return new Promise((resolve) => {
        let finished = false;
        const finish = (value) => {
          if (finished) return;
          finished = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(value);
        };
        const check = () => {
          const value = predicate();
          if (value) finish(value);
        };
        const observer = new MutationObserver(check);
        observer.observe(document.documentElement, { attributes: true, childList: true, characterData: true, subtree: true });
        const timer = setTimeout(() => finish(predicate() || null), timeoutMs);
        check();
      });
    };
    const editor = [...document.querySelectorAll(".el-date-editor--daterange")].find(isRendered);
    if (!editor) { setSourceDateRange.lastError = '找不到可见的日期输入框'; return false; }
    if (typeof HTMLInputElement !== 'undefined') {
      const inputs = [...editor.querySelectorAll('input.el-range-input')];
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (inputs.length === 2 && setter) {
        const enter = (input, value) => {
          input.focus();
          setter.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        enter(inputs[0], range.start);
        // 让日期组件先接收第一端，避免两次输入在同一次 Vue 更新中互相覆盖。
        await new Promise((resolve) => setTimeout(resolve, 80));
        enter(inputs[1], range.end);
        // 两端同时由 Enter 提交。逐端 change 会让日期组件使用另一端旧值覆盖 userInput。
        inputs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        inputs[1].blur();
        // 此函数只负责提交筛选条件；业务数据是否更新由后续表格批次校验确认。
        // 抓包计数可能晚到，不能因此重复打开日历并把已经成功的日期判为失败。
        if (await waitForDom(() => dateRangeKey(pageDateRange()) === targetKey, 1800)) return true;
        setSourceDateRange.lastError = '日期输入未提交，尝试日历选择';
      }
    }
    const picker = () => [...document.querySelectorAll(".el-picker-panel.el-date-range-picker")].find(isRendered);
    // 输入框尝试提交失败后，日期组件可能仍保持打开。此时再点整个
    // editor 会把面板关掉，随后误报“日历未打开”。只在确实关闭时打开。
    let panel = picker();
    if (!panel) {
      const startInput = editor.querySelector?.('input.el-range-input');
      (startInput || editor).click();
      panel = await waitForDom(picker, 2500);
    }
    if (!panel) {
      editor.click();
      panel = await waitForDom(picker, 2500);
    }
    if (!panel) { setSourceDateRange.lastError = '日历未打开'; return false; }
    const monthNumber = (year, month) => Number(year) * 12 + Number(month) - 1;
    const displayedMonth = (side) => {
      const title = clean(panel.querySelector(`.el-date-range-picker__content.is-${side} .el-date-range-picker__header div`)?.textContent || "");
      const match = title.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
      return match ? monthNumber(match[1], match[2]) : null;
    };
    const moveToMonth = async (side, target) => {
      let current = displayedMonth(side);
      if (current === null || Math.abs(current - target) > 24) return false;
      for (let steps = 0; steps < 26; steps += 1) {
        if (current === target) return true;
        const header = panel.querySelector(`.el-date-range-picker__content.is-${side} .el-date-range-picker__header`);
        const button = header?.querySelector(current > target ? "button.arrow-left.ak-rotate-90" : "button.arrow-right.ak-rotate-270");
        if (!button || button.disabled) return false;
        button.click();
        const next = await waitForDom(() => {
          const month = displayedMonth(side);
          return month !== null && month !== current ? month : null;
        }, 1500);
        if (next === null) return false;
        current = next;
      }
      return false;
    };
    const pick = async (date, edge) => {
      const [year, month, day] = date.split("-").map(Number);
      const target = monthNumber(year, month);
      const left = displayedMonth("left");
      const right = displayedMonth("right");
      const side = right !== null && (left === null || Math.abs(right - target) < Math.abs(left - target)) ? "right" : "left";
      if (!(await moveToMonth(side, target))) return false;
      const cells = [...panel.querySelectorAll(`.el-date-range-picker__content.is-${side} .el-date-table td`)];
      const cell = cells.find((node) => !node.matches(".prev-month, .next-month, .disabled") && Number(clean(node.querySelector("span")?.textContent || node.textContent)) === day);
      if (!cell) return false;
      cell.click();
      // 日历先更新选中状态，再允许第二次点击；仅等微任务在后台标签页不可靠。
      if (edge === 'start') {
        return Boolean(await waitForDom(() => {
          if (displayedMonth(side) !== target) return null;
          return [...panel.querySelectorAll(`.el-date-range-picker__content.is-${side} .el-date-table td.start-date`)]
            .some((node) => Number(clean(node.querySelector('span')?.textContent || node.textContent)) === day) || null;
        }, 2500));
      }
      return Boolean(await waitForDom(() => dateRangeKey(pageDateRange()) === targetKey, 3500));
    };
    if (!(await pick(range.start, 'start'))) { setSourceDateRange.lastError = '日历起始日未选中'; return false; }
    if (!(await pick(range.end, 'end'))) { setSourceDateRange.lastError = '日历结束日未提交'; return false; }
    return true;
  }
  function masterReportDateRange() {
    // Listing 的“创建时间”不是销量统计口径，不能当成报表日期。
    return routeKind() === "listing" ? null : pageDateRange();
  }
  function selectedDateRange(kind) {
    return state.dateRanges[kind] || state.data.datasets?.[kind]?.dateRange || defaultDateRange();
  }
  function sourceRowsFor(kind) {
    const rows = state.data.datasets?.[kind]?.rows || [];
    if (kind === routeKind()) return rows;
    const hasDate = kind === "sales" || kind === PRODUCT_EXPRESSION_KIND || state.data.datasets?.[kind]?.dateRange;
    if (!hasDate) return rows;
    const key = dateRangeKey(masterReportDateRange() || selectedDateRange(kind));
    return rows.filter((row) => row.dateScope === key);
  }
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
  const routeLabel = (kind) => {
    if (!kind) return "来源页";
    if (LABELS[kind]) return LABELS[kind];
    const saved = state.data.datasets?.[kind]?.label;
    if (saved) return saved;
    try { return decodeURIComponent(String(kind).slice(5)).split("/").filter(Boolean).at(-1) || "ERP 页面"; } catch { return "ERP 页面"; }
  };
  const currentPageLabel = () => {
    const kind = routeKind();
    if (LABELS[kind]) return LABELS[kind];
    const active = document.querySelector('.el-tabs__item.is-active, [role="tab"][aria-selected="true"], .ant-tabs-tab-active, .el-breadcrumb__item:last-child');
    const title = clean(active?.textContent || "").replace(/^[×✕\s]+|[×✕\s]+$/g, "");
    return title && title.length <= 80 && !/^(MSKU|ASIN|SKU|SPU|父ASIN|单品)$/i.test(title) ? title : routeLabel(kind);
  };

  function syncRoute() {
    const kind = routeKind();
    if (!kind || kind === activeKind) return;
    activeKind = kind;
    pageSessionKind = null;
    lastCaptureSignature = "";
    currentRows = [];
    productRowIdentities = new WeakMap();
    clearTimeout(transitSyncTimer);
    transitSyncTimer = null;
    transitValues.clear();
    transitNetworkRows = [];
    transitNetworkDateKey = "";
    closeTransitDetail();
    state.selected = [];
    state.dateRanges = {};
    state.inventoryDaysThresholds = { short: "", long: "" };
    state.fbaEstimatedDaysThresholds = { short: "", long: "" };
    state.orderGrossMarginThresholds = { low: "", high: "" };
    state.acoasThresholds = { high: "" };
    state.fieldSearch = '';
    librarySearchComposing = false;
    state.fbaEstimatedDaysInitialized = false;
    state.captureText = "正在识别当前页面字段…";
    clearTimeout(thresholdSaveTimer);
    thresholdSavePending = false;
    clearTimeout(backfillTimer);
    activeBackfill = null;
    render();
    renderOrderGrossMarginWarnings();
    renderAcoasWarnings();
    if (isProductExpressionPage() || isSalesPage()) window.postMessage({ type: "LX_FORMAL_TRANSIT_REQUEST" }, location.origin);
    startPageSession(kind);
  }

  async function startPageSession(kind) {
    pageSessionKind = null;
    const reset = await send({ type: "LX_FORMAL_PAGE_OPENED", sourceKind: kind });
    if (!reset?.ok || stopped || routeKind() !== kind) return;
    pageSessionKind = kind;
    await refreshLibrary();
    scheduleCapture(80);
    send({ type: "LX_FORMAL_SOURCE_READY" });
  }

  async function send(message) {
    try {
      if (!chrome.runtime?.id) throw new Error("扩展已重新加载，请刷新页面");
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (/context invalidated|扩展已重新加载/i.test(String(error?.message || error))) stopped = true;
      return { ok: false, error: String(error?.message || error) };
    }
  }

  function install() {
    if (stopped || !routeKind()) return;
    if (host?.isConnected) return;
    activeKind = routeKind();
    host = document.createElement("div");
    host.id = "lx-formal-field-library-host";
    root = host.attachShadow({ mode: "open" });
    document.documentElement.append(host);
    render();
    window.addEventListener("message", onTransitNetworkMessage);
    window.addEventListener("message", onCargoNetworkMessage);
    window.addEventListener("message", onCargoDiagnosticMessage);
    window.addEventListener("message", onCargoCaptureStartedMessage);
    document.addEventListener("click", onTransitColumnClick, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === 'Escape') closeTransitDetail();
      if ((event.key === 'Enter' || event.key === ' ') && event.target?.matches?.('td.lx-fba-transit-column')) onTransitColumnClick(event);
    }, true);
    if (isProductExpressionPage() || isSalesPage()) window.postMessage({ type: "LX_FORMAL_TRANSIT_REQUEST" }, location.origin);
    pageObserver?.disconnect();
    pageObserver = new MutationObserver(() => {
      if (injecting) return;
      syncRoute();
      scheduleTransitSync();
      scheduleCapture(350);
      clearTimeout(columnRepairTimer);
      columnRepairTimer = setTimeout(() => {
        renderOrderGrossMarginWarnings();
        renderAcoasWarnings();
        const mount = findTableMount();
        if (!mount) return;
        if (state.selected.length && columnsNeedRepair(mount, state.selected.length)) injectColumns(true);
        else if (transitColumnNeedsRepair(mount)) repairTransitColumn(mount);
      }, 180);
    });
    pageObserver.observe(document.documentElement, { childList: true, subtree: true });
    startPageSession(activeKind);
  }

  function panelX() { return state.panel.x == null ? Math.max(10, innerWidth - 420) : Math.max(8, Math.min(state.panel.x, innerWidth - 405)); }
  function panelY() { return Math.max(8, Math.min(state.panel.y ?? 88, innerHeight - 180)); }

  const inventoryDaysField = (field) => isProductExpressionPage() && field?.sourceKind === "sales" && clean(field.label) === "可用库存可售天数";
  const fbaEstimatedDaysField = (field) => isSalesPage() && field?.sourceKind === PRODUCT_EXPRESSION_KIND && clean(field.label) === "FBA可售天数预估";
  function inventoryDaysTone(field, value) {
    if (!inventoryDaysField(field) && !fbaEstimatedDaysField(field)) return "";
    const match = clean(value).match(/^(\d+(?:\.\d+)?)\s*(?:天|日)?$/);
    if (!match) return "";
    const days = Number(match[1]);
    const thresholds = fbaEstimatedDaysField(field) ? state.fbaEstimatedDaysThresholds : state.inventoryDaysThresholds;
    const short = thresholds.short;
    const long = thresholds.long;
    if (short !== "" && days < Number(short)) return "short";
    if (long !== "" && days > Number(long)) return "long";
    return "";
  }
  function inventoryDaysCellStyle(field, value) {
    const tone = inventoryDaysTone(field, value);
    const background = tone === "short" ? "#fee2e2" : tone === "long" ? "#fef3c7" : "#f8fbff";
    // Grouped/expanded views paint a white background image above the cell color.
    // Protect only our injected cells, including their neutral state after repaint.
    const base = `background:${background}!important;background-image:none!important`;
    return base + (tone === "short" ? ";color:#991b1b;font-weight:700" : tone === "long" ? ";color:#92400e;font-weight:700" : "");
  }

  function orderGrossMarginTone(value) {
    // Read the displayed percentage, never an adjacent currency amount or ratio.
    const match = clean(value).replace(/[−﹣－]/g, '-').match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*[%％]$/);
    if (!match) return '';
    const percent = Number(match[1]);
    if (!Number.isFinite(percent)) return '';
    const { low = '', high = '' } = state.orderGrossMarginThresholds || {};
    if (low !== '' && percent < Number(low)) return 'low';
    if (high !== '' && percent > Number(high)) return 'high';
    return '';
  }

  function renderOrderGrossMarginWarnings() {
    const attribute = 'data-lx-formal-order-margin-tone';
    const styleId = 'lx-formal-order-gross-margin-style';
    const painted = [...document.querySelectorAll(`[${attribute}]`)];
    const targets = new Map();
    if (isProductExpressionPage()) {
      // Independent of MSKU capture: a native percentage also exists in grouped views.
      for (const table of [...document.querySelectorAll('.vxe-table')].filter(isRendered)) {
        for (const wrapper of table.querySelectorAll('.vxe-table--main-wrapper,.vxe-table--fixed-left-wrapper,.vxe-table--fixed-right-wrapper')) {
          const column = [...headerMap(wrapper)].find(([, label]) => clean(label) === '订单毛利率')?.[0];
          if (!column) continue;
          for (const row of wrapper.querySelectorAll('.vxe-table--body tbody tr')) {
            const cell = row.querySelector(`td[colid="${CSS.escape(column)}"]`);
            if (!cell || cell.classList.contains('lx-formal-column')) continue;
            const tone = orderGrossMarginTone(cell.innerText || cell.textContent);
            if (tone) targets.set(cell, tone);
          }
        }
      }
    }
    // Recycled virtual rows, disabled rules and route changes must lose old warnings.
    for (const cell of painted) if (!targets.has(cell)) cell.removeAttribute(attribute);
    for (const [cell, tone] of targets) if (cell.getAttribute(attribute) !== tone) cell.setAttribute(attribute, tone);
    let style = document.getElementById(styleId);
    if (!isProductExpressionPage() || !targets.size) { style?.remove(); return; }
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      // Only marked native margin cells; do not overwrite their original inline CSS.
      style.textContent = `td[${attribute}="low"]{background:#fee2e2!important;background-image:none!important;color:#991b1b!important;font-weight:700!important}td[${attribute}="high"]{background:#fef3c7!important;background-image:none!important;color:#92400e!important;font-weight:700!important}td[${attribute}] *{color:inherit!important;font-weight:inherit!important}`;
      document.documentElement.append(style);
    }
  }

  function acoasTone(value) {
    const match = clean(value).replace(/[−﹣－]/g, '-').match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*[%％]$/);
    if (!match) return '';
    const percent = Number(match[1]);
    const high = state.acoasThresholds?.high ?? '';
    return high !== '' && Number.isFinite(percent) && percent > Number(high) ? 'high' : '';
  }

  function renderAcoasWarnings() {
    const attribute = 'data-lx-formal-acoas-tone';
    const styleId = 'lx-formal-acoas-style';
    const painted = [...document.querySelectorAll(`[${attribute}]`)];
    const targets = new Set();
    if (isProductExpressionPage()) {
      for (const table of [...document.querySelectorAll('.vxe-table')].filter(isRendered)) {
        for (const wrapper of table.querySelectorAll('.vxe-table--main-wrapper,.vxe-table--fixed-left-wrapper,.vxe-table--fixed-right-wrapper')) {
          // ACOS, ACoAS and ASoAS are different native metrics.
          const column = [...headerMap(wrapper)].find(([, label]) => clean(label).toUpperCase() === 'ACOAS')?.[0];
          if (!column) continue;
          for (const row of wrapper.querySelectorAll('.vxe-table--body tbody tr')) {
            const cell = row.querySelector(`td[colid="${CSS.escape(column)}"]`);
            if (cell && !cell.classList.contains('lx-formal-column') && acoasTone(cell.innerText || cell.textContent)) targets.add(cell);
          }
        }
      }
    }
    for (const cell of painted) if (!targets.has(cell)) cell.removeAttribute(attribute);
    for (const cell of targets) if (cell.getAttribute(attribute) !== 'high') cell.setAttribute(attribute, 'high');
    let style = document.getElementById(styleId);
    if (!isProductExpressionPage() || !targets.size) { style?.remove(); return; }
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      style.textContent = `td[${attribute}="high"]{background:#fee2e2!important;background-image:none!important;color:#991b1b!important;font-weight:700!important}td[${attribute}] *{color:inherit!important;font-weight:inherit!important}`;
      document.documentElement.append(style);
    }
  }

  function thresholdBarHtml(config) {
    if (config.key === 'acoasThresholds') {
      return `<div class="threshold-bar" data-threshold-key="acoasThresholds"><strong>ACoAS · 颜色阈值</strong><div class="threshold-inputs"><label>过高 ACoAS（%）<input type="number" min="0" max="100000" step="any" data-threshold="high" aria-label="ACoAS上限阈值" placeholder="留空不标红" value="${esc(state.acoasThresholds?.high ?? '')}"></label></div><p>输入 10 表示 10%；高于上限标红，等于界限不着色。留空关闭预警。</p></div>`;
    }
    const margin = config.key === 'orderGrossMarginThresholds';
    const lower = margin ? 'low' : 'short';
    const upper = margin ? 'high' : 'long';
    const lowerLabel = margin ? '过低毛利率（%）' : '过短天数';
    const upperLabel = margin ? '高毛利率（%）' : '过长天数';
    const prefix = config.key === 'inventoryDaysThresholds' ? '' : esc(config.label);
    const values = state[config.key] || {};
    return `<div class="threshold-bar" data-threshold-key="${config.key}"><strong>${esc(config.label)} · 颜色阈值</strong><div class="threshold-inputs"><label>${lowerLabel}<input type="number" min="${margin ? -100000 : 0}" max="100000" step="any" data-threshold="${lower}" aria-label="${margin ? '订单毛利率下限阈值' : prefix + '过短天数阈值'}" placeholder="留空不标红" value="${esc(values[lower])}"></label><label>${upperLabel}<input type="number" min="${margin ? -100000 : 0}" max="100000" step="any" data-threshold="${upper}" aria-label="${margin ? '订单毛利率上限阈值' : prefix + '过长天数阈值'}" placeholder="留空不标黄" value="${esc(values[upper])}"></label></div><p>${margin ? '输入 10 表示 10%；支持负值。低于下限标红，高于上限标黄；等于界限不着色。留空关闭对应预警。' : '低于过短值标红，高于过长值标黄；等于阈值不着色。留空关闭对应预警。'}</p></div>`;
  }

  function render() {
    if (!root || stopped) return;
    if (state.dragging || librarySearchComposing) {
      renderPending = true;
      return;
    }
    renderPending = false;
    const bodyScrollTop = root.querySelector('.body')?.scrollTop || 0;
    const libraryScrollTop = root.querySelector('.library-scroll')?.scrollTop || 0;
    const oldSearch = root.querySelector('.field-search');
    const searchFocus = oldSearch && root.activeElement === oldSearch
      ? { start: oldSearch.selectionStart, end: oldSearch.selectionEnd, direction: oldSearch.selectionDirection } : null;
    const fields = state.data.fields || [];
    const selectedFields = state.selected.map((id) => fields.find((field) => field.id === id)).filter(Boolean);
    const thresholdConfigs = [
      { key: 'inventoryDaysThresholds', label: '可用库存可售天数', show: selectedFields.some(inventoryDaysField) },
      { key: 'fbaEstimatedDaysThresholds', label: 'FBA可售天数预估', show: selectedFields.some(fbaEstimatedDaysField) },
      { key: 'orderGrossMarginThresholds', label: '订单毛利率', show: isProductExpressionPage() },
      { key: 'acoasThresholds', label: 'ACoAS', show: isProductExpressionPage() }
    ].filter((config) => config.show);
    const datedSources = [...new Set(selectedFields.filter((field) => field.sourceKind !== routeKind() && (field.sourceKind === "sales" || field.sourceKind === PRODUCT_EXPRESSION_KIND || state.data.datasets?.[field.sourceKind]?.dateRange)).map((field) => field.sourceKind))];
    const available = state.batchDeleteMode ? fields : fields.filter((field) => !state.selected.includes(field.id));
    const { common: commonAvailable, other: otherAvailable } = groupLibraryFields(available);
    const hiddenFields = state.data.hiddenFields || [];
    const datasets = Object.values(state.data.datasets || {});
    const cachedRows = datasets.reduce((total, dataset) => total + (dataset.rows?.length || 0), 0);
    root.innerHTML = `<style>
      :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#172033}*{box-sizing:border-box}
      .launch{position:fixed;z-index:2147483000;right:14px;top:43%;display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 13px 0 9px;border:1px solid #ffffff52;border-radius:13px;background:linear-gradient(135deg,#1769e0 0%,#1557bd 100%);color:#fff;font:700 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;letter-spacing:.2px;box-shadow:0 8px 22px #174f9138,0 2px 6px #173b6b26,inset 0 1px #ffffff2e;cursor:pointer;transition:transform .18s ease,box-shadow .18s ease,background .18s ease}
      .launch:hover{transform:translateX(-3px);background:linear-gradient(135deg,#2477e8 0%,#1557bd 100%);box-shadow:0 11px 28px #174f9142,0 3px 8px #173b6b2e,inset 0 1px #ffffff3b}.launch:active{transform:translateX(-1px) scale(.98)}.launch:focus-visible{outline:3px solid #8cc3ff;outline-offset:3px}.launch.open{background:linear-gradient(135deg,#123f7a 0%,#0d315f 100%);box-shadow:0 8px 20px #102f5938,inset 0 1px #ffffff26}
      .launch-icon{display:grid;grid-template-columns:repeat(2,5px);grid-template-rows:repeat(2,5px);gap:3px;place-content:center;width:24px;height:24px;border-radius:8px;background:#ffffff24;border:1px solid #ffffff30;box-shadow:inset 0 1px #ffffff26}.launch-icon i{display:block;width:5px;height:5px;border-radius:1.5px;background:#fff}.launch-text{white-space:nowrap}.launch-mark{width:5px;height:5px;border-radius:50%;background:#82e6c0;box-shadow:0 0 0 3px #82e6c029}
      @media (prefers-reduced-motion:reduce){.launch{transition:none}}
      .panel{position:fixed;z-index:2147483001;width:390px;max-height:76vh;display:${state.open ? "flex" : "none"};flex-direction:column;background:#fff;border:1px solid #d4deec;border-radius:12px;box-shadow:0 18px 55px #20385842;overflow:hidden}
      .head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#123968;color:#fff;cursor:move}.head b{font-size:15px}.head small{opacity:.7;font-size:10px;margin-left:5px}.head button{border:0;background:transparent;color:#fff;font-size:20px;cursor:pointer}.body{padding:12px;overflow:auto}
      .master{padding:9px 10px;border-radius:8px;background:#edf5ff;color:#174f91;font-size:12px;line-height:1.55}.status{margin-top:8px;padding:8px 10px;border-radius:8px;background:#f5f7fa;color:#59697d;font-size:12px;line-height:1.45}.backfill{margin-top:8px;padding:8px 10px;border-radius:8px;background:#f5f7fa;color:#59697d;font-size:12px;line-height:1.45}.backfill.running{background:#edf5ff;color:#1659a5}.backfill.success{background:#edf9f1;color:#237443}.backfill.bad{background:#fff2ef;color:#9b2c1d}
      h3{font-size:13px;margin:13px 0 7px}.hint{margin:0 0 7px;color:#718096;font-size:12px}.zone{display:flex;flex-wrap:wrap;gap:7px;min-height:48px;padding:8px;border:1px dashed #b7c5d8;border-radius:8px;background:#f8fafc}.zone.over{border-color:#1769e0;background:#edf5ff}
      .chip{position:relative;display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:6px 8px;border:1px solid #c9d4e2;border-radius:7px;background:#fff;font-size:12px;cursor:grab}.chip.other{border-color:#72a5e8;background:#f1f7ff}.chip.dragging{opacity:.45}.selected .chip.drop-before:before,.selected .chip.drop-after:after{content:"";position:absolute;top:-4px;bottom:-4px;width:3px;border-radius:2px;background:#1769e0}.selected .chip.drop-before:before{left:-6px}.selected .chip.drop-after:after{right:-6px}.chip span{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.chip small{color:#64748b}.chip button{border:0;background:transparent;color:#718096;cursor:pointer;padding:0}.chip button:hover{color:#b42318}.empty{color:#718096;font-size:12px}.deleted{margin-top:12px}.deleted summary{cursor:pointer;color:#59697d;font-size:12px}.deleted .zone{margin-top:7px}.restore{border:1px solid #c9d4e2;border-radius:7px;background:#fff;padding:5px 7px;font-size:12px;color:#32445a;cursor:pointer}
      .common-title{margin:9px 0 6px;color:#174f91}.common-fields{background:#f1f7ff;border-color:#9cc2f2}.library-scroll-title{display:flex;align-items:center;justify-content:space-between;margin:9px 0 6px}.library-scroll-title strong{font-size:12px;color:#475569}.scroll-controls{display:flex;gap:5px}.scroll-controls button{min-width:28px;height:25px;border:1px solid #b7c5d8;border-radius:6px;background:#fff;color:#174f91;cursor:pointer}.scroll-controls button:hover{background:#edf5ff}.library-scroll{max-height:clamp(150px,28vh,300px);overflow-y:scroll;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:auto;scrollbar-color:#86a9d3 #edf2f7;border-radius:8px}.library-scroll::-webkit-scrollbar{width:12px}.library-scroll::-webkit-scrollbar-track{background:#edf2f7;border-radius:7px}.library-scroll::-webkit-scrollbar-thumb{background:#86a9d3;border:2px solid #edf2f7;border-radius:7px}.library-scroll .zone{align-content:flex-start;min-height:76px}
      .library-title{display:flex;align-items:center;justify-content:space-between;margin-top:13px}.library-title h3{margin:0 0 7px}.library-title button,.batch-actions button{border:1px solid #c9d4e2;border-radius:7px;background:#fff;color:#32445a;padding:5px 8px;font-size:12px;cursor:pointer}.batch-actions{display:flex;gap:6px;align-items:center;margin:7px 0}.batch-actions .batch-delete{background:#c24132;color:#fff;border-color:#c24132}.batch-actions button:disabled{opacity:.5;cursor:not-allowed}.chip.batch{cursor:pointer}.chip.batch input{margin:0;accent-color:#1769e0}
      .actions{display:flex;gap:8px;margin-top:12px}.actions button{border:0;border-radius:7px;padding:8px 11px;font-weight:700;cursor:pointer}.apply{background:#1769e0;color:#fff}.refresh{background:#edf2f7;color:#32445a}
      .date-bar{margin-top:10px;padding:9px;border:1px solid #b8d3f7;border-radius:8px;background:#f1f7ff}.date-bar label{display:block;margin-bottom:6px;font-size:12px;font-weight:700;color:#174f91}.date-bar .date-inputs{display:flex;align-items:center;gap:6px}.date-bar input{min-width:0;flex:1;width:0;border:1px solid #b7c5d8;border-radius:6px;background:#fff;padding:6px 4px;font-size:11px;color:#172033}.date-bar p{margin:6px 0 0;color:#59697d;font-size:11px;line-height:1.4}
      .threshold-bar{margin-top:10px;padding:9px;border:1px solid #d1d9e6;border-radius:8px;background:#f8fafc}.threshold-bar strong{display:block;font-size:12px;margin-bottom:7px}.threshold-inputs{display:flex;gap:8px}.threshold-inputs label{flex:1;min-width:0;font-size:11px;color:#475569}.threshold-inputs input{display:block;width:100%;margin-top:4px;padding:6px;border:1px solid #b7c5d8;border-radius:6px;background:#fff;color:#172033}.threshold-bar p{margin:6px 0 0;color:#64748b;font-size:11px}
      .library-search{display:flex;gap:6px;margin:0 0 7px}.field-search{flex:1;min-width:0;padding:7px 8px;border:1px solid #b7c5d8;border-radius:6px;background:#fff;font-size:12px;color:#172033}.field-search:focus{outline:2px solid #9cc2f2;outline-offset:1px}.clear-field-search{border:1px solid #c9d4e2;border-radius:6px;background:#fff;color:#475569;padding:5px 8px;cursor:pointer}.clear-field-search:disabled{opacity:.45;cursor:default}.other-fields .chip[hidden],.other-fields .search-empty[hidden]{display:none}.field-search-status{margin:0 0 6px;color:#64748b;font-size:11px}
    </style>
    <button class="launch ${state.open ? "open" : ""}" type="button" aria-label="${state.open ? "收起跨页面字段库" : "打开跨页面字段库"}" aria-expanded="${state.open ? "true" : "false"}" title="${state.open ? "收起字段库" : "打开字段库"}"><span class="launch-icon" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="launch-text">字段库</span><span class="launch-mark" aria-hidden="true"></span></button>
    <section class="panel" style="left:${panelX()}px;top:${panelY()}px">
      <div class="head"><b>跨页面字段库 <small>v${esc(VERSION)}</small></b><button class="close">×</button></div>
      <div class="body">
        <div class="master">当前主表：<b>${esc(currentPageLabel())}</b><br>已记录 ${datasets.length} 个页面来源、${cachedRows} 行；当前来源累计 ${state.data.datasets?.[routeKind()]?.rows?.length || 0} 行</div>
        <div class="status">${esc(state.captureText)}</div>
        <div class="backfill ${esc(state.backfill.tone)}" data-backfill>${esc(state.backfill.text)}</div>
        <h3>当前主表已添加字段</h3><p class="hint">从下方拖入；涉及 Listing 按 ASIN＋店铺＋站点匹配，其他字段按 MSKU＋店铺＋站点匹配。</p>
        <div class="zone selected">${selectedFields.map((field) => chipHtml(field, true)).join("") || '<span class="empty">将字段拖到这里</span>'}</div>
        ${thresholdConfigs.map(thresholdBarHtml).join('')}
        ${!masterReportDateRange() ? datedSources.map((kind) => { const range = selectedDateRange(kind); return `<div class="date-bar" data-source="${esc(kind)}"><label>${esc(routeLabel(kind))} · 按日查询日期</label><div class="date-inputs"><input type="date" data-edge="start" aria-label="${esc(routeLabel(kind))}开始日期" value="${esc(range.start)}"><span>至</span><input type="date" data-edge="end" aria-label="${esc(routeLabel(kind))}结束日期" value="${esc(range.end)}"></div><p>补查和显示都使用此日期范围；修改后自动重新查询。</p></div>`; }).join("") : ""}
        <div class="library-title"><h3>字段库</h3><button class="batch-toggle">${state.batchDeleteMode ? "退出批量删除" : "批量删除"}</button></div><p class="hint">当前页面出现过的字段也会自动登记；蓝色表示来自另一页面。点 × 删除字段及其本地缓存值。</p>
        ${state.batchDeleteMode ? `<div class="batch-actions"><button class="batch-select-all">全选</button><button class="batch-delete" ${state.batchSelected.size ? "" : "disabled"}>删除已选（${state.batchSelected.size}）</button><button class="batch-cancel">取消</button></div>` : ""}
        <h3 class="common-title">常用字段</h3>
        <div class="zone available common-fields">${commonAvailable.map((field) => chipHtml(field, false)).join("") || '<span class="empty">常用字段已添加到主表，或尚未在来源页采集</span>'}</div>
        <div class="library-scroll-title"><strong>其他字段（${otherAvailable.length}）</strong><div class="scroll-controls"><button class="scroll-up" type="button" aria-label="向上滚动字段库" title="向上滚动">▲</button><button class="scroll-down" type="button" aria-label="向下滚动字段库" title="向下滚动">▼</button></div></div>
        <div class="library-search"><input class="field-search" type="search" maxlength="120" aria-label="搜索其他字段" placeholder="搜索字段名或来源，如 Listing 广告" value="${esc(state.fieldSearch)}"><button class="clear-field-search" type="button" aria-label="清空字段搜索">清空</button></div>
        <div class="field-search-status" role="status" aria-live="polite"></div>
        <div class="library-scroll" tabindex="0" aria-label="其他字段滚动区"><div class="zone available other-fields">${otherAvailable.map((field) => chipHtml(field, false)).join("")}<span class="empty search-empty" hidden>没有匹配字段，请更换关键词或清空搜索</span></div></div>
        ${hiddenFields.length ? `<details class="deleted"><summary>已删除字段（${hiddenFields.length}）· 点击展开恢复</summary><div class="zone">${hiddenFields.map((id) => `<button class="restore" data-id="${esc(id)}" title="恢复后需重新扫描来源页">恢复 ${esc(routeLabel(id.slice(0, id.indexOf(":"))))}.${esc(id.slice(id.indexOf(":") + 1))}</button>`).join("")}</div></details>` : ""}
        <div class="actions"><button class="apply">应用到当前主表</button><button class="refresh">重新扫描</button></div>
      </div>
    </section>`;
    wirePanel();
    updateLibrarySearch();
    root.querySelector('.body').scrollTop = bodyScrollTop;
    root.querySelector('.library-scroll').scrollTop = libraryScrollTop;
    if (searchFocus) {
      const input = root.querySelector('.field-search');
      input.focus({ preventScroll: true });
      input.setSelectionRange(searchFocus.start, searchFocus.end, searchFocus.direction || 'none');
    }
  }

  function chipHtml(field, selected) {
    const other = field.sourceKind !== routeKind();
    const batch = !selected && state.batchDeleteMode;
    return `<div class="chip ${other ? "other" : ""} ${batch ? "batch" : ""}" draggable="${!batch}" data-id="${esc(field.id)}" title="${esc(routeLabel(field.sourceKind))}.${esc(field.label)}">${batch ? `<input type="checkbox" aria-label="选择 ${esc(routeLabel(field.sourceKind))}.${esc(field.label)}" ${state.batchSelected.has(field.id) ? "checked" : ""}>` : ""}<small>${esc(routeLabel(field.sourceKind))}</small><span>${esc(field.label)}</span>${batch ? "" : `<button aria-label="${selected ? "从主表移除" : "从字段库删除"}">×</button>`}</div>`;
  }

  function visibleBatchFields() {
    return (state.data.fields || []).filter((field) => COMMON_FIELD_IDS.includes(field.id) || libraryFieldMatchesSearch(field, state.fieldSearch));
  }

  function updateLibrarySearch(resetScroll = false) {
    if (!root) return;
    const byId = new Map((state.data.fields || []).map((field) => [field.id, field]));
    const chips = [...root.querySelectorAll('.other-fields .chip')];
    let shown = 0;
    for (const chip of chips) {
      const field = byId.get(chip.dataset.id);
      chip.hidden = !field || !libraryFieldMatchesSearch(field, state.fieldSearch);
      if (!chip.hidden) shown += 1;
    }
    const status = root.querySelector('.field-search-status');
    if (status) status.textContent = state.fieldSearch.trim() ? `匹配 ${shown} / 共 ${chips.length} 个其他字段` : `共 ${chips.length} 个其他字段；支持字段名、来源页及空格分隔的多个关键词`;
    if (status && state.batchDeleteMode) {
      const visibleIds = new Set(visibleBatchFields().map((field) => field.id));
      const hiddenSelected = [...state.batchSelected].filter((id) => !visibleIds.has(id)).length;
      if (hiddenSelected) status.textContent += `；另有 ${hiddenSelected} 个已选字段在筛选外`;
    }
    const empty = root.querySelector('.search-empty');
    if (empty) empty.hidden = shown > 0;
    const clearButton = root.querySelector('.clear-field-search');
    if (clearButton) clearButton.disabled = !state.fieldSearch;
    if (resetScroll) root.querySelector('.library-scroll').scrollTop = 0;
    if (state.batchDeleteMode) updateBatchControls();
  }

  function updateBatchControls() {
    const button = root?.querySelector(".batch-delete");
    if (button) { button.textContent = `删除已选（${state.batchSelected.size}）`; button.disabled = !state.batchSelected.size; }
    const selectAll = root?.querySelector(".batch-select-all");
    if (selectAll) {
      const fields = visibleBatchFields();
      const selectable = fields.slice(0, 5000);
      const allSelected = selectable.length > 0 && selectable.every((field) => state.batchSelected.has(field.id));
      selectAll.textContent = allSelected ? "取消全选" : fields.length > 5000 ? "选择前 5000 项" : state.fieldSearch.trim() ? "全选可见字段" : "全选";
    }
  }

  function wirePanel() {
    const libraryScroll = root.querySelector('.library-scroll');
    const search = root.querySelector('.field-search');
    search.oninput = () => {
      state.fieldSearch = search.value.slice(0, 120);
      if (!librarySearchComposing) updateLibrarySearch(true);
    };
    search.oncompositionstart = () => { librarySearchComposing = true; };
    search.oncompositionend = () => {
      librarySearchComposing = false;
      state.fieldSearch = search.value.slice(0, 120);
      updateLibrarySearch(true);
      if (renderPending) render();
    };
    root.querySelector('.clear-field-search').onclick = () => {
      state.fieldSearch = ''; search.value = ''; updateLibrarySearch(true); search.focus({ preventScroll: true });
    };
    root.querySelector('.scroll-up').onclick = () => libraryScroll.scrollBy({ top: -Math.max(100, libraryScroll.clientHeight * 0.75), behavior: 'smooth' });
    root.querySelector('.scroll-down').onclick = () => libraryScroll.scrollBy({ top: Math.max(100, libraryScroll.clientHeight * 0.75), behavior: 'smooth' });
    libraryScroll.ondragover = (event) => {
      if (!state.dragging) return;
      const rect = libraryScroll.getBoundingClientRect();
      libraryScroll.scrollTop += libraryDragScrollDelta(event.clientY, rect.top, rect.bottom);
    };
    root.querySelector(".launch").onclick = () => { state.open = !state.open; render(); };
    root.querySelector(".close").onclick = () => { state.open = false; render(); };
    root.querySelector(".apply").onclick = async () => { await saveLayout(); injectColumns(true); };
    root.querySelector(".refresh").onclick = () => {
      const pending = activeBackfill;
      activeBackfill = null;
      if (pending?.requestId) send({ type: 'LX_FORMAL_SOURCE_CANCEL', requestId: pending.requestId });
      backfillAttempts.clear();
      backfillAttemptCounts.clear();
      clearTimeout(backfillTimer);
      scheduleCapture(0);
      refreshLibrary();
    };
    root.querySelectorAll(".date-bar input").forEach((input) => { input.onchange = async () => {
      const kind = input.closest(".date-bar").dataset.source;
      const range = { ...selectedDateRange(kind), [input.dataset.edge]: input.value };
      if (range.start > range.end) range[input.dataset.edge === "start" ? "end" : "start"] = input.value;
      if (!dateRangeKey(range)) { updateBackfill("开始日期不能晚于结束日期，请调整日期范围", "bad"); return; }
      state.dateRanges[kind] = range;
      backfillAttempts.clear(); backfillAttemptCounts.clear();
      clearTimeout(backfillTimer);
      await saveLayout(); render(); injectColumns(true);
    }; });
    root.querySelectorAll(".threshold-inputs input").forEach((input) => {
      input.oninput = () => {
        const bar = input.closest('.threshold-bar');
        const key = bar.dataset.thresholdKey;
        const inputs = [...bar.querySelectorAll(".threshold-inputs input")];
        const values = Object.fromEntries(inputs.map((node) => [node.dataset.threshold, node.value]));
        const margin = key === 'orderGrossMarginThresholds';
        const acoas = key === 'acoasThresholds';
        const lower = margin ? values.low : values.short;
        const upper = margin ? values.high : values.long;
        const validNumbers = inputs.every((node) => !node.validity.badInput && (node.value === "" || (Number.isFinite(Number(node.value)) && Number(node.value) >= (margin ? -100000 : 0) && Number(node.value) <= 100000)));
        const validOrder = acoas || lower === "" || upper === "" || Number(lower) < Number(upper);
        inputs.forEach((node) => node.setCustomValidity(validOrder ? "" : margin ? "过低毛利率必须小于高毛利率" : "过短天数必须小于过长天数"));
        if (!validNumbers || !validOrder) return;
        state[key] = values;
        clearTimeout(thresholdSaveTimer);
        thresholdSavePending = true;
        thresholdSaveTimer = setTimeout(async () => {
          try { await saveLayout(); injectColumns(true); }
          finally { thresholdSavePending = false; }
        }, 250);
      };
      input.onchange = () => input.reportValidity();
    });
    root.querySelector(".batch-toggle").onclick = () => {
      state.batchDeleteMode = !state.batchDeleteMode;
      state.batchSelected.clear();
      render();
    };
    root.querySelector(".batch-cancel")?.addEventListener("click", () => { state.batchDeleteMode = false; state.batchSelected.clear(); render(); });
    root.querySelector(".batch-select-all")?.addEventListener("click", () => {
      const ids = visibleBatchFields().slice(0, 5000).map((field) => field.id);
      const allSelected = ids.length > 0 && ids.every((id) => state.batchSelected.has(id));
      for (const id of ids) { if (allSelected) state.batchSelected.delete(id); else state.batchSelected.add(id); }
      root.querySelectorAll(".available .chip input").forEach((checkbox) => { checkbox.checked = state.batchSelected.has(checkbox.closest(".chip").dataset.id); });
      updateBatchControls();
    });
    root.querySelector(".batch-delete")?.addEventListener("click", async () => {
      const fieldIds = [...state.batchSelected];
      if (!fieldIds.length || !confirm(`确认从字段库删除选中的 ${fieldIds.length} 个字段？\n对应的本地缓存值和各主表布局列也会清除；之后可在“已删除字段”中恢复。`)) return;
      const result = await send({ type: "LX_FORMAL_DELETE_FIELDS", fieldIds });
      if (!result?.ok) { updateBackfill(`批量删除失败：${result?.error || "未知错误"}`, "bad"); return; }
      state.batchDeleteMode = false;
      state.batchSelected.clear();
      await refreshLibrary();
    });
    root.querySelectorAll(".chip").forEach((chip) => {
      const checkbox = chip.querySelector("input[type=checkbox]");
      if (checkbox) {
        checkbox.onchange = () => {
          if (checkbox.checked) state.batchSelected.add(chip.dataset.id); else state.batchSelected.delete(chip.dataset.id);
          updateBatchControls();
        };
        chip.onclick = (event) => { if (event.target !== checkbox) { checkbox.checked = !checkbox.checked; checkbox.dispatchEvent(new Event("change")); } };
        return;
      }
      chip.ondragstart = (event) => {
        state.dragging = chip.dataset.id;
        chip.classList.add("dragging");
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", chip.dataset.id);
        }
      };
      chip.ondragend = () => {
        state.dragging = null;
        root.querySelectorAll(".chip").forEach((item) => item.classList.remove("dragging", "drop-before", "drop-after"));
        root.querySelector(".selected")?.classList.remove("over");
        if (renderPending) render();
      };
      if (chip.closest(".selected")) {
        chip.ondragover = (event) => {
          if (!state.dragging || state.dragging === chip.dataset.id) return;
          event.preventDefault();
          event.stopPropagation();
          const rect = chip.getBoundingClientRect();
          const marker = event.clientX < rect.left + rect.width / 2 ? "drop-before" : "drop-after";
          const current = root.querySelector(".selected .chip.drop-before, .selected .chip.drop-after");
          if (current === chip && chip.classList.contains(marker)) return;
          root.querySelectorAll(".selected .chip").forEach((item) => item.classList.remove("drop-before", "drop-after"));
          chip.classList.add(marker);
        };
        chip.ondrop = async (event) => {
          if (!state.dragging || state.dragging === chip.dataset.id) return;
          event.preventDefault();
          event.stopPropagation();
          const draggedId = state.dragging;
          const targetId = chip.dataset.id;
          const after = chip.classList.contains("drop-after");
          state.selected = state.selected.filter((id) => id !== draggedId);
          const targetIndex = state.selected.indexOf(targetId);
          state.selected.splice(Math.max(0, targetIndex + (after ? 1 : 0)), 0, draggedId);
          state.dragging = null;
          render(); await saveLayout(); injectColumns(true);
        };
      }
      chip.querySelector("button")?.addEventListener("click", async () => {
        if (chip.closest(".available")) {
          const field = state.data.fields.find((item) => item.id === chip.dataset.id);
          if (!field || !confirm(`从字段库删除 ${routeLabel(field.sourceKind)}.${field.label}？\n已缓存的该字段值也会清除；需要时可在“已删除字段”中恢复。`)) return;
          const result = await send({ type: "LX_FORMAL_DELETE_FIELD", fieldId: field.id });
          if (!result?.ok) { updateBackfill(`删除失败：${result?.error || "未知错误"}`, "bad"); return; }
          await refreshLibrary();
          return;
        }
        state.selected = state.selected.filter((id) => id !== chip.dataset.id);
        render(); await saveLayout(); injectColumns(true);
      });
    });
    root.querySelectorAll(".restore").forEach((button) => {
      button.onclick = async () => {
        const result = await send({ type: "LX_FORMAL_RESTORE_FIELD", fieldId: button.dataset.id });
        if (!result?.ok) { updateBackfill(`恢复失败：${result?.error || "未知错误"}`, "bad"); return; }
        lastCaptureSignature = "";
        await refreshLibrary();
        if (button.dataset.id.startsWith(`${routeKind()}:`)) scheduleCapture(0);
      };
    });
    const selected = root.querySelector(".selected");
    selected.ondragover = (event) => { event.preventDefault(); selected.classList.add("over"); };
    selected.ondragleave = (event) => {
      const rect = selected.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) return;
      selected.classList.remove("over");
    };
    selected.ondrop = async (event) => {
      event.preventDefault(); selected.classList.remove("over");
      const draggedId = state.dragging;
      if (draggedId && !state.selected.includes(draggedId) && state.selected.length < 30) state.selected.push(draggedId);
      else if (draggedId && state.selected.includes(draggedId)) {
        state.selected = state.selected.filter((id) => id !== draggedId); state.selected.push(draggedId);
      }
      state.dragging = null;
      render(); await saveLayout(); injectColumns(true);
    };
    dragPanel(root.querySelector(".head"));
  }

  function dragPanel(handle) {
    handle.onpointerdown = (event) => {
      if (event.target.closest("button")) return;
      const start = { x: event.clientX, y: event.clientY, left: panelX(), top: panelY() };
      handle.setPointerCapture(event.pointerId);
      handle.onpointermove = (move) => {
        state.panel.x = start.left + move.clientX - start.x;
        state.panel.y = start.top + move.clientY - start.y;
        const panel = root.querySelector(".panel");
        if (panel) { panel.style.left = `${panelX()}px`; panel.style.top = `${panelY()}px`; }
      };
      handle.onpointerup = () => { handle.onpointermove = null; saveLayout(); };
    };
  }

  async function saveLayout() {
    return send({ type: "LX_FORMAL_SAVE_LAYOUT", fieldIds: state.selected, panel: state.panel, dateRanges: state.dateRanges, inventoryDaysThresholds: state.inventoryDaysThresholds,
      fbaEstimatedDaysThresholds: state.fbaEstimatedDaysThresholds, orderGrossMarginThresholds: state.orderGrossMarginThresholds, acoasThresholds: state.acoasThresholds, fbaEstimatedDaysInitialized: state.fbaEstimatedDaysInitialized });
  }

  async function refreshLibrary() {
    const kind = routeKind();
    const result = await send({ type: "LX_FORMAL_GET_LIBRARY" });
    if (!result?.ok || stopped || kind !== routeKind()) return;
    if (result.targetKind !== kind) {
      setTimeout(() => { if (!stopped && routeKind() === kind) refreshLibrary(); }, 250);
      return;
    }
    state.data = result.data;
    state.dateRanges = { ...(result.data.layout?.dateRanges || {}), ...state.dateRanges };
    if (!thresholdSavePending) state.inventoryDaysThresholds = result.data.layout?.inventoryDaysThresholds || { short: "", long: "" };
    if (!thresholdSavePending) state.fbaEstimatedDaysThresholds = result.data.layout?.fbaEstimatedDaysThresholds || { short: "", long: "" };
    if (!thresholdSavePending) state.orderGrossMarginThresholds = result.data.layout?.orderGrossMarginThresholds || { low: "", high: "" };
    if (!thresholdSavePending) state.acoasThresholds = result.data.layout?.acoasThresholds || { high: "" };
    state.fbaEstimatedDaysInitialized = result.data.layout?.fbaEstimatedDaysInitialized === true;
    state.batchSelected = new Set([...state.batchSelected].filter((id) => result.data.fields.some((field) => field.id === id)));
    state.panel = result.data.layout?.panel || state.panel;
    state.selected = (result.data.layout?.fieldIds || state.selected).filter((id) => result.data.fields.some((field) => field.id === id));
    if (isSalesPage() && !state.fbaEstimatedDaysInitialized && result.data.fields.some((field) => field.id === FBA_ESTIMATED_DAYS_ID)
      && (state.selected.includes(FBA_ESTIMATED_DAYS_ID) || state.selected.length < 30)) {
      // 首次启用用户要求的新列；之后允许自行移除，刷新时不强行加回。
      if (!state.selected.includes(FBA_ESTIMATED_DAYS_ID)) state.selected.push(FBA_ESTIMATED_DAYS_ID);
      state.fbaEstimatedDaysInitialized = true;
      const saved = await saveLayout();
      if (!saved?.ok) state.fbaEstimatedDaysInitialized = false;
      if (kind !== routeKind()) return;
    }
    render(); injectColumns(true);
  }

  function updateBackfill(text, tone = "idle") {
    state.backfill = { text, tone };
    const node = root?.querySelector?.("[data-backfill]");
    if (node) { node.textContent = text; node.className = `backfill ${tone}`; }
  }

  function tableHeaderLabels(table) {
    const cells = [...table.querySelectorAll("thead th")].filter((cell) => !cell.classList.contains("lx-formal-column"));
    const fallback = cells.length ? cells : [...(table.querySelector("tr")?.children || [])].filter((cell) => !cell.classList.contains("lx-formal-column"));
    return fallback.map((cell) => clean(cell.innerText || cell.textContent));
  }

  function tableDataRows(table) {
    if (!table) return [];
    return [...table.querySelectorAll("tbody tr")].filter((row) => row.querySelectorAll("td:not(.lx-formal-column)").length);
  }

  function pairedBodyTable(headerTable, tables) {
    if (tableDataRows(headerTable).length) return headerTable;
    const headerRect = headerTable.getBoundingClientRect();
    return tables.filter((table) => table !== headerTable && tableDataRows(table).length).sort((a, b) => {
      const score = (table) => {
        const rect = table.getBoundingClientRect();
        return Math.abs(rect.left - headerRect.left) + Math.abs(rect.width - headerRect.width) * 0.25 + (rect.top < headerRect.top ? 10000 : 0);
      };
      return score(a) - score(b);
    })[0] || null;
  }

  function akTableParts() {
    const rootNode = document.querySelector(".ak-table-list");
    if (!isRendered(rootNode)) return null;
    const tables = [...rootNode.querySelectorAll("table")].filter(isRendered);
    const described = tables.map((table) => ({ table, labels: tableHeaderLabels(table), hasHeader: Boolean(table.querySelector("thead th")) }));
    const fixedHeader = described.find(({ labels }) => labels.some((label) => /MSKU/i.test(label)));
    if (!fixedHeader) return null;
    const mainHeader = described.filter((item) => item !== fixedHeader && item.hasHeader && item.labels.length)
      .sort((a, b) => b.labels.length - a.labels.length)[0] || fixedHeader;
    const fixedBody = pairedBodyTable(fixedHeader.table, tables);
    const mainBody = mainHeader === fixedHeader ? fixedBody : pairedBodyTable(mainHeader.table, tables);
    if (!fixedBody || !mainBody) return null;
    return { root: rootNode, fixedHeader, mainHeader, fixedBody, mainBody };
  }

  function findTableMount() {
    // VXE 全屏/固定布局即使有完整尺寸，offsetParent 也可能为 null。
    const vxeTables = [...document.querySelectorAll(".vxe-table")].filter(isRendered);
    const vxe = vxeTables.find((table) => /MSKU/i.test(`${table.querySelector(".vxe-table--main-wrapper thead")?.textContent || ""} ${table.querySelector(".vxe-table--fixed-left-wrapper thead")?.textContent || ""}`)
      || (isProductExpressionMskuView() && /商品信息/.test(table.querySelector(".vxe-table--fixed-left-wrapper thead")?.textContent || "")));
    if (vxe) return vxe;
    const ak = akTableParts();
    if (ak) return ak.root;
    return [...document.querySelectorAll("table")].filter((table) => isRendered(table) && !table.closest(".vxe-table"))
      .find((table) => nativeHeaders(table).some((header) => /MSKU/i.test(header))) || null;
  }

  function nativeHeaders(table) {
    const row = table.tHead?.rows?.[table.tHead.rows.length - 1] || table.rows?.[0];
    return row ? [...row.cells].filter((cell) => !cell.classList.contains("lx-formal-column")).map((cell) => clean(cell.innerText || cell.textContent)) : [];
  }

  function nativeBodyRows(table) {
    const rows = table.tBodies?.length ? [...table.tBodies].flatMap((body) => [...body.rows]) : [...table.rows];
    return table.tHead ? rows : rows.filter((row) => row !== table.rows?.[0]);
  }

  function captureNativeTable(table) {
    const headers = nativeHeaders(table);
    const mskuIndex = headers.findIndex((header) => /MSKU/i.test(header));
    if (mskuIndex < 0) return [];
    const contextIndex = headers.findIndex((header) => /店铺|国家|站点|仓库/.test(header));
    const asinIndex = headers.findIndex((header) => /^ASIN/i.test(header));
    return nativeBodyRows(table).map((tr) => {
      const values = [...tr.cells].filter((cell) => !cell.classList.contains("lx-formal-column")).map((cell) => String(cell.innerText || cell.textContent || "").replace(/[\uE000-\uF8FF]/g, "").trim());
      const context = contextIdentity(headers[contextIndex], values[contextIndex]);
      const fields = Object.fromEntries(headers.map((header, index) => [header, clean(values[index])]).filter(([header, value]) => header && value));
      return {
        identity: {
          msku: identityLine(values[mskuIndex], "msku"),
          store: context.store,
          marketplace: context.marketplace,
          asin: asinIndex >= 0 ? identityLine(values[asinIndex], "asin") : ""
        },
        fields
      };
    }).filter((row) => row.identity.msku);
  }

  function headerMap(wrapper) {
    return new Map([...wrapper.querySelectorAll("thead th[colid]")]
      .filter((th) => !th.classList.contains("lx-formal-column"))
      .map((th) => [th.getAttribute("colid"), clean(th.innerText || th.textContent)]).filter(([, label]) => label));
  }

  function tableRowKey(row) {
    if (!row) return "";
    return ["rowid", "data-rowid", "data-row-key", "data-key"].map((name) => row.getAttribute(name)).find(Boolean) || "";
  }

  function productRowIdentity(main, row, identity) {
    if (!isProductExpressionMskuView() || !main || !identity.msku) return identity;
    const rowKey = tableRowKey(row);
    if (!rowKey) return identity;
    // 横向虚拟列会移除店铺/国家单元格，但业务行 rowid 不变。只保留同一表格、
    // 同一筛选范围、同一行及完整 MSKU 已实际读到的身份，不按 MSKU 猜店铺。
    const scope = JSON.stringify([dateRangeKey(pageDateRange()),
      clean(document.querySelector('.el-pager .active')?.textContent),
      ...[...document.querySelectorAll('.ak-search-wrapper input, .el-select input')].map((input) => clean(input.value))]);
    let cache = productRowIdentities.get(main);
    if (!cache || cache.scope !== scope) {
      cache = { scope, rows: new Map() };
      productRowIdentities.set(main, cache);
    }
    const previous = cache.rows.get(rowKey);
    const compatible = previous && clean(previous.msku) === clean(identity.msku)
      && (!identity.store || clean(previous.store).toUpperCase() === clean(identity.store).toUpperCase())
      && (!identity.asin || !previous.asin || clean(previous.asin) === clean(identity.asin));
    const resolved = compatible ? { ...previous, ...Object.fromEntries(Object.entries(identity).filter(([, value]) => clean(value))) } : identity;
    if (resolved.store) cache.rows.set(rowKey, { ...resolved });
    else cache.rows.delete(rowKey);
    return resolved;
  }

  function pairedVxeRow(fixedRows, mainRow, index) {
    const key = tableRowKey(mainRow);
    return (key && fixedRows.find((row) => tableRowKey(row) === key)) || fixedRows[index] || null;
  }

  function isProductExpressionPage() {
    return location.pathname.replace(/\/+$/, "") === "/erp/productExpressionNew";
  }

  function isSalesPage() {
    return routeKind() === "sales";
  }

  function isProductExpressionMskuView() {
    return isProductExpressionPage()
      && document.querySelector("#tab-msku")?.getAttribute("aria-selected") === "true";
  }

  async function ensureSourceMskuView(timeoutMs = 8000) {
    if (!isProductExpressionPage() && !isSalesPage()) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const tab = document.querySelector("#tab-msku");
      if (tab?.getAttribute("aria-selected") === "true") return true;
      if (tab && isRendered(tab)) tab.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return isProductExpressionMskuView();
  }

  function rowText(row, colid) {
    return String(row?.querySelector(`td[colid="${CSS.escape(colid)}"]`)?.innerText || "")
      .replace(/[\uE000-\uF8FF]/g, "").trim();
  }

  function identityLine(value, kind) {
    const lines = String(value || "").split(/\n+/).map(clean).filter(Boolean);
    if (kind === "msku") return lines.find((line) => !/^[\$€£¥￥]\s*[\d,.]+$/.test(line)) || "";
    return lines[0] || "";
  }

  function captureVisibleTable() {
    const mount = findTableMount();
    if (!mount) return [];
    if (mount.classList?.contains("ak-table-list")) {
      const parts = akTableParts();
      if (!parts) return [];
      const fixedLabels = parts.fixedHeader.labels;
      const mainLabels = parts.mainHeader.labels;
      const mskuIndex = fixedLabels.findIndex((label) => /MSKU/i.test(label));
      const contextIndex = fixedLabels.findIndex((label) => /店铺|国家|站点|仓库/.test(label));
      const asinIndex = fixedLabels.findIndex((label) => /^ASIN/i.test(label));
      const fixedRows = tableDataRows(parts.fixedBody);
      const mainRows = tableDataRows(parts.mainBody);
      return fixedRows.map((fixedRow, index) => {
        const fixedCells = [...fixedRow.querySelectorAll("td:not(.lx-formal-column)")];
        const mainCells = parts.mainBody === parts.fixedBody ? fixedCells : [...(mainRows[index]?.querySelectorAll("td:not(.lx-formal-column)") || [])];
        const context = contextIdentity(fixedLabels[contextIndex], fixedCells[contextIndex]?.innerText || fixedCells[contextIndex]?.textContent || "");
        const fields = {};
        fixedLabels.forEach((label, cellIndex) => {
          const value = clean(fixedCells[cellIndex]?.innerText || fixedCells[cellIndex]?.textContent || "");
          if (label && value) fields[label] = value;
        });
        if (parts.mainBody !== parts.fixedBody) mainLabels.forEach((label, cellIndex) => {
          const value = clean(mainCells[cellIndex]?.innerText || mainCells[cellIndex]?.textContent || "");
          if (label && value) fields[label] = value;
        });
        return {
          identity: {
            msku: identityLine(fixedCells[mskuIndex]?.innerText || fixedCells[mskuIndex]?.textContent, "msku"),
            store: context.store,
            marketplace: context.marketplace,
            asin: identityLine(asinIndex >= 0 ? (fixedCells[asinIndex]?.innerText || fixedCells[asinIndex]?.textContent)
              : (mainCells[mainLabels.findIndex((label) => /^ASIN/i.test(label))]?.innerText || mainCells[mainLabels.findIndex((label) => /^ASIN/i.test(label))]?.textContent), "asin")
          },
          fields
        };
      }).filter((row) => row.identity.msku);
    }
    if (mount.tagName === "TABLE") return captureNativeTable(mount);
    const fixed = mount.querySelector(".vxe-table--fixed-left-wrapper");
    const main = mount.querySelector(".vxe-table--main-wrapper");
    if (!main) return [];
    const fixedHeaders = fixed ? headerMap(fixed) : new Map();
    const mainHeaders = headerMap(main);
    const allHeaders = new Map([...fixedHeaders, ...mainHeaders]);
    const fixedRows = fixed ? [...fixed.querySelectorAll(".vxe-table--body tbody tr")] : [];
    const mainRows = [...main.querySelectorAll(".vxe-table--body tbody tr")];
    const mskuEntry = [...allHeaders].find(([, label]) => /MSKU/i.test(label))
      || (isProductExpressionMskuView() ? [...fixedHeaders].find(([, label]) => /商品信息/.test(label)) : null);
    const contextEntry = [...allHeaders].find(([, label]) => /店铺|国家|站点|仓库/.test(label));
    const asinEntry = [...allHeaders].find(([, label]) => /^ASIN/i.test(label));
    if (!mskuEntry) return [];
    return mainRows.map((mainRow, index) => {
      const fixedRow = pairedVxeRow(fixedRows, mainRow, index);
      const cellValue = (colid) => rowText(fixedRow, colid) || rowText(mainRow, colid);
      const context = contextIdentity(contextEntry?.[1], cellValue(contextEntry?.[0]));
      const fields = {};
      for (const [colid, label] of allHeaders) {
        const value = cellValue(colid);
        if (label && value) fields[label] = clean(value);
      }
      return {
        identity: productRowIdentity(main, mainRow, {
          msku: identityLine(cellValue(mskuEntry[0]), "msku"),
          store: context.store,
          marketplace: context.marketplace,
          asin: asinEntry ? identityLine(cellValue(asinEntry[0]), "asin") : ""
        }),
        fields
      };
    }).filter((row) => row.identity.msku);
  }

  function scheduleCapture(delay = 300) {
    clearTimeout(captureTimer);
    captureTimer = setTimeout(captureCurrentPage, delay);
  }

  const loadedTableRequests = new Map();
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'LX_FORMAL_LOADED_TABLE_RESULT') return;
    const pending = loadedTableRequests.get(event.data.requestId);
    if (!pending) return;
    loadedTableRequests.delete(event.data.requestId);
    clearTimeout(pending.timer);
    pending.resolve(event.data);
  });

  function loadedTableSamples() {
    if (isSalesPage() || isProductExpressionPage() || routeKind() === 'listing') {
      const mount = findTableMount();
      const main = mount?.querySelector?.('.vxe-table--main-wrapper');
      const fixed = mount?.querySelector?.('.vxe-table--fixed-left-wrapper');
      return main ? vxeRenderedRows(main, fixed).filter(({ master }) => master?.identity?.msku)
        .map(({ mainRow, master, identity }) => ({ rowid: tableRowKey(mainRow), ...master.identity,
          ...Object.fromEntries(Object.entries(identity || {}).filter(([, value]) => clean(value))) })) : [];
    }
    return [...document.querySelectorAll('#fba-wrapper .vxe-table--main-wrapper .vxe-table--body tbody tr')].flatMap((row) => {
      const rowid = tableRowKey(row);
      if (row.classList.contains('special-row')) {
        const text = clean(row.textContent);
        const items = [...row.querySelectorAll('.parent-row-container .item')];
        const property = (label) => clean(items.find((item) => clean(item.querySelector('.label')?.textContent).includes(label))?.querySelector('.value')?.textContent);
        return [{ rowid, kind: 'parent', shipmentId: clean(row.querySelector('.special-container .oneLine.ak-blue-pointer')?.textContent) || text.match(/\bFBA[A-Z0-9]{6,}\b/i)?.[0] || '',
          store: property('店铺'), status: text.match(/\b(SHIPPED|WORKING|RECEIVING|CLOSED|CANCELLED)\b/i)?.[0] || '' }];
      }
      if (!row.classList.contains('loading-row')) return [];
      const text = clean(row.textContent);
      return /展开剩余\s*\d+\s*个商品/.test(text) ? [{ rowid, kind: 'collapsed' }] : /收起/.test(text) ? [{ rowid, kind: 'expanded' }] : [];
    });
  }

  function readLoadedTable(options = {}) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const finish = (result) => resolve(options.action === 'state' ? { ...result, domSignature: currentTableText() } : result);
      const timer = setTimeout(() => { loadedTableRequests.delete(requestId); finish({ ok: false, reason: '已载入业务表读取接口未响应' }); }, 2500);
      loadedTableRequests.set(requestId, { resolve: finish, timer });
      window.postMessage({ type: 'LX_FORMAL_LOADED_TABLE_REQUEST', requestId, samples: ['state', 'setDate', 'pickSalesDate', 'selectSalesMsku', 'querySalesMsku', 'selectProductMsku', 'queryProductMsku', 'selectSourceAsin', 'querySourceAsin', 'rowWindow', 'reveal'].includes(options.action) ? [] : loadedTableSamples(),
        shippedOnly: location.pathname === '/erp/msupply/fbaCargo' && cargoShippedSelected(), ...options }, location.origin);
    });
  }

  async function captureSourceRows() {
    const visible = captureVisibleTable();
    if (!isSalesPage() && !isProductExpressionMskuView() && routeKind() !== 'listing') return visible;
    const loaded = await readLoadedTable();
    if (!loaded.ok || !Array.isArray(loaded.rows)) return visible;
    const rows = loaded.rows.slice(0, 500).filter((row) => row.identity?.msku && row.fields);
    // 合并可见单元格的格式与店铺身份；未在视口里的列从业务表已载入数据读取。
    for (const row of visible) {
      const index = rows.findIndex((item) => normalizeMsku(item.identity.msku) === normalizeMsku(row.identity.msku)
        && (!item.identity.store || !row.identity.store || clean(item.identity.store) === clean(row.identity.store)));
      if (index < 0) rows.push(row);
      else rows[index] = { ...rows[index], identity: { ...rows[index].identity, ...Object.fromEntries(Object.entries(row.identity).filter(([, value]) => clean(value))) }, fields: { ...rows[index].fields, ...row.fields } };
    }
    return rows;
  }

  async function waitLoadedTableSettled(before, requireChange = false, timeoutMs = 15000) {
    const beforeSignature = before?.ok ? before.signature : before?.domSignature;
    const started = Date.now();
    const deadline = started + timeoutMs;
    let lastSignature = '';
    let stableAt = 0;
    let sawLoading = false;
    while (Date.now() < deadline) {
      const current = before?.ok ? await readLoadedTable({ action: 'state' }) : { ok: true, signature: currentTableText() };
      const loading = current.loading || sourceIsLoading();
      sawLoading ||= loading;
      if (!current.ok || loading || current.signature !== lastSignature) stableAt = 0;
      else if (!stableAt) stableAt = Date.now();
      const updated = !requireChange || current.signature !== beforeSignature || sawLoading
        || (current.loadedCount === 0 && Date.now() - started >= 1500);
      if (current.ok && !loading && updated && stableAt && Date.now() - stableAt >= 400) return true;
      lastSignature = current.signature;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }

  async function captureCurrentPage() {
    if (stopped || !routeKind()) return;
    syncRoute();
    const kind = routeKind();
    if (pageSessionKind !== kind) return;
    if (sourceQueryBusy || sourceIsLoading()) { scheduleCapture(400); return; }
    const transitScope = dateRangeKey(pageDateRange());
    const rows = await captureSourceRows();
    if (kind !== routeKind()) return;
    rememberSalesTransitValues(rows, transitScope);
    if (!rows.length) {
      state.captureText = "尚未找到包含 MSKU 的当前页面表格";
      render(); return;
    }
    currentRows = rows;
    const signature = JSON.stringify(rows);
    if (signature === lastCaptureSignature) { injectColumns(); return; }
    lastCaptureSignature = signature;
    const result = await send({ type: "LX_FORMAL_CAPTURE", sourceKind: kind, sourceLabel: currentPageLabel(), capture: { rows, dateRange: kind === "listing" ? null : pageDateRange() } });
    if (kind !== routeKind()) return;
    state.captureText = result?.ok
      ? `已记录当前可见 ${result.visibleRows} 行；${routeLabel(kind)} 字段库累计 ${result.cachedRows} 行`
      : `记录失败：${result?.error || "未知错误"}`;
    if (result?.changed) await refreshLibrary(); else { render(); injectColumns(true); }
  }

  function currentTableText() {
    const mount = findTableMount();
    const bodyText = (body) => [...(body?.querySelectorAll('tr') || [])].map((row) => [...row.querySelectorAll('td:not(.lx-formal-column)')]
      .map((cell) => cell.innerText || cell.textContent || '').join(' ')).join('\n');
    if (mount?.classList?.contains("ak-table-list")) {
      const parts = akTableParts();
      return clean([...new Set([parts?.fixedBody, parts?.mainBody].filter(Boolean))].map(bodyText).join('\n'));
    }
    if (mount?.tagName === "TABLE") return clean(bodyText(mount.tBodies?.[0] || mount));
    return clean([mount?.querySelector('.vxe-table--fixed-left-wrapper tbody'), mount?.querySelector('.vxe-table--main-wrapper tbody')].filter(Boolean).map(bodyText).join('\n'));
  }

  function sourceSearchControls() {
    const visibleSearchAreas = [...document.querySelectorAll(".ak-search-wrapper")]
      .filter(isRendered);
    const scopes = visibleSearchAreas.length ? visibleSearchAreas : [document];
    for (const scope of scopes) {
      const inputs = [...scope.querySelectorAll("input")].filter(isRendered);
      const fuzzyIndex = inputs.findIndex((input) => /模糊|精确/.test(clean(input.value)));
      if (fuzzyIndex < 0) continue;
      let modeIndex = -1;
      for (let index = fuzzyIndex - 1; index >= 0; index -= 1) {
        if (/^(MSKU|SKU|FNSKU|ASIN|父ASIN|SPU|品名)$/i.test(clean(inputs[index].value))) { modeIndex = index; break; }
      }
      if (modeIndex < 0) continue;
      const start = fuzzyIndex + 1;
      const result = inputs.slice(start).find((input) => {
        const type = clean(input.type).toLowerCase();
        return !input.disabled && !input.readOnly && !["checkbox", "radio", "hidden"].includes(type);
      });
      if (result) return { scope, modeInput: inputs[modeIndex], mode: clean(inputs[modeIndex].value), input: result };
    }
    return null;
  }

  async function chooseSourceSearchMode(modeInput, mode) {
    if (!modeInput || !mode) return false;
    if (clean(mode).toUpperCase() === 'ASIN') {
      const selected = await readLoadedTable({ action: 'selectSourceAsin' });
      if (selected?.ok && clean(sourceSearchControls()?.mode).toUpperCase() === 'ASIN') return true;
    }
    const productMsku = typeof isProductExpressionPage === 'function' && isProductExpressionPage();
    if (((typeof isSalesPage === 'function' && isSalesPage()) || productMsku) && clean(mode).toUpperCase() === 'MSKU') {
      const selected = await readLoadedTable({ action: productMsku ? 'selectProductMsku' : 'selectSalesMsku' });
      if (selected?.ok && clean(sourceSearchControls()?.mode).toUpperCase() === 'MSKU') return true;
    }
    modeInput.click();
    const deadline = Date.now() + 1200;
    let fallbackClicked = false;
    while (Date.now() < deadline) {
      const options = [...document.querySelectorAll('[role="option"],.el-select-dropdown__item')]
        .filter(isRendered);
      const target = options.find((option) => clean(option.textContent).toUpperCase() === clean(mode).toUpperCase());
      if (target) {
        target.click();
        const changedDeadline = Date.now() + 800;
        while (Date.now() < changedDeadline) {
          if (clean(modeInput.value).toUpperCase() === clean(mode).toUpperCase()) return true;
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        return clean(modeInput.value).toUpperCase() === clean(mode).toUpperCase();
      }
      if (!fallbackClicked && Date.now() > deadline - 950) {
        fallbackClicked = true;
        modeInput.parentElement?.click();
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return false;
  }

  async function waitForSearchInput(timeoutMs = 5000, requiredMode = "") {
    const deadline = Date.now() + timeoutMs;
    let originalMode = "";
    let lastModeAttempt = 0;
    const modeIsReady = (mode) => requiredMode
      ? clean(mode).toUpperCase() === clean(requiredMode).toUpperCase()
      : /^(MSKU|SKU|FNSKU)$/i.test(mode);
    while (Date.now() < deadline) {
      const controls = sourceSearchControls();
      if (controls) {
        originalMode ||= controls.mode;
        if (modeIsReady(controls.mode)) return { ...controls, originalMode };
        if (Date.now() - lastModeAttempt >= 1500) {
          lastModeAttempt = Date.now();
          await chooseSourceSearchMode(controls.modeInput, requiredMode || "MSKU");
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    const controls = sourceSearchControls();
    return controls && modeIsReady(controls.mode) ? { ...controls, originalMode: originalMode || controls.mode } : null;
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function sourceQueryCandidates(msku, mode) {
    if (mode === 'ASIN') return [normalizeAsin(msku)].filter(Boolean);
    // 产品表现按用户要求直接搜索完整 MSKU，不去站点后缀、不改用 SKU 或短词。
    if (typeof isProductExpressionPage === 'function' && isProductExpressionPage()) return [clean(msku)];
    if (mode === "SKU") return [skuQueryFromMsku(msku)];
    if (!isSalesPage()) return [msku];
    // 销量统计的原始 MSKU 可能把商品名中的连字符写成空格；服务端的“模糊”
    // 搜索仍按原字符匹配。优先复用已抓到的原始拼写，结果再按规范化 MSKU 精确核对。
    const cached = (state.data.datasets?.sales?.rows || [])
      .find((row) => normalizeMsku(row.identity?.msku) === normalizeMsku(msku))?.identity?.msku;
    const parts = clean(msku).split(/[\u2010-\u2015\s-]+/).filter(Boolean);
    const suffix = parts.length > 2 ? parts.slice(-3).join("-") : "";
    const shortSuffix = parts.length > 2 ? parts.slice(-2).join("-") : "";
    return [...new Set([cached, msku, suffix, shortSuffix].map(clean).filter(Boolean))];
  }

  function sourceIsLoading() {
    const scope = location.pathname.replace(/\/+$/, '') === '/erp/msupply/fbaCargo' ? '#fba-wrapper ' : '';
    return [...document.querySelectorAll(`${scope}.vxe-loading--visible,${scope}.vxe-loading.is--visible,${scope}.el-loading-mask,${scope}.ak-loading-mask`)]
      .some((node) => {
        if (!isRendered(node)) return false;
        // 后台页可能延迟 transitionend，退场遮罩即使透明仍占整表尺寸。
        // 不能把它当成未完成请求；真实 VXE loading 状态仍由业务表接口另行核对。
        if (node.classList.contains('el-loading-fade-leave-active') || node.classList.contains('el-loading-fade-leave-to')) return false;
        return Number.parseFloat(getComputedStyle(node).opacity || '1') > 0;
      });
  }

  function submitSourceSearch(input) {
    input.focus();
    // 领星的 lx_combo_search 图标只是装饰节点；点击它不会提交 MSKU 查询。
    // 搜索组件监听输入框的 Enter，必须同时送出 keydown/keyup 以兼容不同业务页。
    for (const type of ["keydown", "keypress", "keyup"]) {
      input.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
    return "enter";
  }

  async function waitForSourceResult(msku, previousText, timeoutMs = 8000, previousState = null) {
    const deadline = Date.now() + timeoutMs;
    const normalized = normalizeMsku(msku);
    const startedAt = Date.now();
    let sawTransition = false;
    let lastText = previousText;
    let stableSince = 0;
    while (Date.now() < deadline) {
      const text = currentTableText();
      const currentState = previousState?.ok ? await readLoadedTable({ action: 'state' }) : null;
      const loading = sourceIsLoading() || currentState?.loading;
      const containsRequested = text.includes(msku) || (normalized && normalizeMsku(text).includes(normalized));
      if (loading || text !== previousText || (currentState?.ok && currentState.signature !== previousState.signature)) sawTransition = true;
      // 恢复旧版“当前页已有目标 MSKU 即可读取”的路径，但必须有业务表日期列作证，
      // 不能仅靠日期输入框的文字把上一期报表当作新数据。
      const existingSalesRow = typeof isSalesPage === 'function' && isSalesPage()
        && containsRequested && salesReportMatchesDate(pageDateRange());
      if (text !== lastText || loading) {
        lastText = text;
        stableSince = 0;
      } else if (!stableSince) stableSince = Date.now();
      // 命中或空结果都必须等待加载结束且 DOM 稳定，防止读到上一轮/过渡态表格。
      if (!loading && (sawTransition || existingSalesRow) && Date.now() - startedAt >= 650 && stableSince && Date.now() - stableSince >= (containsRequested ? 350 : 600)) {
        if (containsRequested || sawTransition) return { settled: true, matched: containsRequested };
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return { settled: false, matched: false };
  }

  function salesReportMatchesDate(range) {
    if (!dateRangeKey(range)) return false;
    const mount = findTableMount();
    if (!mount) return false;
    const days = [...mount.querySelectorAll('.vxe-table--main-wrapper thead th')]
      .map((node) => clean(node.textContent).match(/^(\d{2}-\d{2})(?:\s*周[一二三四五六日天])?$/)?.[1]).filter(Boolean);
    const start = range.start.slice(5);
    const end = range.end.slice(5);
    return days.includes(start) && days.includes(end)
      && days.every((day) => start <= end ? day >= start && day <= end : day >= start || day <= end);
  }

  async function waitSalesReportReady(range, timeoutMs = 8000) {
    const ready = () => dateRangeKey(pageDateRange()) === dateRangeKey(range)
      && !sourceIsLoading() && salesReportMatchesDate(range);
    if (ready()) return true;
    return new Promise((resolve) => {
      let timer;
      const observer = new MutationObserver(() => { if (ready()) finish(true); });
      const finish = (ok) => { clearTimeout(timer); observer.disconnect(); resolve(ok); };
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true });
      timer = setTimeout(() => finish(ready()), timeoutMs);
      if (ready()) finish(true);
    });
  }

  async function saveSourceRows(rows) {
    if (!rows.length) return { ok: true, changed: false };
    currentRows = rows;
    lastCaptureSignature = JSON.stringify(rows);
    return send({ type: "LX_FORMAL_CAPTURE", sourceKind: routeKind(), sourceLabel: currentPageLabel(), capture: { rows, dateRange: routeKind() === "listing" ? null : pageDateRange() } });
  }

  async function runSourceQuery(requestId, requestedMskus, requestedDateRange, requestedLabels = [], matchBy = 'msku') {
    if (sourceQueryBusy) {
      await send({ type: "LX_FORMAL_SOURCE_RESULT", result: { requestId, ok: false, error: "字段来源页正在执行上一批补查" } });
      return;
    }
    sourceQueryBusy = true;
    const asinMatching = matchBy === 'asin' || routeKind() === 'listing';
    const queryLabel = asinMatching ? 'ASIN' : 'MSKU';
    const keyFor = (value) => asinMatching ? normalizeAsin(value) : normalizeMsku(value);
    const rowKey = (row) => keyFor(row.identity?.[asinMatching ? 'asin' : 'msku']);
    const mskus = [...new Set((requestedMskus || []).map(asinMatching ? normalizeAsin : clean).filter(Boolean))].slice(0, BACKFILL_BATCH_SIZE);
    const matched = new Set();
    const requiredLabels = [...new Set(requestedLabels.map(clean).filter(Boolean))].slice(0, 100);
    const hasRequestedFields = (row) => requiredLabels.every((label) => clean(row.fields?.[label]) !== '');
    const missingFields = new Set();
    const completeRows = (rows) => rows.filter((row) => {
      for (const label of requiredLabels) if (!clean(row.fields?.[label])) missingFields.add(label);
      return hasRequestedFields(row);
    });
    const startedAt = Date.now();
    const heartbeat = typeof setInterval === 'function' ? setInterval(() => {
      send({ type: 'LX_FORMAL_SOURCE_HEARTBEAT', requestId });
    }, 5000) : null;
    let input = null;
    let modeInput = null;
    let originalMode = "";
    let originalValue = "";
    let originalDateRange = null;
    let settledQueries = 0;
    let queryMode = "";
    let dateTableConfirmed = true;
    const commitDate = (range) => isSalesPage() ? setSalesDateRange(range, requestId) : setSourceDateRange(range);
    try {
      if (!mskus.length) throw new Error(`没有有效的 ${queryLabel}，不会回退到其他匹配键`);
      const reportPreparation = (stage) => send({ type: "LX_FORMAL_SOURCE_PROGRESS", progress: { requestId, total: mskus.length, completed: 0, matched: 0, currentMsku: stage } });
      await reportPreparation(`等待来源页 ${queryLabel} 查询控件`);
      // 产品表现与销量统计均直接用完整 MSKU 搜索；未返回目标时保留未命中，
      // 不回退到去掉站点后缀的 SKU 搜索。
      // 不能用尚未渲染的 #tab-msku 判断页面类型：后台新页会在业务 DOM 出现前启动补查。
      const productExpression = isProductExpressionPage();
      if ((productExpression || isSalesPage()) && !(await ensureSourceMskuView())) {
        throw new Error(`${productExpression ? "产品表现" : "销量统计"}来源页 8 秒内未就绪，无法切换到 MSKU 业务表`);
      }
      // 先固定视图和搜索类型，再设置日期。类型切换会触发领星筛选栏重建，
      // 放在日期之后可能把刚选好的范围重置。之后只输入 MSKU 并 Enter，不点刷新。
      queryMode = asinMatching ? 'ASIN' : productExpression || ["sales", "listing"].includes(routeKind()) ? "MSKU" : "";
      await reportPreparation(`确认来源页${queryMode || "MSKU"}搜索条件`);
      const controls = await waitForSearchInput(10000, queryMode);
      if (!controls) throw new Error(`来源页搜索条件仍不是 ${queryMode || "MSKU"}；自动切换失败，本批补查已停止`);
      ({ input, modeInput, originalMode } = controls);
      originalValue = input.value || "";
      if (requestedDateRange) {
        await reportPreparation(`设置来源页日期 ${requestedDateRange.start} 至 ${requestedDateRange.end}`);
        originalDateRange = pageDateRange();
        if (!(await commitDate(requestedDateRange))) throw new Error(`来源页日期未提交（${(isSalesPage() ? setSalesDateRange : setSourceDateRange).lastError || '未知阶段'}）；目标 ${dateRangeKey(requestedDateRange)}，当前 ${dateRangeKey(pageDateRange()) || '未读取到日期'}`);
        // 销量按“改日期 → 输入 MSKU → 搜索”提交，不等待整表刷新。
        // 只有当前业务表已经对应目标日期才可批量复用，否则直接逐项搜索并验证结果日期。
        if (isSalesPage()) {
          await reportPreparation(`原生日历已提交，直接输入 ${queryLabel} 搜索`);
          dateTableConfirmed = dateRangeKey(pageDateRange()) === dateRangeKey(requestedDateRange)
            && !sourceIsLoading() && salesReportMatchesDate(requestedDateRange);
          if (!dateTableConfirmed) await reportPreparation(`日期条件已提交；业务表尚未更新，跳过旧表并逐项 ${queryLabel} 搜索验证`);
        } else if (dateRangeKey(originalDateRange) !== dateRangeKey(requestedDateRange) || setSourceDateRange.lastChanged) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          let stableAt = 0;
          let previous = currentTableText();
          for (let attempt = 0; attempt < 45; attempt += 1) {
            const text = currentTableText();
            if (sourceIsLoading() || text !== previous) stableAt = 0;
            else if (!stableAt) stableAt = Date.now();
            if (!sourceIsLoading() && stableAt && Date.now() - stableAt >= 450) break;
            previous = text;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      }
      // 销量统计同一日期的已渲染表格已有可用库存和可售天数。先批量读取
      // 当前页，避免对已在表格中的商品逐个搜索；只对缺失的 MSKU 提交搜索。
      // 不自动修改分页：此页的自定义分页控件可能忽略程序点击，反而拖慢补查。
      if (isSalesPage() && dateTableConfirmed && !clean(originalValue)) {
        await reportPreparation('批量读取销量统计 MSKU 表格');
        // 恢复旧版一次保存同日期的全部可见有效行，后续页面复用，不只保留本批两个 MSKU。
        const bulkRows = completeRows(await captureSourceRows());
        if (requestedDateRange && dateRangeKey(pageDateRange()) !== dateRangeKey(requestedDateRange)) {
          throw new Error('销量统计批量读取期间日期范围发生变化，未保存不匹配数据');
        }
        if (bulkRows.length) {
          const saved = await saveSourceRows(bulkRows);
          if (!saved?.ok) throw new Error(`销量统计批量行未保存：${saved?.error || '未知错误'}`);
          for (const row of bulkRows) matched.add(mskus.find((msku) => keyFor(msku) === rowKey(row)));
          matched.delete(undefined);
        }
      }
      let attemptedQueries = 0;
      for (let index = 0; index < mskus.length; index += 1) {
        if (Date.now() - startedAt >= SOURCE_QUERY_MAX_MS) throw new Error(`本批补查超过 ${SOURCE_QUERY_MAX_MS / 1000} 秒，已停止剩余查询`);
        const msku = mskus[index];
        if (matched.has(msku)) {
          await send({ type: "LX_FORMAL_SOURCE_PROGRESS", progress: { requestId, total: mskus.length, completed: index + 1, matched: matched.size, currentMsku: `${msku}（批量表格已命中）` } });
          continue;
        }
        attemptedQueries += 1;
        let activeControls = sourceSearchControls();
        if (!activeControls || (queryMode && clean(activeControls.mode).toUpperCase() !== queryMode)) {
          await send({ type: "LX_FORMAL_SOURCE_PROGRESS", progress: { requestId, total: mskus.length, completed: index, matched: matched.size, currentMsku: `搜索条件已变化，重新切换到 ${queryMode || "MSKU"}` } });
          activeControls = await waitForSearchInput(4000, queryMode);
          if (!activeControls) throw new Error(`第 ${index + 1} 项查询前无法保持 ${queryMode || "MSKU"} 搜索条件，已停止本批补查`);
          if ((isSalesPage() || productExpression) && requestedDateRange && !(await commitDate(requestedDateRange))) {
            throw new Error('搜索类型重新切换后，无法恢复目标日期，未读取旧表');
          }
        }
        input = activeControls.input;
        modeInput = activeControls.modeInput;
        await send({ type: "LX_FORMAL_SOURCE_PROGRESS", progress: { requestId, total: mskus.length, completed: index, matched: matched.size, currentMsku: msku } });
        let rows = [];
        let settled = false;
        const candidates = sourceQueryCandidates(msku, queryMode);
        for (const [candidateIndex, queryValue] of candidates.entries()) {
          if (Date.now() - startedAt >= SOURCE_QUERY_MAX_MS) break;
          const before = currentTableText();
          const beforeSearchState = asinMatching || isSalesPage() || productExpression ? await readLoadedTable({ action: 'state' }) : null;
          if (requestedDateRange && dateRangeKey(pageDateRange()) !== dateRangeKey(requestedDateRange)) throw new Error('来源页日期在搜索前发生变化，未保存不匹配数据');
          await send({ type: 'LX_FORMAL_SOURCE_PROGRESS', progress: { requestId, total: mskus.length, completed: index,
            matched: matched.size, currentMsku: `${msku}：候选 ${candidateIndex + 1}/${candidates.length}，等待搜索结果（单次最多 8 秒）` } });
          const native = (asinMatching || isSalesPage() || productExpression) && typeof readLoadedTable === 'function'
            ? await readLoadedTable({ action: asinMatching ? 'querySourceAsin' : productExpression ? 'queryProductMsku' : 'querySalesMsku', query: queryValue }) : null;
          if (native?.supported && !native.ok) throw new Error(native.reason || `${queryLabel} 原生搜索提交失败`);
          if (!(native?.ok && native.submitted === queryValue)) {
            setInputValue(input, queryValue);
            await new Promise((resolve) => setTimeout(resolve, 60));
            submitSourceSearch(input);
          }
          const waitResult = await waitForSourceResult(msku, before, 8000, beforeSearchState);
          if (!waitResult.settled) continue;
          settled = true;
          if (requestedDateRange && dateRangeKey(pageDateRange()) !== dateRangeKey(requestedDateRange)) break;
          if (isSalesPage() && requestedDateRange && !salesReportMatchesDate(requestedDateRange)) throw new Error('销量统计搜索结果日期列未对应目标范围，未保存不匹配数据');
          rows = completeRows((await captureSourceRows()).filter((row) => rowKey(row) === keyFor(msku)));
          if (rows.length) break;
        }
        if (settled) settledQueries += 1;
        if (rows.some((row) => rowKey(row) === keyFor(msku))) matched.add(msku);
        await saveSourceRows(rows);
        await send({ type: "LX_FORMAL_SOURCE_PROGRESS", progress: { requestId, total: mskus.length, completed: index + 1, matched: matched.size, currentMsku: msku } });
      }
      if (!settledQueries && attemptedQueries) throw new Error("来源页未检测到搜索请求或表格变化；本次不计入连续未命中");
      await send({ type: "LX_FORMAL_SOURCE_RESULT", result: { requestId, ok: true, requested: mskus.length, matched: matched.size, unresolved: mskus.filter((msku) => !matched.has(msku)),
        note: matched.size < mskus.length && missingFields.size ? `来源页已找到 ${queryLabel}，但尚未读取目标字段：${[...missingFields].join('、')}` : '' } });
    } catch (error) {
      await send({ type: "LX_FORMAL_SOURCE_RESULT", result: { requestId, ok: false, requested: mskus.length, matched: matched.size, unresolved: mskus.filter((msku) => !matched.has(msku)), error: String(error?.message || error) } });
    } finally {
      if (heartbeat !== null) clearInterval(heartbeat);
      try {
        // 销量来源始终是本批临时页，结果回传后即关闭；不再在旧任务结束后重新打开日历恢复筛选。
        if (!isSalesPage() && originalDateRange && dateRangeKey(originalDateRange) !== dateRangeKey(pageDateRange())) {
          await commitDate(originalDateRange);
        }
        let searchModeRestored = false;
        if (!isSalesPage() && originalMode && modeInput?.isConnected && clean(modeInput.value).toUpperCase() !== clean(originalMode).toUpperCase()) {
          searchModeRestored = await chooseSourceSearchMode(modeInput, originalMode);
          input = sourceSearchControls()?.input || input;
        }
        // 销量临时页即将关闭，不清空搜索词再提交第二次查询，避免重置日期或产生迟到响应。
        if (!isSalesPage() && input?.isConnected && (input.value !== originalValue || searchModeRestored)) {
          if (input.value !== originalValue) setInputValue(input, originalValue);
          submitSourceSearch(input);
        }
      } catch (error) {
        console.warn("[领星跨页面字段库] 来源页筛选条件恢复失败", error);
      } finally {
        sourceQueryBusy = false;
      }
    }
  }

  function findMatchingRow(identity, rows) {
    const requestedMsku = clean(identity?.msku);
    const exactCandidates = (rows || []).filter((row) => clean(row.identity?.msku) === requestedMsku);
    const normalizedMsku = normalizeMsku(requestedMsku);
    const normalizedCandidates = exactCandidates.length ? exactCandidates : (rows || []).filter((row) => normalizeMsku(row.identity?.msku) === normalizedMsku);
    const candidates = normalizedCandidates.length === 1 || exactCandidates.length ? normalizedCandidates : [];
    const masterStore = clean(identity.store).toUpperCase();
    const masterMarketplace = normalizeMarketplace(identity.marketplace);
    const exact = candidates.filter((row) => {
      const warehouse = contextIdentity("仓库", row.fields?.仓库);
      const rowStore = clean(row.identity?.store || warehouse.store).toUpperCase();
      const rowMarketplace = normalizeMarketplace(row.identity?.marketplace || warehouse.marketplace);
      return (!masterStore || rowStore === masterStore) && (!masterMarketplace || rowMarketplace === masterMarketplace);
    });
    return exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null;
  }

  function findFieldMatchingRow(identity, rows, field) {
    if (field?.sourceKind === 'listing' || routeKind() === 'listing') return findAsinMatchingRow(identity, rows, field?.label);
    const match = findMatchingRow(identity, rows);
    if (!match || !fbaEstimatedDaysField(field)) return match;
    // 新增预估列不沿用通用匹配器“只有一个候选即回退”的宽松店铺规则。
    // 主表已知店铺/站点时，来源必须有相同上下文，不能拿别店数据替代。
    const store = clean(identity?.store).toUpperCase();
    const marketplace = normalizeMarketplace(identity?.marketplace);
    if (store && clean(match.identity?.store).toUpperCase() !== store) return null;
    if (marketplace && normalizeMarketplace(match.identity?.marketplace) !== marketplace) return null;
    return match;
  }

  function findAsinMatchingRow(identity, rows = [], label = '') {
    const asin = normalizeAsin(identity?.asin);
    if (!asin) return null;
    const store = clean(identity?.store).toUpperCase();
    const marketplace = normalizeMarketplace(identity?.marketplace);
    const rowContext = (row) => {
      const warehouse = contextIdentity('仓库', row.fields?.仓库);
      return { store: clean(row.identity?.store || warehouse.store).toUpperCase(), marketplace: normalizeMarketplace(row.identity?.marketplace || warehouse.marketplace) };
    };
    const candidates = (rows || []).filter((row) => {
      const context = rowContext(row);
      return normalizeAsin(row.identity?.asin) === asin && (!store || context.store === store) && (!marketplace || context.marketplace === marketplace);
    });
    if (candidates.length === 1) return candidates[0];
    if (!label || !candidates.length) return null;
    const contexts = new Set(candidates.map((row) => { const context = rowContext(row); return JSON.stringify([context.store, context.marketplace]); }));
    const values = new Set(candidates.map((row) => clean(row.fields?.[label])));
    return contexts.size === 1 && values.size === 1 && !values.has('') ? candidates[0] : null;
  }

  function acceptBackfillMessage(message) {
    if (!activeBackfill || activeBackfill.sourceKind !== message.sourceKind) return false;
    if (!activeBackfill.requestId && activeBackfill.requesting) activeBackfill.requestId = message.requestId;
    return Boolean(message.requestId && activeBackfill.requestId === message.requestId);
  }

  function checkBackfillTimeout() {
    const pending = activeBackfill;
    if (!pending || !pending.deadline) return;
    if (Date.now() >= pending.deadline) {
      activeBackfill = null;
      const reason = '来源页超过 75 秒未返回结束回执，本批已停止等待';
      backfillFailureReasons.set(pending.sourceKind, reason);
      backfillAttempts.set(pending.signature, Date.now());
      updateBackfill(`${reason}；稍后自动重试`, 'bad');
      if (pending.requestId) send({ type: 'LX_FORMAL_SOURCE_CANCEL', requestId: pending.requestId });
      clearTimeout(libraryRefreshTimer);
      libraryRefreshTimer = setTimeout(refreshLibrary, 250);
      return;
    }
    const waited = Math.floor((Date.now() - (pending.lastProgressAt || pending.startedAt)) / 1000);
    if (waited >= 15 && pending.waitHint !== Math.floor(waited / 10)) {
      pending.waitHint = Math.floor(waited / 10);
      updateBackfill(`${routeLabel(pending.sourceKind)}等待查询回执 ${waited} 秒；最后进度：${pending.lastProgressText || '正在启动来源页'}`, 'running');
    }
  }

  function scheduleSourceBackfill(fields, masters) {
    // 销量与产品表现可互为来源；执行来源查询时不再派生反向补查。
    if (sourceQueryBusy) { clearTimeout(backfillTimer); return; }
    const foreignSources = [...new Set(fields.filter((field) => field.sourceKind !== routeKind()).map((field) => field.sourceKind))];
    if (!foreignSources.length || !masters.length) {
      clearTimeout(backfillTimer);
      updateBackfill("当前未添加其他页面字段，无需补查", "idle");
      return;
    }
    if (activeBackfill) return;
    const pending = foreignSources.map((sourceKind) => {
      const required = fields.filter((field) => field.sourceKind === sourceKind);
      const matchBy = sourceKind === 'listing' || routeKind() === 'listing' ? 'asin' : 'msku';
      const sourceRows = sourceRowsFor(sourceKind);
      const unresolved = [...new Set(masters.filter((master) => {
        return required.some((field) => {
          const match = findFieldMatchingRow(master.identity, sourceRows, field);
          return !match || !clean(match.fields?.[field.label]);
        });
      }).map((master) => matchBy === 'asin' ? normalizeAsin(master.identity?.asin) : clean(master.identity?.msku)).filter(Boolean))];
      const missingAsin = matchBy === 'asin' && masters.some((master) => !normalizeAsin(master.identity?.asin));
      const signature = `${routeKind()}<-${sourceKind}:${matchBy}:${dateRangeKey(masterReportDateRange() || selectedDateRange(sourceKind))}:${unresolved.slice().sort().join("|")}`;
      return { sourceKind, matchBy, missingAsin, unresolved, signature, attemptedAt: backfillAttempts.get(signature) || 0, attempts: backfillAttemptCounts.get(signature) || 0 };
    });
    const missingAsin = pending.some((item) => item.missingAsin);
    const searchable = pending.filter((item) => item.unresolved.length);
    pending.splice(0, pending.length, ...searchable);
    if (!pending.length) {
      clearTimeout(backfillTimer);
      updateBackfill(missingAsin ? '部分行缺少有效 ASIN，无法补查 Listing 关联字段；不回退 MSKU' : `当前可见 ${masters.length} 行：已添加的跨页字段全部命中`, missingAsin ? 'bad' : "success");
      return;
    }
    const next = pending.find((item) => Date.now() - item.attemptedAt >= backfillRetryDelay(item.attempts));
    if (!next) {
      const remainingMs = Math.max(0, Math.min(...pending.map((item) => backfillRetryDelay(item.attempts) - (Date.now() - item.attemptedAt))));
      const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
      const reason = pending.map((item) => backfillFailureReasons.get(item.sourceKind)).find(Boolean);
      updateBackfill(`${reason ? `${reason}；` : `${pending.length} 个来源仍有未命中字段；`}约 ${seconds} 秒后自动补查`, reason ? 'bad' : 'idle');
      clearTimeout(backfillTimer);
      backfillTimer = setTimeout(() => {
        const latestFields = state.selected.map((id) => state.data.fields.find((field) => field.id === id)).filter(Boolean);
        scheduleSourceBackfill(latestFields, currentRows);
      }, remainingMs + 25);
      return;
    }
    const { sourceKind, matchBy, unresolved, signature } = next;
    const queryLabel = matchBy === 'asin' ? 'ASIN' : 'MSKU';
    const batch = unresolved.slice(0, sourceKind === "sales" ? 6 : BACKFILL_BATCH_SIZE);
    updateBackfill(`发现 ${unresolved.length} 个未命中 ${queryLabel}，准备到${routeLabel(sourceKind)}来源页筛查`, "idle");
    clearTimeout(backfillTimer);
    backfillTimer = setTimeout(async () => {
      if (sourceQueryBusy) return;
      backfillAttempts.set(signature, Date.now());
      backfillAttemptCounts.set(signature, (backfillAttemptCounts.get(signature) || 0) + 1);
      updateBackfill(`正在请求${routeLabel(sourceKind)}来源页筛查 ${batch.length} 个 ${queryLabel}…`, "running");
      const pending = { requestId: null, sourceKind, signature, requesting: true, startedAt: Date.now(), deadline: Date.now() + 75_000 };
      activeBackfill = pending;
      const result = await send({ type: "LX_FORMAL_BACKFILL_SOURCE", sourceKind, matchBy, ...(matchBy === 'asin' ? { asins: batch } : { mskus: batch }),
        fieldLabels: fields.filter((field) => field.sourceKind === sourceKind).map((field) => field.label),
        dateRange: (sourceKind === "sales" || sourceKind === PRODUCT_EXPRESSION_KIND || state.data.datasets?.[sourceKind]?.dateRange) ? (masterReportDateRange() || selectedDateRange(sourceKind)) : null });
      if (activeBackfill !== pending) return;
      if (!result?.ok) {
        activeBackfill = null;
        backfillAttempts.set(signature, Date.now());
        updateBackfill(`补查未启动：${result?.error || "未知错误"}；稍后自动重试`, "bad");
        const latestFields = state.selected.map((id) => state.data.fields.find((field) => field.id === id)).filter(Boolean);
        scheduleSourceBackfill(latestFields, currentRows);
      }
      else {
        Object.assign(pending, { requestId: result.requestId, requesting: false,
          deadline: Number.isFinite(result.deadline) ? result.deadline + 5000 : pending.deadline });
        if (result.temporarySource) updateBackfill(`已创建${routeLabel(sourceKind)}后台临时页；不会影响当前页面，准备查询 0/${result.requested}`, "running");
        else if (result.openedSource) updateBackfill(`已在后台打开${routeLabel(sourceKind)}来源页；页面就绪后自动查询 0/${result.requested}`, "running");
        else if (result.refreshingSource) updateBackfill(`检测到${routeLabel(sourceKind)}来源页仍在运行旧版，已自动刷新；页面就绪后继续筛查 0/${result.requested}`, "running");
        else updateBackfill(`沿用已打开的${routeLabel(sourceKind)}来源页筛选条件，开始筛查 0/${result.requested}`, "running");
      }
    }, 700);
  }

  function cleanupColumns(mount = document) {
    mount.querySelectorAll?.(".lx-formal-column,col[data-lx-formal-col]").forEach((node) => node.remove());
    mount.querySelectorAll?.("[data-lx-formal-base-width]").forEach((node) => {
      node.style.width = node.dataset.lxFormalBaseWidth;
      delete node.dataset.lxFormalBaseWidth;
    });
  }

  function expandWidth(node, extra) {
    if (!node) return;
    if (!node.dataset.lxFormalBaseWidth) node.dataset.lxFormalBaseWidth = node.style.width || `${node.getBoundingClientRect().width}px`;
    const base = Number.parseFloat(node.dataset.lxFormalBaseWidth) || node.getBoundingClientRect().width;
    node.style.width = `${base + extra}px`;
  }

  function insertionBeforeColId(main, fixed) {
    const mainHeaders = [...main.querySelectorAll(".vxe-table--header thead th[colid]")];
    const fixedHeaders = fixed ? [...fixed.querySelectorAll("thead th[colid]")] : [];
    const byLabel = (headers, pattern) => headers.find((th) => pattern.test(clean(th.innerText)))?.getAttribute("colid");
    const anchorColId = [
      byLabel(mainHeaders, /店铺|国家|站点/),
      byLabel(fixedHeaders, /店铺|国家|站点/),
      byLabel(mainHeaders, /MSKU/i),
      byLabel(fixedHeaders, /MSKU/i)
    ].find((colid) => colid && mainHeaders.some((th) => th.getAttribute("colid") === colid));
    const anchorIndex = mainHeaders.findIndex((th) => th.getAttribute("colid") === anchorColId);
    // 主表前部还包含固定列的隐藏占位；没有匹配锚点时从首个非固定列前插入。
    return (anchorIndex >= 0
      ? mainHeaders[anchorIndex + 1]
      : mainHeaders.find((th) => !th.classList.contains("col--fixed")))?.getAttribute("colid") || null;
  }

  function vxeRenderedRows(main, fixed) {
    const fixedHeaders = fixed ? headerMap(fixed) : new Map();
    const mainHeaders = headerMap(main);
    const allHeaders = new Map([...fixedHeaders, ...mainHeaders]);
    const mskuEntry = [...allHeaders].find(([, label]) => /MSKU/i.test(label))
      || (isProductExpressionMskuView() ? [...fixedHeaders].find(([, label]) => /商品信息/.test(label)) : null);
    const contextEntry = [...allHeaders].find(([, label]) => /店铺|国家|站点|仓库/.test(label));
    const asinEntry = [...allHeaders].find(([, label]) => /^ASIN/i.test(label));
    const fixedRows = fixed ? [...fixed.querySelectorAll(".vxe-table--body tbody tr")] : [];
    const mainRows = [...main.querySelectorAll(".vxe-table--body tbody tr")];
    return mainRows.map((mainRow, index) => {
      const fixedRow = pairedVxeRow(fixedRows, mainRow, index);
      const cellValue = (colid) => rowText(fixedRow, colid) || rowText(mainRow, colid);
      const context = contextIdentity(contextEntry?.[1], cellValue(contextEntry?.[0]));
      const identity = productRowIdentity(main, mainRow, {
        msku: mskuEntry ? identityLine(cellValue(mskuEntry[0]), "msku") : "",
        store: context.store,
        marketplace: context.marketplace,
        asin: asinEntry ? identityLine(cellValue(asinEntry[0]), "asin") : ""
      });
      const master = findMatchingRow(identity, currentRows) || (identity.msku ? { identity, fields: {} } : null);
      return { mainRow, master, identity };
    });
  }

  function fbaAvailableColId(main) {
    return [...headerMap(main)].find(([, label]) => label === "FBA可售")?.[0] || null;
  }

  const isTransitPage = () => isProductExpressionPage() || isSalesPage();
  const transitColumnLabel = () => isSalesPage() ? '在途数量' : 'FBA标发在途';
  const transitItemIdentity = (item) => isSalesPage() ? item?.identity : item?.master?.identity;

  function transitRowKey(identity) {
    if (!identity?.msku) return "";
    return JSON.stringify([dateRangeKey(pageDateRange()), normalizeMsku(identity.msku), clean(identity.store).toUpperCase(), normalizeMarketplace(identity.marketplace)]);
  }

  function rememberSalesTransitValues(rows, scope) {
    if (!isSalesPage() || !scope || scope !== dateRangeKey(pageDateRange())) return;
    const values = new Map();
    for (const row of rows) {
      const key = transitRowKey(row.identity);
      const value = String(row.transitQuantity ?? '');
      if (!key || !row.identity?.store || !/^\d+$/.test(value)) continue;
      if (!values.has(key)) values.set(key, new Set());
      values.get(key).add(value);
    }
    for (const [key, options] of values) {
      if (options.size === 1) transitValues.set(key, [...options][0]);
      else transitValues.delete(key);
    }
    while (transitValues.size > 1000) transitValues.delete(transitValues.keys().next().value);
  }

  function transitValueFromPopover(reference) {
    const popover = document.getElementById(reference?.getAttribute("aria-describedby") || "");
    if (!popover) return null;
    const detail = [...popover.querySelectorAll(".table-row")].find((row) => ['FBA标发在途', '标发在途'].includes(clean(row.querySelector(".title")?.textContent)));
    if (!detail) return null;
    const value = clean(detail.querySelector(".num")?.textContent).replace(/,/g, "");
    return /^\d+$/.test(value) ? value : null;
  }

  function onTransitNetworkMessage(event) {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== "LX_FORMAL_TRANSIT_ROWS") return;
    if (!isTransitPage() || !Array.isArray(event.data.rows)) return;
    transitNetworkRows = event.data.rows.slice(0, 500).map((row) => ({
      msku: normalizeMsku(row?.msku),
      store: clean(row?.store).toUpperCase(),
      asin: clean(row?.asin).toUpperCase(),
      value: String(row?.value ?? "")
    })).filter((row) => row.msku && /^\d+$/.test(row.value));
    transitNetworkDateKey = /^\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/.test(event.data.dateKey || "") ? event.data.dateKey : "";
    scheduleTransitSync();
  }

  function onCargoNetworkMessage(event) {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== "LX_FORMAL_CARGO_ROWS") return;
    if (location.pathname.replace(/\/+$/, "") !== "/erp/msupply/fbaCargo" || !cargoNetworkCapture || event.data.requestId !== cargoNetworkCapture.requestId) return;
    const wanted = cargoNetworkCapture.msku;
    const incoming = Array.isArray(event.data.rows) ? event.data.rows.slice(0, 20000) : [];
    for (const row of incoming) {
      if ((!cargoNetworkCapture.all && normalizeMsku(row?.msku) !== wanted) || !normalizeMsku(row?.msku) || !clean(row?.shipmentId)) continue;
      const key = `${clean(row.shipmentId)}|${normalizeMsku(row.msku)}|${clean(row.store).toUpperCase()}`;
      const next = {
        shipmentId: clean(row.shipmentId), msku: clean(row.msku), store: clean(row.store), status: clean(row.status),
        declared: clean(row.declared), received: clean(row.received), orderNumber: clean(row.orderNumber),
        shippedAt: clean(row.shippedAt), arrivalAt: clean(row.arrivalAt), shippingMethod: clean(row.shippingMethod)
      };
      cargoNetworkCapture.rows.set(key, { ...cargoNetworkCapture.rows.get(key), ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== '')) });
    }
    for (const order of Array.isArray(event.data.orderRows) ? event.data.orderRows.slice(0, 20000) : []) {
      const shipmentId = clean(order?.shipmentId);
      if (!shipmentId) continue;
      const details = Object.fromEntries(['orderNumber', 'shippedAt', 'arrivalAt', 'shippingMethod'].map((field) => [field, clean(order[field])]).filter(([, value]) => value));
      cargoNetworkCapture.orders.set(shipmentId, { ...cargoNetworkCapture.orders.get(shipmentId), ...details });
      if (!cargoNetworkCapture.all) {
        for (const [key, row] of cargoNetworkCapture.rows) {
          if (row.shipmentId !== shipmentId) continue;
          cargoNetworkCapture.rows.set(key, { ...row, ...details });
        }
      }
    }
    cargoNetworkCapture.totalCount = Math.max(cargoNetworkCapture.totalCount, Number(event.data.totalCount) || 0);
    // 同一页重复返回相同行仍然代表本次筛选有响应，不能误判为没有抓到包。
    if (incoming.length) cargoNetworkCapture.batchCount = (cargoNetworkCapture.batchCount || 0) + 1;
    if (Array.isArray(event.data.orderRows) && event.data.orderRows.length) cargoNetworkCapture.orderBatchCount = (cargoNetworkCapture.orderBatchCount || 0) + 1;
  }

  function cargoDiagnosticText(diagnostic) {
    if (!diagnostic) return '抓包监听尚未启动';
    const loaded = cargoNetworkCapture?.tableDiagnostic;
    const tableText = loaded ? loaded.reason ? `；业务表：${loaded.reason}` : `；业务表 ${loaded.shipments} 票/${loaded.products} 商品行，待展开 ${loaded.collapsed}，未知行 ${loaded.unknown}` : '';
    return `响应 ${diagnostic.responses || 0}（货件接口 ${diagnostic.businessResponses || 0}）；候选 ${diagnostic.candidates || 0}；产品行 ${diagnostic.productRows || 0}；发货单行 ${diagnostic.orderRows || 0}${tableText}；解析错 ${diagnostic.parseErrors || 0}；HTTP错 ${diagnostic.httpErrors || 0}；最近 ${clean(diagnostic.lastPath) || '—'}：${clean(diagnostic.lastReason) || '—'}`;
  }

  function onCargoCaptureStartedMessage(event) {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'LX_FORMAL_CARGO_QUERY_STARTED') return;
    if (cargoNetworkCapture?.requestId === event.data.requestId) cargoNetworkCapture.started = true;
  }

  async function waitCargoCaptureStarted(requestId) {
    for (let i = 0; i < 25; i += 1) {
      if (cargoNetworkCapture?.requestId === requestId && cargoNetworkCapture.started) return;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    throw new Error('货件页抓包监听未确认启动；尚未修改日期或保存快照');
  }

  function onCargoDiagnosticMessage(event) {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'LX_FORMAL_CARGO_DIAGNOSTIC') return;
    if (!cargoNetworkCapture || event.data.requestId !== cargoNetworkCapture.requestId) return;
    cargoNetworkCapture.diagnostic = {
      responses: Number(event.data.responses) || 0, businessResponses: Number(event.data.businessResponses) || 0, candidates: Number(event.data.candidates) || 0,
      productRows: Number(event.data.productRows) || 0, orderRows: Number(event.data.orderRows) || 0,
      parseErrors: Number(event.data.parseErrors) || 0, httpErrors: Number(event.data.httpErrors) || 0,
      lastPath: clean(event.data.lastPath).slice(0, 120), lastReason: clean(event.data.lastReason).slice(0, 100)
    };
    send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_PROGRESS', requestId: cargoNetworkCapture.requestId,
      telemetryOnly: true,
      diagnosticText: cargoDiagnosticText(cargoNetworkCapture.diagnostic) });
  }

  function transitValueFromNetwork(identity) {
    if (!identity?.msku || transitNetworkDateKey !== dateRangeKey(pageDateRange())) return null;
    const msku = normalizeMsku(identity.msku);
    const matches = transitNetworkRows.filter((row) => row.msku === msku);
    if (!matches.length) return null;
    const store = clean(identity.store).toUpperCase();
    const exact = store ? matches.filter((row) => row.store === store) : [];
    if (isSalesPage() && (!store || !exact.length)) return null;
    const candidates = exact.length ? exact : matches.filter((row) => !row.store || !store);
    if (!candidates.length) return null;
    const asin = clean(identity.asin).toUpperCase();
    const asinMatches = asin ? candidates.filter((row) => row.asin === asin) : [];
    const finalRows = asinMatches.length ? asinMatches : candidates;
    const values = [...new Set(finalRows.map((row) => row.value))];
    return values.length === 1 ? values[0] : null;
  }

  function closeTransitDetail() {
    if (activeTransitDetail?.watchdog) clearInterval(activeTransitDetail.watchdog);
    activeTransitDetail = null;
    transitDetailHost?.remove();
    transitDetailHost = null;
  }

  function renderTransitDetail() {
    const detail = activeTransitDetail;
    const shadow = transitDetailHost?.shadowRoot;
    if (!detail || !shadow) return;
    const rect = detail.anchor?.isConnected ? detail.anchor.getBoundingClientRect() : detail.rect;
    const left = Math.max(8, Math.min(innerWidth - 628, rect.left));
    const result = detail.result;
    const sales = detail.view === 'sales';
    const rows = result?.shipments || [];
    const groups = LXShipmentDetail.groupByDate(rows);
    const height = sales ? Math.min(innerHeight - 16, 220 + Math.min(innerHeight * .45, (groups.length + 1) * 36)) : 370;
    const top = Math.max(8, Math.min(innerHeight - height, rect.bottom + 6));
    const status = detail.error ? `<div class="notice error">${esc(detail.error)}</div>`
      : !result ? `<div class="notice">${esc(detail.stage || '正在打开 FBA 货件页…')}</div>`
      : rows.length ? '' : '<div class="notice">查询范围内没有匹配的 SHIPPED 货件。</div>';
    shadow.innerHTML = `<style>
      :host{all:initial;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#172033}
      .box{position:fixed;left:${left}px;top:${top}px;width:min(620px,calc(100vw - 16px));z-index:2147483100;background:#fff;border:1px solid #d7dfeb;border-radius:10px;box-shadow:0 14px 38px #142b4a30;padding:12px;font-size:12px;${sales ? `max-height:calc(100vh - ${top + 8}px);overflow:auto;box-sizing:border-box` : ''}}
      .head{display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:14px;margin-bottom:8px}.close{border:0;background:#edf3fb;border-radius:5px;cursor:pointer;padding:3px 8px}
      .hint{color:#667892;margin-bottom:8px;line-height:1.45}.scroll{max-height:min(45vh,380px);overflow:auto}.grid{display:grid;grid-template-columns:112px 42px 72px 160px 178px;gap:0;min-width:564px;align-items:center}
      .grid>span{padding:7px 5px;border-bottom:1px solid #e5ebf2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.labels{font-weight:700;background:#f2f6fb}.notice{padding:12px;background:#f2f6fb;border-radius:6px}.error{background:#fff0ed;color:#a72d22}
      .foot{display:flex;justify-content:space-between;margin-top:8px;border-top:1px solid #dce5f0;padding-top:9px;font-weight:700}.sum{font-size:16px;color:#1264d6}
      .diag{margin-top:7px;color:#53667d;line-height:1.45;word-break:break-word}
      .arrival-table{width:100%;border-collapse:collapse;text-align:left;font-variant-numeric:tabular-nums}.arrival-table th,.arrival-table td{padding:8px 12px;border-bottom:1px solid #e5ebf2}.arrival-table th{background:#f2f6fb}.arrival-table th:last-child,.arrival-table td:last-child{text-align:right}
    </style><div class="box"><div class="head"><span>${sales ? '在途数量 · 预计到货明细' : 'FBA标发在途 · SHIPPED 货件明细'}</span><button class="close" aria-label="关闭" type="button">×</button></div>
      <div class="hint">${esc(detail.identity.msku)}${detail.identity.store ? ` · ${esc(detail.identity.store)}` : ''}；每票在途量＝该产品申报量－签收量，按预计到货日合并。${result?.scope ? `货件创建时间筛选：${esc(result.scope)}` : ''}</div>${status}
      <div class="diag">抓包计数：${esc(detail.diagnostic || '尚未收到货件页抓包回执')}</div>
      ${groups.length ? sales ? `<div class="scroll"><table class="arrival-table" aria-label="在途数量预计到货明细"><thead><tr><th>预计到货日期</th><th>在途数量</th></tr></thead><tbody>${groups.map((group) => `<tr><td>${esc(group.arrivalDay || '待确认')}</td><td>${group.quantity}</td></tr>`).join('')}</tbody></table></div>` : `<div class="scroll"><div class="grid labels"><span>预计到货日</span><span>票数</span><span>在途量</span><span>发货单号</span><span>发货时间</span></div>${groups.map((group) => `<div class="grid"><span>${esc(group.arrivalDay || '待确认')}</span><span>${group.shipmentCount} 票</span><span>${group.quantity}</span><span title="${esc(group.orderNumbers.join('、'))}">${esc(group.orderNumbers.join('、') || '—')}</span><span title="${esc(group.shippedAts.join('、'))}">${esc(group.shippedAts.join('、') || '—')}</span></div>`).join('')}</div>` : ''}
      ${result ? `<div class="foot"><span>${result.complete ? sales ? '在途数量总计' : `筛选范围内 SHIPPED 途中数量总计（${rows.length} 票）` : `仅已载入 ${rows.length} 票；货件页未载入全部结果，不能确认总计`}</span><span class="sum">${result.complete ? result.total : '—'}</span></div>` : ''}
      ${result?.orderMissing ? `<div class="hint" style="margin-top:8px">${result.orderMissing} 票货件未取得发货单详情；相应日期或单号显示为“—”。</div>` : ''}
      ${groups.some((group) => !group.arrivalDay) ? `<div class="hint" style="margin-top:8px">待确认：美国/墨西哥缺少系统预计到货日；其他站点须有发货时间及明确物流渠道（普船/铁路 +60 天、加班船 +30 天、空派 +14 天）。缺少依据不猜测。待确认货件的渠道：${esc([...new Set(rows.filter((row) => !row.arrivalDay).map((row) => clean(row.shippingMethod) || '未取得'))].join('、'))}。</div>` : ''}
      ${result?.complete && detail.columnValue !== '待读取' && String(result.total) !== String(detail.columnValue) ? `<div class="hint" style="margin-top:8px">领星库存明细显示 ${esc(detail.columnValue)}；货件合计与库存口径不同，未覆盖原列。</div>` : ''}
    </div>`;
    shadow.querySelector('.close')?.addEventListener('click', closeTransitDetail);
  }

  async function onTransitColumnClick(event) {
    const column = event.target?.closest?.('td.lx-fba-transit-column');
    if (!column) {
      if (activeTransitDetail?.view === 'sales' && !event.composedPath?.().includes(transitDetailHost)) closeTransitDetail();
      return;
    }
    if (!isTransitPage()) return;
    event.preventDefault(); event.stopPropagation();
    const row = column.closest('tr');
    const mount = findTableMount();
    const main = mount?.querySelector?.('.vxe-table--main-wrapper');
    const fixed = mount?.querySelector?.('.vxe-table--fixed-left-wrapper');
    const item = main && vxeRenderedRows(main, fixed).find((entry) => entry.mainRow === row);
    const identity = transitItemIdentity(item);
    if (!identity?.msku || (isSalesPage() && (!identity.store || /^[-—]+$/.test(clean(identity.msku))))) return;
    if (isSalesPage() && activeTransitDetail?.anchor === column && transitRowKey(activeTransitDetail.identity) === transitRowKey(identity)) { closeTransitDetail(); return; }
    closeTransitDetail();
    transitDetailHost = document.createElement('div');
    transitDetailHost.id = 'lx-formal-transit-detail-host';
    transitDetailHost.attachShadow({ mode: 'open' });
    document.documentElement.append(transitDetailHost);
    activeTransitDetail = { identity, view: isSalesPage() ? 'sales' : 'product', anchor: column, rect: column.getBoundingClientRect(), columnValue: clean(column.querySelector('.lx-transit-value')?.textContent), result: null, error: '',
      stage: '正在抓取近 6 个月全部 SHIPPED 货件并建立本次会话缓存…', diagnostic: '', lastProgressAt: Date.now() };
    renderTransitDetail();
    const watched = activeTransitDetail;
    watched.watchdog = setInterval(() => {
      if (activeTransitDetail !== watched || watched.result || watched.error) { clearInterval(watched.watchdog); return; }
      if (watched.stalled || Date.now() - watched.lastProgressAt < 15_000) return;
      watched.stage = `诊断：15 秒未收到新进度；最后停在“${watched.stage}”。`;
      watched.stalled = true;
      renderTransitDetail();
    }, 5_000);
    const response = await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_QUERY', identity: { msku: identity.msku, store: identity.store } });
    if (!activeTransitDetail || activeTransitDetail.identity !== identity) return;
    if (response?.ok) {
      activeTransitDetail.requestId = response.requestId;
      if (response.cached) {
        activeTransitDetail.result = cargoSnapshotResult(response.rows, identity, response.complete, response.scope);
        activeTransitDetail.stage = '已使用本次浏览器会话的全部 SHIPPED 货件缓存';
        renderTransitDetail();
      }
      if (activeTransitDetail.pendingMessage?.requestId === response.requestId) {
        const pending = activeTransitDetail.pendingMessage;
        activeTransitDetail.error = pending.error || '';
        activeTransitDetail.result = pending.type === 'LX_FORMAL_CARGO_SNAPSHOT_ROWS' && !pending.error
          ? cargoSnapshotResult(pending.rows, identity, pending.complete, pending.scope) : pending.result || null;
        renderTransitDetail();
      }
    }
    else { activeTransitDetail.error = response?.error || '货件页查询未启动'; renderTransitDetail(); }
  }

  function cargoSnapshotResult(rows, identity, complete, scope) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const count = new Set(safeRows.map((row) => clean(row.shipmentId)).filter(Boolean)).size;
    const result = LXShipmentDetail.fromRows(safeRows, identity, count);
    result.complete = complete === true && (safeRows.length === 0 || result.complete);
    result.scope = clean(scope);
    result.orderMissing = new Set(safeRows.filter((row) => !clean(row.orderNumber)).map((row) => clean(row.shipmentId))).size;
    return result;
  }

  function cargoProductRows(state = null, observed = null) {
    const main = document.querySelector('#fba-wrapper .vxe-table--main-wrapper');
    if (!main) return [];
    const headers = headerMap(main);
    const col = (pattern) => [...headers].find(([, label]) => pattern.test(label))?.[0] || '';
    const mskuCol = col(/^MSKU$/i);
    const declaredCol = col(/^申报量/);
    const receivedCol = col(/^签收量/);
    if (!mskuCol || !declaredCol || !receivedCol) return [];
    const result = [];
    const parents = state?.parents || new Map();
    let parent = null;
    for (const row of main.querySelectorAll('.vxe-table--body tbody tr')) {
      const rowId = row.getAttribute('rowid');
      if (row.classList.contains('special-row')) {
        const items = [...row.querySelectorAll('.parent-row-container .item')];
        const property = (label) => clean(items.find((item) => clean(item.querySelector('.label')?.textContent).includes(label))?.querySelector('.value')?.textContent);
        const parentText = clean(row.querySelector('.special-container')?.textContent || row.textContent);
        parent = {
          shipmentId: clean(row.querySelector('.special-container .oneLine.ak-blue-pointer')?.textContent)
            || (parentText.match(/\bFBA[A-Z0-9]{6,}\b/i)?.[0] || ''),
          store: property('店铺'),
          arrivalWindow: property('送达时段'),
          shippingMethod: property('运输方式'),
          status: clean([...row.querySelectorAll('.status-action .ak-tag-container .text-slot')]
            .map((node) => node.textContent).find((value) => /^(SHIPPED|WORKING|RECEIVING|CLOSED|CANCELLED)$/i.test(clean(value))))
            || (parentText.match(/\b(SHIPPED|WORKING|RECEIVING|CLOSED|CANCELLED)\b/i)?.[0] || '')
        };
        if (rowId && parent.shipmentId) parents.set(rowId, parent);
        if (parent.shipmentId) observed?.shipments.add(parent.shipmentId);
        continue;
      }
      // 虚拟滚动的首行可能属于上一票货件，不能沿用上次扫描的最后一票。
      // 同一页的 VXE rowid 是逻辑行标识；重叠区可恢复首行真正的父货件。
      if (!parent && rowId) parent = parents.get(rowId) || null;
      if (parent && rowId) parents.set(rowId, parent);
      if (row.classList.contains('loading-row')) {
        if (parent?.shipmentId && /^SHIPPED$/i.test(parent.status) && /展开剩余\s*\d+\s*个商品/.test(clean(row.textContent))) {
          observed?.collapsed.push({ shipmentId: parent.shipmentId, row });
        }
        continue;
      }
      if (!parent) continue;
      const msku = identityLine(rowText(row, mskuCol), 'msku');
      const declared = rowText(row, declaredCol);
      const received = rowText(row, receivedCol);
      if (msku) result.push({ ...parent, msku, declared, received });
    }
    if (state) state.parents = parents;
    return result;
  }

  function cargoTableSignature(wrapper) {
    const rows = [...(wrapper.querySelectorAll?.('tbody tr') || [])];
    return `${rows.length}|${rows[0]?.getAttribute('rowid') || ''}|${rows.at(-1)?.getAttribute('rowid') || ''}|${wrapper.scrollHeight}`;
  }

  function cargoViewportCovered(wrapper) {
    const rows = [...(wrapper.querySelectorAll?.('tbody tr') || [])];
    const viewport = wrapper.getBoundingClientRect?.();
    const first = rows[0]?.getBoundingClientRect?.();
    const last = rows.at(-1)?.getBoundingClientRect?.();
    return Boolean(viewport && first && last && first.top <= viewport.top + 3
      && last.bottom >= viewport.top + wrapper.clientHeight - 3);
  }

  function cargoNextScrollTop(wrapper, ratio = 0.7) {
    const rows = [...(wrapper.querySelectorAll?.('tbody tr') || [])];
    const viewport = wrapper.getBoundingClientRect?.();
    // 一次已读取整个预渲染窗口，无需每次只向下挪 35% 视口再空等 500ms。
    // 保留至少两行重叠，用既有 rowid→父货件关联接续被回收的父行。
    const overlapRow = rows.at(-2)?.getBoundingClientRect?.();
    const covered = viewport && overlapRow ? overlapRow.top - viewport.top : 0;
    return Math.min(wrapper.scrollHeight - wrapper.clientHeight,
      wrapper.scrollTop + Math.max(40, Math.floor(wrapper.clientHeight * ratio), covered));
  }

  function waitCargoTableRender(wrapper, previous, timeoutMs = 500, acceptCoveredViewport = false) {
    if (cargoTableSignature(wrapper) !== previous) return Promise.resolve();
    // 滚动仍在已读取的预渲染区内时，VXE 可能根本不替换 DOM；这不是等待中的请求。
    if (acceptCoveredViewport && cargoViewportCovered(wrapper)) return Promise.resolve();
    return new Promise((resolve) => {
      let finished = false;
      let timer;
      let observer;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        observer?.disconnect();
        wrapper.removeEventListener?.('scroll', onScroll);
        resolve();
      };
      const onScroll = () => queueMicrotask(() => {
        if (cargoTableSignature(wrapper) !== previous) finish();
      });
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(() => {
          if (cargoTableSignature(wrapper) !== previous) finish();
        });
        observer.observe(wrapper, { childList: true, subtree: true, attributes: true, attributeFilter: ['rowid', 'class', 'style'] });
      }
      wrapper.addEventListener?.('scroll', onScroll, { once: true });
      timer = setTimeout(finish, timeoutMs);
    });
  }

  async function readCargoLoadedCoverage(expected) {
    if (typeof readLoadedTable !== 'function') return null;
    const loaded = await readLoadedTable();
    if (!loaded.ok || !Array.isArray(loaded.rows) || !Array.isArray(loaded.shipments) || !Array.isArray(loaded.collapsed)) return null;
    if (cargoNetworkCapture) cargoNetworkCapture.tableDiagnostic = {
      shipments: loaded.shipments.length, products: loaded.rows.length, collapsed: loaded.collapsed.length, unknown: loaded.unknownRows || 0
    };
    const productShipments = new Set(loaded.rows.map((row) => row.shipmentId)).size;
    const complete = loaded.shipments.length === expected && productShipments === expected
      && loaded.collapsed.length === 0 && loaded.unknownRows === 0
      && loaded.rows.every((row) => row.msku && row.store && /^SHIPPED$/i.test(row.status)
        && /^\d+$/.test(row.declared) && /^\d+$/.test(row.received));
    return { ...loaded, complete };
  }

  async function collectCargoProductPage(expected, report) {
    const wrapper = document.querySelector('#fba-wrapper .vxe-table--main-wrapper .vxe-table--body-wrapper');
    if (!wrapper) throw new Error('货件产品表格未就绪，无法回退读取页面');
    const rows = new Map();
    const shipments = new Set();
    const state = { parents: new Map() };
    const attempted = new Map();
    const deadline = Date.now() + 180_000;
    let reachedEdge = false;
    let direction = 1;
    let sweep = 0;
    let lastProgress = 0;
    const initialSignature = cargoTableSignature(wrapper);
    const initialTop = wrapper.scrollTop;
    wrapper.scrollTop = 0;
    if (initialTop) await waitCargoTableRender(wrapper, initialSignature);
    while (Date.now() < deadline) {
      const observed = { shipments, collapsed: [] };
      for (const row of cargoProductRows(state, observed)) {
        rows.set(`${row.shipmentId}|${normalizeMsku(row.msku)}|${clean(row.store).toUpperCase()}`, row);
      }
      const unexpanded = observed.collapsed.find(({ shipmentId, row }) =>
        (attempted.get(shipmentId) || 0) < 2 && row.querySelector('.demo-block-control .title'));
      if (unexpanded) {
        // VXE 会把视口外的行预渲染出来。直接点击这种行有时不会触发业务展开；
        // 先滚到控件，再重新定位（滚动会回收并复用旧的 tr 节点）。
        // 展开后必须返回原扫描位置，否则跳到预渲染行会漏掉中间的货件。
        const resumeTop = wrapper.scrollTop;
        const beforeReveal = cargoTableSignature(wrapper);
        unexpanded.row.scrollIntoView?.({ block: 'center', inline: 'nearest' });
        if (wrapper.scrollTop !== resumeTop) await waitCargoTableRender(wrapper, beforeReveal);
        const visible = { shipments, collapsed: [] };
        for (const row of cargoProductRows(state, visible)) {
          rows.set(`${row.shipmentId}|${normalizeMsku(row.msku)}|${clean(row.store).toUpperCase()}`, row);
        }
        const current = visible.collapsed.find(({ shipmentId }) => shipmentId === unexpanded.shipmentId);
        if (!current) {
          attempted.set(unexpanded.shipmentId, (attempted.get(unexpanded.shipmentId) || 0) + 1);
          const beforeRestore = cargoTableSignature(wrapper);
          const revealTop = wrapper.scrollTop;
          wrapper.scrollTop = resumeTop;
          if (revealTop !== resumeTop) await waitCargoTableRender(wrapper, beforeRestore);
          continue;
        }
        const control = current.row.querySelector('.demo-block-control .title');
        if (!control) throw new Error(`货件 ${current.shipmentId} 的剩余商品展开控件未就绪，未保存不完整快照`);
        attempted.set(current.shipmentId, (attempted.get(current.shipmentId) || 0) + 1);
        const beforeExpand = cargoTableSignature(wrapper);
        control.click();
        // 不能凭旧节点断开连接就认定完成：虚拟列表可能仅仅回收了它。
        // 下一轮重新扫描实际可见行；仍是“展开剩余”才重试，最多两次。
        await waitCargoTableRender(wrapper, beforeExpand, 900);
        const beforeRestore = cargoTableSignature(wrapper);
        const expandedTop = wrapper.scrollTop;
        wrapper.scrollTop = resumeTop;
        if (expandedTop !== resumeTop) await waitCargoTableRender(wrapper, beforeRestore);
        continue;
      }
      if (observed.collapsed.length) {
        throw new Error(`货件 ${observed.collapsed[0].shipmentId} 的剩余商品无法展开，未保存不完整快照`);
      }
      if (Date.now() - lastProgress > 4000) {
        lastProgress = Date.now();
        await report(`网络包未解析出产品行；正在核对页面表格 ${shipments.size}/${expected} 票，滚动 ${Math.round(wrapper.scrollTop)}/${Math.round(wrapper.scrollHeight)}…`);
      }
      const edge = direction > 0
        ? wrapper.scrollTop + wrapper.clientHeight >= wrapper.scrollHeight - 3
        : wrapper.scrollTop <= 3;
      if (edge) {
        reachedEdge = true;
        const productShipments = new Set([...rows.values()].map((row) => row.shipmentId)).size;
        if ((shipments.size >= expected && productShipments >= expected) || sweep >= 2) break;
        sweep += 1;
        direction *= -1;
        await report(`产品表核对 ${shipments.size}/${expected} 票、取得 ${productShipments}/${expected} 票商品；从${direction < 0 ? '底部向上' : '顶部向下'}进行第 ${sweep + 1} 遍密集复扫…`);
        continue;
      }
      const before = wrapper.scrollTop;
      const beforeAdvance = cargoTableSignature(wrapper);
      const stepRatio = sweep === 0 ? 0.35 : sweep === 1 ? 0.15 : 0.1;
      wrapper.scrollTop = Math.max(0, Math.min(wrapper.scrollHeight,
        before + direction * Math.max(40, Math.floor(wrapper.clientHeight * stepRatio))));
      if (wrapper.scrollTop === before) break;
      await waitCargoTableRender(wrapper, beforeAdvance);
    }
    const productShipments = new Set([...rows.values()].map((row) => row.shipmentId)).size;
    if (!reachedEdge || shipments.size < expected || productShipments < expected) {
      throw new Error(`货件产品表格仅核对 ${shipments.size}/${expected} 票、取得 ${productShipments}/${expected} 票商品${reachedEdge ? '' : `（滚动 ${Math.round(wrapper.scrollTop)}/${Math.round(wrapper.scrollHeight)}，未完成整页扫描）`}，未保存不完整快照`);
    }
    return { rows: [...rows.values()], shipmentCount: shipments.size };
  }

  // 保留 v1.4.54 的可见行展开路径，按实际预渲染范围推进，不用固定小步消耗整页时限。
  async function collectCargoLegacyProductPage(expected, report) {
    const wrapper = document.querySelector('#fba-wrapper .vxe-table--main-wrapper .vxe-table--body-wrapper');
    if (!wrapper) throw new Error('货件产品表格未就绪，无法回退读取页面');
    const rows = new Map();
    const shipments = new Set();
    const state = { parents: new Map() };
    const attempted = new Map();
    const startedAt = Date.now();
    const deadline = startedAt + 360_000;
    const visited = new Set();
    let lastDataProgress = startedAt;
    let advance = null;
    let stepLimit = Infinity;
    let denseMode = false;
    let lastWindow = '';
    let lastModelCheck = -Infinity;
    let steps = 0;
    let bottom = false;
    let sweep = 0;
    let lastProgress = 0;
    const initialSignature = cargoTableSignature(wrapper);
    const initialTop = wrapper.scrollTop;
    wrapper.scrollTop = 0;
    if (initialTop) await waitCargoTableRender(wrapper, initialSignature, 500, true);
    while (Date.now() < deadline) {
      if (wrapper.isConnected === false) throw new Error('货件产品表在扫描中被替换，已停止，未保存不完整快照');
      steps += 1;
      const windowRowIds = [...(wrapper.querySelectorAll?.('tbody tr') || [])].map((row) => row.getAttribute('rowid')).filter(Boolean);
      if (!denseMode && advance && windowRowIds.length && !windowRowIds.some((id) => visited.has(id))) {
        // 变高行可能让 VXE 换入的窗口比几何位置预期更靠后；没有重叠就退半步，绝不略过。
        stepLimit = Math.floor((wrapper.scrollTop - advance.from) / 2);
        if (stepLimit < 40) {
          // 真实业务表可能重排 rowid 或自动修正滚动位置；不能仅凭行号变更否定整页。
          denseMode = true;
          stepLimit = Math.max(40, Math.floor(wrapper.clientHeight * 0.35));
          advance = null;
          const beforeRestart = cargoTableSignature(wrapper);
          wrapper.scrollTop = 0;
          lastDataProgress = Date.now();
          await report('虚拟窗口发生重排；改用重叠小步扫描，并以整页业务数据核对完整性…');
          await waitCargoTableRender(wrapper, beforeRestart, 500, true);
          continue;
        }
        const beforeRetry = cargoTableSignature(wrapper);
        wrapper.scrollTop = advance.from + stepLimit;
        await waitCargoTableRender(wrapper, beforeRetry, 500, true);
        continue;
      }
      advance = null;
      const windowKey = windowRowIds.join('|');
      if (windowKey && windowKey !== lastWindow) { lastDataProgress = Date.now(); lastWindow = windowKey; }
      const beforeCount = rows.size + shipments.size + visited.size;
      const observed = { shipments, collapsed: [] };
      for (const row of cargoProductRows(state, observed)) {
        rows.set(`${row.shipmentId}|${normalizeMsku(row.msku)}|${clean(row.store).toUpperCase()}`, row);
      }
      for (const rowId of windowRowIds) visited.add(rowId);
      if (rows.size + shipments.size + visited.size > beforeCount) lastDataProgress = Date.now();
      if (Date.now() - lastModelCheck >= 4000) {
        lastModelCheck = Date.now();
        const loaded = await readCargoLoadedCoverage(expected);
        if (loaded?.complete) {
          await report(`整页业务数据已核齐 ${expected}/${expected} 票、${loaded.rows.length} 商品行；待展开 0、未知行 0`);
          return { rows: loaded.rows, shipmentCount: expected };
        }
      }
      if (Date.now() - lastDataProgress > 30_000) {
        throw new Error(`货件产品表 30 秒未出现新数据；核对 ${shipments.size}/${expected} 票，滚动 ${Math.round(wrapper.scrollTop)}/${Math.round(wrapper.scrollHeight)}，未保存不完整快照`);
      }
      const unexpanded = observed.collapsed.find(({ shipmentId, row }) =>
        (attempted.get(shipmentId) || 0) < 2 && row.querySelector('.demo-block-control .title'));
      if (unexpanded) {
        // VXE 会把视口外的行预渲染出来。直接点击这种行有时不会触发业务展开；
        // 先滚到控件，再重新定位（滚动会回收并复用旧的 tr 节点）。
        // 展开后必须返回原扫描位置，否则跳到预渲染行会漏掉中间的货件。
        const resumeTop = wrapper.scrollTop;
        const beforeReveal = cargoTableSignature(wrapper);
        unexpanded.row.scrollIntoView?.({ block: 'center', inline: 'nearest' });
        if (wrapper.scrollTop !== resumeTop) await waitCargoTableRender(wrapper, beforeReveal, 500, true);
        const visible = { shipments, collapsed: [] };
        for (const row of cargoProductRows(state, visible)) {
          rows.set(`${row.shipmentId}|${normalizeMsku(row.msku)}|${clean(row.store).toUpperCase()}`, row);
        }
        const current = visible.collapsed.find(({ shipmentId }) => shipmentId === unexpanded.shipmentId);
        if (!current) {
          attempted.set(unexpanded.shipmentId, (attempted.get(unexpanded.shipmentId) || 0) + 1);
          const beforeRestore = cargoTableSignature(wrapper);
          const revealTop = wrapper.scrollTop;
          wrapper.scrollTop = resumeTop;
          if (revealTop !== resumeTop) await waitCargoTableRender(wrapper, beforeRestore, 500, true);
          continue;
        }
        const control = current.row.querySelector('.demo-block-control .title');
        if (!control) throw new Error(`货件 ${current.shipmentId} 的剩余商品展开控件未就绪，未保存不完整快照`);
        attempted.set(current.shipmentId, (attempted.get(current.shipmentId) || 0) + 1);
        const beforeExpand = cargoTableSignature(wrapper);
        control.click();
        // 不能凭旧节点断开连接就认定完成：虚拟列表可能仅仅回收了它。
        // 下一轮重新扫描实际可见行；仍是“展开剩余”才重试，最多两次。
        await waitCargoTableRender(wrapper, beforeExpand, 900);
        const expanded = await readCargoLoadedCoverage(expected);
        if (expanded?.complete) return { rows: expanded.rows, shipmentCount: expected };
        const beforeRestore = cargoTableSignature(wrapper);
        const expandedTop = wrapper.scrollTop;
        wrapper.scrollTop = resumeTop;
        if (expandedTop !== resumeTop) await waitCargoTableRender(wrapper, beforeRestore, 500, true);
        continue;
      }
      if (observed.collapsed.length) {
        throw new Error(`货件 ${observed.collapsed[0].shipmentId} 的剩余商品无法展开，未保存不完整快照`);
      }
      if (Date.now() - lastProgress > 4000) {
        lastProgress = Date.now();
        await report(`正在读取 SHIPPED 产品表 ${shipments.size}/${expected} 票、${rows.size} 商品行；滚动 ${Math.round(wrapper.scrollTop)}/${Math.round(wrapper.scrollHeight)}，${steps} 步/${Math.round((Date.now() - startedAt) / 1000)} 秒…`);
      }
      bottom = wrapper.scrollTop + wrapper.clientHeight >= wrapper.scrollHeight - 3;
      if (bottom) {
        const productShipments = new Set([...rows.values()].map((row) => row.shipmentId)).size;
        if ((shipments.size >= expected && productShipments >= expected) || sweep >= 2) break;
        sweep += 1;
        await report(`产品表首次到底只核对 ${shipments.size}/${expected} 票；从顶部进行第 ${sweep + 1} 遍密集复扫…`);
        const beforeRestart = cargoTableSignature(wrapper);
        wrapper.scrollTop = 0;
        bottom = false;
        await waitCargoTableRender(wrapper, beforeRestart, 500, true);
        continue;
      }
      const before = wrapper.scrollTop;
      const beforeAdvance = cargoTableSignature(wrapper);
      wrapper.scrollTop = Math.min(cargoNextScrollTop(wrapper, sweep === 0 ? 0.7 : 0.45), before + stepLimit);
      if (wrapper.scrollTop === before) break;
      advance = { from: before };
      await waitCargoTableRender(wrapper, beforeAdvance, 500, true);
    }
    let loaded = await readCargoLoadedCoverage(expected);
    if (loaded?.complete) return { rows: loaded.rows, shipmentCount: expected };
    if (loaded?.collapsed.length) {
      // 展开会把原“展开剩余”行移到全部商品之后，当前虚拟窗口通常看不到“点击收起”。
      // 按业务行编号逐个回访，看到收起才登记完成；不能只在点击后原地采样就判定仍未展开。
      await report(`整页仍有 ${loaded.collapsed.length} 票展开状态待确认；正在逐票回访末尾控件…`);
      const verified = await collectCargoLoadedPage(expected, report);
      if (verified) return verified;
      loaded = await readCargoLoadedCoverage(expected) || loaded;
    }
    if (loaded && (loaded.collapsed.length || loaded.unknownRows)) {
      throw new Error(`货件业务表仍有 ${loaded.collapsed.length} 票待展开、${loaded.unknownRows} 未知行${collectCargoLoadedPage.lastError ? `；${collectCargoLoadedPage.lastError}` : ''}，未保存不完整快照`);
    }
    const productShipments = new Set([...rows.values()].map((row) => row.shipmentId)).size;
    if (!bottom || shipments.size < expected || productShipments < expected) {
      throw new Error(`货件产品表格仅核对 ${shipments.size}/${expected} 票、取得 ${productShipments}/${expected} 票商品${bottom ? '' : `（滚动 ${Math.round(wrapper.scrollTop)}/${Math.round(wrapper.scrollHeight)}，未到底）`}；${steps} 步/${Math.round((Date.now() - startedAt) / 1000)} 秒${Date.now() >= deadline ? '，达到单页安全上限' : ''}，未保存不完整快照`);
    }
    return { rows: [...rows.values()], shipmentCount: shipments.size };
  }

  async function revealCargoControl(pending, deadline) {
    const wrapper = document.querySelector('#fba-wrapper .vxe-table--main-wrapper .vxe-table--body-wrapper');
    if (!wrapper) return { row: null, reason: '虚拟表滚动容器未就绪' };
    const rowInWindow = () => [...document.querySelectorAll('#fba-wrapper .vxe-table--main-wrapper tbody tr')]
      .find((node) => tableRowKey(node) === pending.rowid);
    const before = cargoTableSignature(wrapper);
    const revealed = await readLoadedTable({ action: 'reveal', rowid: pending.rowid });
    if (!revealed.ok) return { row: null, reason: revealed.reason || '业务行定位失败' };
    await waitCargoTableRender(wrapper, before, 400);
    let low = 0;
    let high = Math.max(0, wrapper.scrollHeight - wrapper.clientHeight);
    let measuredMax = high;
    let lastWindow = null;
    for (let step = 0; step < 24 && Date.now() < deadline; step += 1) {
      const row = rowInWindow();
      if (row) {
        // VXE 会预渲染不可见行。先滚入视口，再取最新节点，避免点到回收前的旧引用。
        const signature = cargoTableSignature(wrapper);
        const top = wrapper.scrollTop;
        row.scrollIntoView?.({ block: 'center', inline: 'nearest' });
        if (top !== wrapper.scrollTop) await waitCargoTableRender(wrapper, signature, 400);
        const current = rowInWindow();
        if (current?.querySelector('.demo-block-control .title')) return { row: current };
      }
      const window = await readLoadedTable({ action: 'rowWindow', rowid: pending.rowid });
      lastWindow = window;
      if (!window.ok || window.targetIndex < 0 || window.firstIndex < 0) break;
      // VXE 在渲染过程中继续校正行高，旧的二分上界不能截掉新增长的末尾区域。
      const currentMax = Math.max(0, wrapper.scrollHeight - wrapper.clientHeight);
      if (currentMax !== measuredMax) { low = 0; high = currentMax; measuredMax = currentMax; }
      // scrollToRow 对展开后变高的虚拟行可能估算不准；用实际渲染的业务索引二分回访。
      if (window.targetIndex < window.firstIndex) high = Math.min(high, wrapper.scrollTop - 1);
      else if (window.targetIndex > window.lastIndex) low = Math.max(low, wrapper.scrollTop + 1);
      else break;
      if (low > high) break;
      const signature = cargoTableSignature(wrapper);
      wrapper.scrollTop = Math.max(0, Math.min(currentMax, Math.floor((low + high) / 2)));
      await waitCargoTableRender(wrapper, signature, 400);
    }
    return { row: null, reason: `定位 ${pending.shipmentId || '未知货件'}/${pending.rowid} 失败，目标索引 ${lastWindow?.targetIndex ?? '未知'}、窗口 ${lastWindow?.firstIndex ?? '未知'}-${lastWindow?.lastIndex ?? '未知'}、滚动 ${Math.round(wrapper.scrollTop)}/${wrapper.scrollHeight}` };
  }

  async function collectCargoLoadedPage(expected, report) {
    collectCargoLoadedPage.lastError = '';
    const resolvedRows = new Set();
    const attempts = new Map();
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const loaded = await readLoadedTable({ resolvedRows: [...resolvedRows] });
      if (cargoNetworkCapture) cargoNetworkCapture.tableDiagnostic = loaded.ok ? {
        shipments: loaded.shipments?.length || 0, products: loaded.rows?.length || 0, collapsed: loaded.collapsed?.length || 0, unknown: loaded.unknownRows || 0
      } : { reason: clean(loaded.reason).slice(0, 90) };
      if (!loaded.ok || !Array.isArray(loaded.shipments) || !loaded.shipments.length) return null;
      const productShipments = new Set((loaded.rows || []).map((row) => row.shipmentId)).size;
      await report(`已读取业务表 ${loaded.shipments.length}/${expected} 票、${productShipments}/${expected} 票商品；剩余待展开 ${loaded.collapsed?.length || 0} 票…`);
      const pending = loaded.collapsed?.[0];
      if (!pending) {
        if (loaded.unknownRows !== 0 || loaded.shipments.length !== expected || productShipments !== expected
          || loaded.rows.some((row) => !row.msku || !row.store || !/^SHIPPED$/i.test(row.status)
            || !/^\d+$/.test(row.declared) || !/^\d+$/.test(row.received))) return null;
        return { rows: loaded.rows, shipmentCount: loaded.shipments.length };
      }
      const tried = attempts.get(pending.rowid) || 0;
      if (tried >= 3 || !pending.rowid) {
        collectCargoLoadedPage.lastError ||= `${pending.shipmentId || '未知货件'}/${pending.rowid || '无行号'} 重试 3 次仍未确认展开`;
        return null;
      }
      attempts.set(pending.rowid, tried + 1);
      const located = await revealCargoControl(pending, deadline);
      const row = located.row;
      if (!row) { collectCargoLoadedPage.lastError = located.reason; continue; }
      const control = row?.querySelector('.demo-block-control .title');
      if (!control) continue;
      if (/展开剩余\s*\d+\s*个商品/.test(clean(row.textContent))) {
        const wrapper = document.querySelector('#fba-wrapper .vxe-table--main-wrapper .vxe-table--body-wrapper');
        const before = cargoTableSignature(wrapper);
        control.click();
        await waitCargoTableRender(wrapper, before, 1200);
      } else if (/收起/.test(clean(row.textContent))) {
        // 已展开后的“收起”占位行仍使用 loading-row 样式，不能再次当成缺失商品。
        resolvedRows.add(pending.rowid);
      } else {
        collectCargoLoadedPage.lastError = `${pending.shipmentId || '未知货件'}/${pending.rowid} 控件状态为「${clean(row.textContent).slice(0, 60)}」`;
      }
    }
    collectCargoLoadedPage.lastError ||= '业务行回访超过 120 秒';
    return null;
  }

  function cargoSearchControls() {
    const scope = document.querySelector('#fba-wrapper .ak-search-wrapper .ak-advanced-input__new');
    const modeInput = scope?.querySelector('.field-select input');
    const matchInput = scope?.querySelector('.search-mode-select input');
    const input = scope?.querySelector('.search-input input:not([readonly])');
    if (!scope || !modeInput || !matchInput || !input || !isRendered(scope)) return null;
    return { scope, modeInput, mode: clean(modeInput.value), matchInput, matchMode: clean(matchInput.value), input };
  }

  async function chooseCargoSearchMode(modeInput, mode) {
    if (!modeInput?.isConnected) return false;
    if (clean(modeInput.value).toUpperCase() === mode.toUpperCase()) return true;
    // 货件页把可见选项传送到 body；select 内另有一套 display:none 的同名选项。
    // 点击隐藏副本不会改变业务筛选，必须先打开菜单，再选可见弹层中的选项。
    modeInput.focus();
    modeInput.click();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (!modeInput.isConnected) return false;
      const options = [...document.querySelectorAll('.el-select-dropdown__item')].filter(isRendered);
      const target = options.find((node) => clean(node.textContent).toUpperCase() === mode.toUpperCase());
      if (target) {
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        target.click();
        for (let check = 0; check < 8; check += 1) {
          if (clean(modeInput.value).toUpperCase() === mode.toUpperCase()) return true;
          await new Promise((resolve) => setTimeout(resolve, 70));
        }
        return false;
      }
      if (attempt === 4) {
        const select = modeInput.closest('.el-select');
        select?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        select?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        select?.click();
      }
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
    return false;
  }

  async function waitForCargoMskuSearch(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let lastSwitch = 0;
    let lastControls = null;
    while (Date.now() < deadline) {
      const controls = cargoSearchControls();
      if (controls) lastControls = controls;
      if (controls?.mode.toUpperCase() === 'MSKU') {
        if (controls.matchMode !== '模糊') await chooseCargoSearchMode(controls.matchInput, '模糊');
        const current = cargoSearchControls();
        if (current?.mode.toUpperCase() === 'MSKU' && current.matchMode === '模糊') return current;
      }
      if (controls && Date.now() - lastSwitch > 900) {
        lastSwitch = Date.now();
        await chooseCargoSearchMode(controls.modeInput, 'MSKU');
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!lastControls) throw new Error('货件页搜索栏未就绪，无法定位 MSKU 输入框');
    const visibleOptions = [...document.querySelectorAll('.el-select-dropdown__item')].filter(isRendered).length;
    throw new Error(`货件页搜索条件不是 MSKU＋模糊：当前「${lastControls.mode || '空'}＋${lastControls.matchMode || '空'}」，可见选项 ${visibleOptions} 个，页面${document.hidden ? '在后台' : '可见'}`);
  }

  function cargoShipmentOrderRows() {
    const main = document.querySelector('#fba-wrapper .vxe-table--main-wrapper');
    if (!main) return [];
    const headers = headerMap(main);
    const fixed = document.querySelector('#fba-wrapper .vxe-table--fixed-left-wrapper');
    const fixedHeaders = fixed ? headerMap(fixed) : new Map();
    const col = (label) => [...headers].find(([, value]) => value === label)?.[0] || '';
    const shipmentCol = [...fixedHeaders].find(([, value]) => value === '货件单号')?.[0] || col('货件单号');
    const orderCol = col('发货单');
    const statusCol = col('货件状态');
    if (!shipmentCol || !orderCol || !statusCol) return [];
    const fixedRows = fixed ? [...fixed.querySelectorAll('.vxe-table--body tbody tr')] : [];
    return [...main.querySelectorAll('.vxe-table--body tbody tr')].map((row, index) => ({
      // 固定列还包含 STA 标签；整格文字如 "FBA15...\nSTA" 不能与产品视图的货件号匹配。
      shipmentId: cargoShipmentId(pairedVxeRow(fixedRows, row, index), shipmentCol) || cargoShipmentId(row, shipmentCol),
      orderNumber: rowText(row, orderCol), status: rowText(row, statusCol).split(/\s+/)[0],
      orderCell: row.querySelector(`td[colid="${CSS.escape(orderCol)}"]`)
    })).filter((row) => row.shipmentId && row.orderNumber);
  }

  function cargoShipmentId(row, colid) {
    const cell = row?.querySelector(`td[colid="${CSS.escape(colid)}"]`);
    const label = clean(cell?.querySelector('.oneLine.ak-blue-pointer')?.textContent);
    return label || clean(rowText(row, colid).match(/\bFBA[A-Z0-9]+\b/i)?.[0]);
  }

  async function collectCargoRows(reader, enrich = null, options = {}) {
    const wrapper = document.querySelector('#fba-wrapper .vxe-table--main-wrapper .vxe-table--body-wrapper');
    if (!wrapper) return [];
    const collected = new Map();
    const deadline = Date.now() + (options.maxMs || 5000);
    wrapper.scrollTop = 0;
    for (let step = 0; step < (options.maxSteps || 90) && Date.now() < deadline; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 70));
      for (const row of reader()) {
        if (Date.now() >= deadline) break;
        const key = `${row.shipmentId}|${row.msku || ''}`;
        if (options.wantedShipments && !options.wantedShipments.has(row.shipmentId)) continue;
        if (row.shipmentId && !collected.has(key)) {
          await options.report?.(`正在读取发货单 ${collected.size + 1}/${options.wantedShipments?.size || '?'}：${row.shipmentId}…`);
          collected.set(key, enrich ? { ...row, ...await enrich(row, deadline) } : row);
        }
      }
      if (options.wantedShipments && [...options.wantedShipments].every((id) => [...collected.values()].some((row) => row.shipmentId === id))) break;
      const bottom = wrapper.scrollTop + wrapper.clientHeight >= wrapper.scrollHeight - 3;
      if (bottom) break;
      const before = wrapper.scrollTop;
      wrapper.scrollTop = Math.min(wrapper.scrollHeight, before + Math.max(120, Math.floor(wrapper.clientHeight * (options.stepRatio || 0.62))));
      if (wrapper.scrollTop === before) break;
    }
    return [...collected.values()];
  }

  async function cargoOrderDates(orderCell, deadline = Date.now() + 3000) {
    const reference = orderCell?.querySelector('.complex-popover-container .el-popover__reference');
    if (!reference) return {};
    reference.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    reference.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    try {
      while (Date.now() < deadline) {
        // 发货单弹层是懒加载的，aria-describedby 可能到悬停后才出现；
        // “弹层节点存在”也不代表发货单请求已经完成，须等待其实际表头和数据行。
        const id = reference.getAttribute('aria-describedby');
        const popover = id ? document.getElementById(id) : null;
        const headers = [...(popover?.querySelectorAll('thead th') || [])].map((node) => clean(node.textContent));
        const cells = [...(popover?.querySelectorAll('tbody tr:first-child td') || [])].map((node) => clean(node.textContent));
        if (headers.some((header) => /发货单号/.test(header)) && cells.length >= headers.length && cells.some(Boolean)) {
          const value = (pattern) => cells[headers.findIndex((header) => pattern.test(header))] || '';
          return { orderNumber: value(/发货单号/), shippedAt: value(/发货时间/), arrivalAt: value(/到货时间/), shippingMethod: value(/物流渠道/) || value(/运输方式/) };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {};
    } finally {
      reference.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    }
  }

  function cargoPageCount() {
    const total = Number(clean(document.querySelector('#fba-wrapper .el-pagination__total')?.textContent).match(/共\s*(\d+)\s*条/)?.[1]);
    return Number.isSafeInteger(total) ? total : -1;
  }

  function cargoStatusSelect() {
    const selects = [...document.querySelectorAll('#fba-wrapper .ak-search-wrapper > .el-select')];
    const placeholder = (select) => clean(select?.querySelector('.fake-placeholder')?.textContent);
    // 选中状态后领星会把本控件的“货件状态”占位字清空，须按两侧筛选器定位。
    return selects.find((select) => placeholder(select) === '货件状态') ||
      selects.find((select, index) => placeholder(selects[index - 1]) === '货件类型' &&
        placeholder(selects[index + 1]) === '关联发货单') || null;
  }

  function cargoShippedSelected() {
    const select = cargoStatusSelect();
    const tags = [...(select?.querySelectorAll('.el-select__tags-text') || [])].map((tag) => clean(tag.textContent));
    return tags.length === 1 && tags[0] === 'SHIPPED';
  }

  async function chooseCargoShippedStatus() {
    if (cargoShippedSelected()) return false;
    const select = cargoStatusSelect();
    if (!select || !isRendered(select)) throw new Error('货件状态筛选控件未就绪');
    select.querySelector('input.el-input__inner')?.click();
    let dropdown = null;
    for (let i = 0; i < 20 && !dropdown; i += 1) {
      dropdown = [...document.querySelectorAll('.el-select-dropdown')].find((node) =>
        isRendered(node) && node.querySelector('.el-select-dropdown__item[title="SHIPPED"]'));
      if (!dropdown) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!dropdown) throw new Error('货件状态下拉框没有 SHIPPED 选项');
    for (const option of dropdown.querySelectorAll('.el-select-dropdown__item.selected')) {
      if (option.getAttribute('title') !== 'SHIPPED') option.click();
    }
    const shipped = dropdown.querySelector('.el-select-dropdown__item[title="SHIPPED"]');
    if (!shipped.classList.contains('selected')) shipped.click();
    const confirm = [...dropdown.querySelectorAll('button')].find((button) => clean(button.textContent) === '确定');
    if (!confirm) throw new Error('货件状态筛选缺少确定按钮');
    confirm.click();
    for (let i = 0; i < 40 && !cargoShippedSelected(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!cargoShippedSelected()) throw new Error('货件状态未切换为仅 SHIPPED');
    return true;
  }

  async function cargoPageSize500() {
    const size = document.querySelector('#fba-wrapper .el-pagination__sizes .el-select');
    if (!size) throw new Error('货件页分页控件未就绪');
    const label = () => clean(size.querySelector('input.el-input__inner')?.value);
    if (/500条\/页/.test(label())) return false;
    size.querySelector('input.el-input__inner')?.click();
    for (let i = 0; i < 20; i += 1) {
      const option = [...document.querySelectorAll('.el-select-dropdown__item')].find((node) => isRendered(node) && clean(node.textContent) === '500条/页');
      if (option) { option.click(); break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (let i = 0; i < 35 && !/500条\/页/.test(label()); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!/500条\/页/.test(label())) throw new Error('货件页无法自动切换为 500 条/页');
    return true;
  }

  async function waitCargoPacket(previous, kind, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    let unparsedSince = 0;
    while (Date.now() < deadline) {
      const count = kind === 'order' ? cargoNetworkCapture?.orderBatchCount : cargoNetworkCapture?.batchCount;
      if (count > previous && !sourceIsLoading()) return;
      // 接口已经返回候选 JSON、却始终没有产品行时，继续等待同一解析器没有意义；
      // 及早改走经过完整性核对的页面表格，避免每个日期段白等 12 秒。
      const diagnostic = cargoNetworkCapture?.diagnostic;
      if (kind === 'product' && diagnostic?.candidates > 0 && diagnostic.productRows === 0 && !sourceIsLoading()) {
        unparsedSince ||= Date.now();
        if (Date.now() - unparsedSince >= 1200) throw new Error('货件产品网络响应未解析出商品行，改用页面表格核对');
      } else unparsedSince = 0;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error(`货件页${kind === 'order' ? '发货单' : '产品'}网络数据未返回，未保存不完整快照`);
  }

  function waitCargoIdle(timeoutMs = 15000) {
    if (!sourceIsLoading()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let finished = false;
      const finish = (idle) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(idle);
      };
      const observer = new MutationObserver(() => {
        if (!sourceIsLoading()) finish(true);
      });
      observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
      const timer = setTimeout(() => finish(!sourceIsLoading()), timeoutMs);
    });
  }

  async function runCargoSnapshot(requestId) {
    if (location.pathname.replace(/\/+$/, '') !== '/erp/msupply/fbaCargo') return;
    if (sourceQueryBusy) {
      await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_READY', requestId, error: '启动前失败：FBA 货件页正在执行其他查询', complete: false });
      return;
    }
    sourceQueryBusy = true;
    const report = async (stage) => {
      if (cargoNetworkCapture) cargoNetworkCapture.stage = stage;
      const response = await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_PROGRESS', requestId, stage,
        diagnosticText: cargoDiagnosticText(cargoNetworkCapture?.diagnostic) });
      if (!response?.ok) throw new Error(`货件任务进度回传失败：${response?.error || '后台未确认'}，已停止扫描`);
    };
    // 不依赖后台全局变量存活；周期回执可唤醒并恢复已登记的任务。
    // 它只更新诊断，不假冒新的业务进度或覆盖真实卡点。
    const heartbeat = setInterval(() => {
      send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_PROGRESS', requestId, telemetryOnly: true,
        diagnosticText: cargoDiagnosticText(cargoNetworkCapture?.diagnostic) });
    }, 5000);
    try {
      cargoNetworkCapture = { requestId, all: true, started: false, rows: new Map(), orders: new Map(), totalCount: 0, batchCount: 0, orderBatchCount: 0, diagnostic: null };
      window.postMessage({ type: 'LX_FORMAL_CARGO_QUERY_START', requestId, all: true }, location.origin);
      await waitCargoCaptureStarted(requestId);
      await report('已进入货件页扫描函数；等待产品视图…');
      let productRadio = null;
      for (let i = 0; i < 80 && !productRadio; i += 1) {
        productRadio = document.querySelector('label[role="radio"] input[value="product"]')?.closest('label');
        if (!productRadio) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!productRadio) throw new Error('FBA 货件产品视图未就绪');
      if (productRadio.getAttribute('aria-checked') !== 'true' && !productRadio.querySelector('input')?.checked) productRadio.click();
      if (!(await waitCargoIdle())) throw new Error('货件产品视图加载超过 15 秒，未开始日期筛选');
      await report('正在先筛选 SHIPPED 货件，之后仅核对运输中的逐商品数据…');
      const beforeStatusTable = await readLoadedTable({ action: 'state' });
      const statusChanged = !cargoShippedSelected();
      await chooseCargoShippedStatus();
      if (!(await waitCargoIdle())) throw new Error('SHIPPED 货件筛选后产品表加载超过 15 秒');
      if (!(await waitLoadedTableSettled(beforeStatusTable, statusChanged))) throw new Error('SHIPPED 条件已选中，但货件业务表未返回对应数据');
      const fullRange = cargoSixMonthRange();
      const windows = cargoScanWindows(fullRange);
      const combined = new Map();
      let focusedForDom = false;
      const ensureCargoForeground = async () => {
        if (focusedForDom) return;
        await report('接口缺少完整单品或发货单数据；正在临时显示货件页以读取虚拟滚动表…');
        const focus = await send({ type: 'LX_FORMAL_CARGO_FOCUS_SOURCE', requestId });
        if (!focus?.ok) throw new Error('无法将货件虚拟滚动表切到前台，未保存不完整快照');
        focusedForDom = true;
      };
      let totalCargo = 0;
      let totalPages = 0;
      for (const [windowIndex, dateRange] of windows.entries()) {
        const wantedDateKey = dateRangeKey(dateRange);
        cargoNetworkCapture.rows = new Map();
        cargoNetworkCapture.orders = new Map();
        cargoNetworkCapture.totalCount = 0;
        const radio = document.querySelector('label[role="radio"] input[value="product"]')?.closest('label');
        if (radio && radio.getAttribute('aria-checked') !== 'true' && !radio.querySelector('input')?.checked) radio.click();
        if (!(await waitCargoIdle())) throw new Error(`第 ${windowIndex + 1} 段产品视图加载超过 15 秒`);
        if (!cargoShippedSelected()) throw new Error(`第 ${windowIndex + 1} 段开始前 SHIPPED 筛选已丢失，未保存不完整快照`);
        const dateChanged = dateRangeKey(pageDateRange()) !== wantedDateKey;
        const beforeDateTable = await readLoadedTable({ action: 'state' });
        const beforeDate = cargoNetworkCapture.batchCount;
        await report(`正在扫描第 ${windowIndex + 1}/${windows.length} 段创建时间：${dateRange.start} 至 ${dateRange.end}…`);
        if (!(await setSourceDateRange(dateRange))) throw new Error(`货件创建时间无法设置为 ${dateRange.start} 至 ${dateRange.end}（${setSourceDateRange.lastError || '未知阶段'}）；页面实际为 ${dateRangeKey(pageDateRange()) || '未读取到日期'}`);
        if (!(await waitCargoIdle())) throw new Error(`第 ${windowIndex + 1} 段日期已选定，但产品表加载超过 15 秒`);
        if (dateRangeKey(pageDateRange()) !== wantedDateKey) throw new Error(`第 ${windowIndex + 1} 段创建时间在加载后发生变化`);
        const beforeSize = cargoNetworkCapture.batchCount;
        const sizeChanged = await cargoPageSize500();
        if (!(await waitLoadedTableSettled(beforeDateTable, dateChanged || setSourceDateRange.lastChanged || sizeChanged))) throw new Error(`第 ${windowIndex + 1} 段日期已选中，但货件业务表未更新，未读取旧分页数据`);
        let usePageRows = !sizeChanged && !dateChanged;
        if (!usePageRows) {
          try { await waitCargoPacket(sizeChanged ? beforeSize : beforeDate, 'product'); }
          catch (error) {
            if (cargoNetworkCapture.batchCount > (sizeChanged ? beforeSize : beforeDate)) throw error;
            await report(`第 ${windowIndex + 1} 段未解析出产品包；${cargoDiagnosticText(cargoNetworkCapture.diagnostic)}。改用页面表格核对…`);
            usePageRows = true;
          }
        }
        if (dateRangeKey(pageDateRange()) !== wantedDateKey) throw new Error(`第 ${windowIndex + 1} 段创建时间在分页前发生变化`);
        if (!cargoShippedSelected()) throw new Error(`第 ${windowIndex + 1} 段日期筛选后 SHIPPED 状态已丢失`);
        const total = cargoPageCount();
        if (total < 0) throw new Error('货件页未返回分页总数');
        const pages = Math.max(1, Math.ceil(total / 500));
        if (pages > 100) throw new Error(`货件共 ${total} 条、超过单次安全扫描上限；未保存不完整快照`);
        const pageRows = new Map();
        const readPageFallback = async (page) => {
          await ensureCargoForeground();
          const expected = Math.min(500, total - (page - 1) * 500);
          const pageReport = (stage) => report(`第 ${windowIndex + 1}/${windows.length} 段、第 ${page}/${pages} 页：${stage}`);
          // 主链路恢复 v1.4.54 的可见行展开，不再先用 VXE scrollToRow 定位占位行。
          const scanned = await collectCargoLegacyProductPage(expected, pageReport);
          for (const row of scanned.rows) pageRows.set(`${row.shipmentId}|${normalizeMsku(row.msku)}|${clean(row.store).toUpperCase()}`, row);
        };
        if (usePageRows && total) await readPageFallback(1);
        for (let page = 2; page <= pages; page += 1) {
          await report(`第 ${windowIndex + 1}/${windows.length} 段：抓取产品第 ${page}/${pages} 页…`);
          const before = cargoNetworkCapture.batchCount;
          const beforePageTable = await readLoadedTable({ action: 'state' });
          const next = document.querySelector('#fba-wrapper .el-pagination .btn-next');
          if (!next || next.disabled) throw new Error(`货件产品第 ${page} 页不可达`);
          next.click();
          if (!(await waitLoadedTableSettled(beforePageTable, true))) throw new Error(`货件产品第 ${page} 页未返回新的业务表数据`);
          let pageFallback = usePageRows;
          if (!pageFallback) {
            try { await waitCargoPacket(before, 'product'); }
            catch (error) {
              if (cargoNetworkCapture.batchCount > before) throw error;
              pageFallback = true;
            }
          }
          const active = Number(clean(document.querySelector('#fba-wrapper .el-pagination .el-pager li.active')?.textContent));
          if (active !== page) throw new Error(`货件产品翻页未生效：期望 ${page}，实际 ${active || '未知'}`);
          if (pageFallback) await readPageFallback(page);
        }
        const allProducts = new Map(cargoNetworkCapture.rows);
        for (const [key, row] of pageRows) allProducts.set(key, { ...allProducts.get(key), ...row });
        if ([...allProducts.values()].some((row) => !/^SHIPPED$/i.test(row.status))) {
          throw new Error(`第 ${windowIndex + 1} 段混入非 SHIPPED 货件，未保存不完整快照`);
        }
        const parsedShipments = new Set([...allProducts.values()].map((row) => clean(row.shipmentId)).filter(Boolean)).size;
        if (parsedShipments < total) throw new Error(`第 ${windowIndex + 1} 段货件产品仅核对 ${parsedShipments}/${total} 票，未保存不完整快照`);
        const products = [...allProducts.values()].filter((row) => /^SHIPPED$/i.test(row.status));
        if (products.some((row) => !/^\d+$/.test(row.declared) || !/^\d+$/.test(row.received))) throw new Error('SHIPPED 货件单品申报量或签收量缺失，未缓存不完整数据');
        const wantedShipments = new Set(products.map((row) => row.shipmentId));
        if (products.some((row) => {
          const order = cargoNetworkCapture.orders.get(row.shipmentId);
          return !order?.orderNumber || !order?.shippedAt || (/-US$|-MX$/i.test(row.store) ? !order?.arrivalAt : !order?.shippingMethod);
        })) {
          await report(`第 ${windowIndex + 1} 段已核对 ${parsedShipments}/${total} 票，正在读取发货单与到货时间…`);
          await ensureCargoForeground();
          await report(`第 ${windowIndex + 1} 段正在切换货件视图，准备读取 ${wantedShipments.size} 票发货单…`);
          const orderRadio = document.querySelector('label[role="radio"] input[value="order"]')?.closest('label');
          orderRadio?.click();
          for (let i = 0; i < 50 && ![...headerMap(document.querySelector('#fba-wrapper .vxe-table--main-wrapper') || document.createElement('div')).values()].includes('发货单'); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          for (let i = 0; i < 50 && sourceIsLoading(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
          const orderRows = await collectCargoRows(cargoShipmentOrderRows, async (row, deadline) =>
            wantedShipments.has(row.shipmentId) && /^SHIPPED$/i.test(row.status) ? cargoOrderDates(row.orderCell, Math.min(deadline, Date.now() + 3000)) : {},
          { maxMs: 45_000, maxSteps: 700, stepRatio: 0.45, wantedShipments, report: (stage) => report(`第 ${windowIndex + 1} 段：${stage}`) });
          for (const row of orderRows) {
            if (!wantedShipments.has(row.shipmentId) || !/^SHIPPED$/i.test(row.status)) continue;
            const previous = cargoNetworkCapture.orders.get(row.shipmentId) || {};
            cargoNetworkCapture.orders.set(row.shipmentId, { ...previous, ...Object.fromEntries(
              ['orderNumber', 'shippedAt', 'arrivalAt', 'shippingMethod'].map((key) => [key, clean(row[key])]).filter(([, value]) => value)) });
          }
        }
        if (dateRangeKey(pageDateRange()) !== wantedDateKey) throw new Error(`第 ${windowIndex + 1} 段创建时间在扫描后发生变化，未保存不完整快照`);
        for (const row of products) {
          const key = `${row.shipmentId}|${normalizeMsku(row.msku)}|${clean(row.store).toUpperCase()}`;
          combined.set(key, { ...combined.get(key), ...row, ...cargoNetworkCapture.orders.get(row.shipmentId) });
        }
        totalCargo += total;
        totalPages += pages;
        await report(`已完成第 ${windowIndex + 1}/${windows.length} 段，累计核对 ${totalCargo} 票、${combined.size} 商品行…`);
      }
      await report(`六个月货件已核对完成，正在保存 ${totalCargo} 票、${combined.size} 商品行的完整会话快照…`);
      await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_READY', requestId, rows: [...combined.values()], totalCargo, pages: totalPages,
        scope: `创建时间 ${fullRange.start} 至 ${fullRange.end}（分 ${windows.length} 段）`, complete: true });
    } catch (error) {
      await send({ type: 'LX_FORMAL_CARGO_SNAPSHOT_READY', requestId,
        error: `${String(error?.message || error)}；失败时抓包：${cargoDiagnosticText(cargoNetworkCapture?.diagnostic)}`.slice(0, 500), complete: false });
    } finally {
      clearInterval(heartbeat);
      window.postMessage({ type: 'LX_FORMAL_CARGO_QUERY_STOP', requestId }, location.origin);
      if (cargoNetworkCapture?.requestId === requestId) cargoNetworkCapture = null;
      sourceQueryBusy = false;
    }
  }

  async function runFocusedTransitDetailQuery(requestId, identity) {
    if (location.pathname.replace(/\/+$/, '') !== '/erp/msupply/fbaCargo') return;
    if (sourceQueryBusy) {
      await send({ type: 'LX_FORMAL_TRANSIT_DETAIL_RESULT', requestId, error: 'FBA 货件页正在执行其他查询' });
      return;
    }
    sourceQueryBusy = true;
    const report = (stage) => send({ type: 'LX_FORMAL_TRANSIT_DETAIL_PROGRESS', requestId, stage,
      diagnosticText: cargoDiagnosticText(cargoNetworkCapture?.diagnostic) });
    try {
      cargoNetworkCapture = { requestId, all: true, started: false, rows: new Map(), orders: new Map(), totalCount: 0, batchCount: 0, orderBatchCount: 0, diagnostic: null };
      window.postMessage({ type: 'LX_FORMAL_CARGO_QUERY_START', requestId, all: true }, location.origin);
      await waitCargoCaptureStarted(requestId);
      await report('正在显示货件页，按 MSKU 筛选并核对完整商品行…');
      const focus = await send({ type: 'LX_FORMAL_TRANSIT_FOCUS_SOURCE', requestId });
      if (!focus?.ok) throw new Error('无法显示货件页，不能可靠读取虚拟表格');
      let productRadio = null;
      for (let i = 0; i < 80 && !productRadio; i += 1) {
        productRadio = document.querySelector('label[role="radio"] input[value="product"]')?.closest('label');
        if (!productRadio) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!productRadio) throw new Error('FBA 货件产品视图未就绪');
      if (productRadio.getAttribute('aria-checked') !== 'true' && !productRadio.querySelector('input')?.checked) productRadio.click();
      for (let i = 0; i < 50 && ![...headerMap(document.querySelector('#fba-wrapper .vxe-table--main-wrapper') || document.createElement('div')).values()].includes('MSKU'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!(await waitCargoIdle())) throw new Error('货件产品视图加载超过 15 秒');
      await chooseCargoShippedStatus();
      if (!(await waitCargoIdle())) throw new Error('SHIPPED 筛选后表格加载超过 15 秒');
      await cargoPageSize500();
      if (!(await waitCargoIdle())) throw new Error('货件分页设置后表格加载超过 15 秒');
      const fullRange = cargoSixMonthRange();
      const windows = cargoScanWindows(fullRange);
      const allRows = new Map();
      const wantedSku = normalizeMsku(identity.msku);
      const wantedStore = clean(identity.store).toUpperCase();
      const matches = (row) => normalizeMsku(row.msku) === wantedSku &&
        (!wantedStore || clean(row.store).toUpperCase() === wantedStore) && /^SHIPPED$/i.test(row.status);
      const pieces = clean(identity.msku).split(/[\u2010-\u2015\s-]+/).filter(Boolean);
      const queries = [...new Set([clean(identity.msku), pieces.length > 2 ? pieces.slice(-3).join('-') : ''].filter(Boolean))];
      for (const [index, range] of windows.entries()) {
        const wantedDate = dateRangeKey(range);
        const radio = document.querySelector('label[role="radio"] input[value="product"]')?.closest('label');
        if (radio && radio.getAttribute('aria-checked') !== 'true' && !radio.querySelector('input')?.checked) radio.click();
        for (let i = 0; i < 50 && ![...headerMap(document.querySelector('#fba-wrapper .vxe-table--main-wrapper') || document.createElement('div')).values()].includes('MSKU'); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!(await waitCargoIdle())) throw new Error(`第 ${index + 1} 段产品视图加载超过 15 秒`);
        if (!cargoShippedSelected()) await chooseCargoShippedStatus();
        await report(`第 ${index + 1}/${windows.length} 段：设置创建时间 ${range.start} 至 ${range.end}…`);
        if (!(await setSourceDateRange(range)) || dateRangeKey(pageDateRange()) !== wantedDate) {
          throw new Error(`第 ${index + 1} 段创建时间未生效：${setSourceDateRange.lastError || dateRangeKey(pageDateRange()) || '未知'}`);
        }
        if (!(await waitCargoIdle())) throw new Error(`第 ${index + 1} 段日期筛选后表格加载超过 15 秒`);
        if (!cargoShippedSelected()) throw new Error(`第 ${index + 1} 段 SHIPPED 筛选丢失`);
        let selected = [];
        for (const [queryIndex, query] of queries.entries()) {
          const controls = await waitForCargoMskuSearch(7000);
          const beforeCount = cargoPageCount();
          const beforeTable = clean(document.querySelector('#fba-wrapper .vxe-table--main-wrapper .vxe-table--body tbody')?.textContent);
          const beforeResponse = cargoNetworkCapture.diagnostic?.businessResponses || 0;
          await report(`第 ${index + 1}/${windows.length} 段：MSKU＋模糊查询「${query}」…`);
          // 上一段切回产品视图时搜索词可能保留；日期响应已更新表格，不再重复提交同一查询。
          let changed = clean(controls.input.value) === query;
          if (!changed) {
            setInputValue(controls.input, query);
            submitSourceSearch(controls.input);
            for (let attempt = 0; attempt < 100; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 120));
              if (sourceIsLoading()) continue;
              const table = clean(document.querySelector('#fba-wrapper .vxe-table--main-wrapper .vxe-table--body tbody')?.textContent);
              if (cargoPageCount() !== beforeCount || table !== beforeTable || (cargoNetworkCapture.diagnostic?.businessResponses || 0) > beforeResponse) {
                changed = true;
                break;
              }
            }
          }
          if (!changed) throw new Error(`第 ${index + 1} 段 MSKU 搜索未返回新结果，未读取旧表格`);
          if (dateRangeKey(pageDateRange()) !== wantedDate || !cargoShippedSelected()) throw new Error(`第 ${index + 1} 段搜索后日期或状态筛选丢失`);
          const total = cargoPageCount();
          if (total < 0 || total > 500) throw new Error(`第 ${index + 1} 段 MSKU 搜索结果 ${total} 票，超出可核对的一页范围`);
          const scanned = total ? await collectCargoProductPage(total, report) : { rows: [] };
          if (scanned.rows.some((row) => !/^SHIPPED$/i.test(row.status))) throw new Error(`第 ${index + 1} 段混入非 SHIPPED 货件`);
          if (scanned.rows.some((row) => !/^\d+$/.test(row.declared) || !/^\d+$/.test(row.received))) throw new Error(`第 ${index + 1} 段申报量或签收量缺失`);
          selected = scanned.rows.filter(matches);
          await report(`第 ${index + 1}/${windows.length} 段：查询返回 ${total} 票，已核对 ${selected.length} 票目标商品`);
          if (selected.length || queryIndex === queries.length - 1) break;
        }
        const wantedShipments = new Set(selected.map((row) => row.shipmentId));
        const orderInfo = new Map();
        if (wantedShipments.size) {
          await report(`第 ${index + 1}/${windows.length} 段：正在读取 ${wantedShipments.size} 票发货单下拉日期…`);
          const orderRadio = document.querySelector('label[role="radio"] input[value="order"]')?.closest('label');
          if (!orderRadio) throw new Error('货件视图切换控件缺失');
          orderRadio.click();
          for (let i = 0; i < 50 && ![...headerMap(document.querySelector('#fba-wrapper .vxe-table--main-wrapper') || document.createElement('div')).values()].includes('发货单'); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (!(await waitCargoIdle())) throw new Error(`第 ${index + 1} 段货件视图加载超过 15 秒`);
          const orderRows = await collectCargoRows(cargoShipmentOrderRows, async (row) =>
            wantedShipments.has(row.shipmentId) ? cargoOrderDates(row.orderCell) : {}, { maxMs: 25_000, maxSteps: 250 });
          for (const row of orderRows) if (wantedShipments.has(row.shipmentId) && /^SHIPPED$/i.test(row.status)) orderInfo.set(row.shipmentId, row);
        }
        for (const row of selected) {
          const key = `${row.shipmentId}|${normalizeMsku(row.msku)}|${clean(row.store).toUpperCase()}`;
          allRows.set(key, { ...row, ...orderInfo.get(row.shipmentId) });
        }
      }
      const rows = [...allRows.values()];
      const result = LXShipmentDetail.fromRows(rows, identity, rows.length);
      result.complete = true;
      result.orderMissing = new Set(rows.filter((row) => !clean(row.orderNumber)).map((row) => row.shipmentId)).size;
      result.scope = `创建时间 ${fullRange.start} 至 ${fullRange.end}（分 ${windows.length} 段）`;
      await send({ type: 'LX_FORMAL_TRANSIT_DETAIL_RESULT', requestId, result });
    } catch (error) {
      await send({ type: 'LX_FORMAL_TRANSIT_DETAIL_RESULT', requestId, error: String(error?.message || error) });
    } finally {
      window.postMessage({ type: 'LX_FORMAL_CARGO_QUERY_STOP', requestId }, location.origin);
      if (cargoNetworkCapture?.requestId === requestId) cargoNetworkCapture = null;
      sourceQueryBusy = false;
    }
  }

  async function runTransitDetailQuery(requestId, identity) {
    if (location.pathname.replace(/\/+$/, '') !== '/erp/msupply/fbaCargo') return;
    if (sourceQueryBusy) throw new Error('FBA 货件页正在执行其他查询');
    sourceQueryBusy = true;
    const report = (stage) => send({ type: 'LX_FORMAL_TRANSIT_DETAIL_PROGRESS', requestId, stage });
    try {
      await report('货件页加载中，准备切换到产品视图…');
      let productRadio = null;
      for (let i = 0; i < 80 && !productRadio; i += 1) {
        productRadio = document.querySelector('label[role="radio"] input[value="product"]')?.closest('label');
        if (!productRadio) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!productRadio) throw new Error('FBA 货件产品视图未就绪');
      if (productRadio.getAttribute('aria-checked') !== 'true' && !productRadio.querySelector('input')?.checked) productRadio.click();
      for (let i = 0; i < 35 && ![...headerMap(document.querySelector('#fba-wrapper .vxe-table--main-wrapper') || document.createElement('div')).values()].some((label) => /^已发货/.test(label)); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (let i = 0; i < 30 && sourceIsLoading(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      await report('正在自动切换搜索条件为 MSKU＋模糊…');
      let controls;
      try {
        controls = await waitForCargoMskuSearch(5000);
      } catch (backgroundError) {
        await report('后台页无法切换筛选，正在临时显示货件页完成 MSKU 选择…');
        const focus = await send({ type: 'LX_FORMAL_TRANSIT_FOCUS_SOURCE', requestId });
        if (!focus?.ok) throw backgroundError;
        controls = await waitForCargoMskuSearch(7000);
      }
      await report(`已切换为 ${controls.mode}＋${controls.matchMode}，正在查询 ${identity.msku}…`);
      // 仅在真正提交目标 MSKU 前开始抓包，避免把新标签页首次加载的未筛选响应当作本次结果。
      cargoNetworkCapture = { requestId, msku: normalizeMsku(identity.msku), rows: new Map(), orders: new Map(), totalCount: 0 };
      window.postMessage({ type: 'LX_FORMAL_CARGO_QUERY_START', requestId, msku: identity.msku }, location.origin);
      const beforeTable = clean(document.querySelector('#fba-wrapper .vxe-table--main-wrapper .vxe-table--body tbody')?.textContent);
      setInputValue(controls.input, identity.msku);
      await new Promise((resolve) => setTimeout(resolve, 70));
      submitSourceSearch(controls.input);
      // 新页的未筛选表格可能恰好包含目标 MSKU，不能把旧行误判为搜索已完成。
      await new Promise((resolve) => setTimeout(resolve, 500));
      let settled = false;
      for (let attempt = 0; attempt < 55; attempt += 1) {
        const packetRows = [...cargoNetworkCapture.rows.values()];
        if (packetRows.length) { settled = true; break; }
        const tableText = clean(document.querySelector('#fba-wrapper .vxe-table--main-wrapper .vxe-table--body tbody')?.textContent);
        const changed = tableText !== beforeTable;
        if (!sourceIsLoading() && changed && (cargoProductRows().some((row) => normalizeMsku(row.msku) === normalizeMsku(identity.msku)) || /共\s*0\s*条/.test(clean(document.querySelector('#fba-wrapper')?.textContent)))) { settled = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!settled) throw new Error('货件页「MSKU＋模糊」搜索后未返回目标产品行，网络响应也未解析到申报/签收量');
      await report('已收到货件搜索结果，正在解析 SHIPPED 货件和单品数量…');
      let packetProducts = [...cargoNetworkCapture.rows.values()].filter((row) => row.status && /^\d+$/.test(row.declared) && /^\d+$/.test(row.received));
      const pageSize = [...document.querySelectorAll('input')].find((input) => /^\d+条\/页$/.test(clean(input.value)) && isRendered(input));
      if (!packetProducts.length && pageSize && Number.parseInt(pageSize.value, 10) < 500) {
        pageSize.click();
        const option = [...document.querySelectorAll('[role="option"],.el-select-dropdown__item')].find((node) => isRendered(node) && clean(node.textContent) === '500条/页');
        option?.click();
        if (option) await new Promise((resolve) => setTimeout(resolve, 650));
      }
      packetProducts = [...cargoNetworkCapture.rows.values()].filter((row) => row.status && /^\d+$/.test(row.declared) && /^\d+$/.test(row.received));
      const products = packetProducts.length ? packetProducts : await collectCargoRows(cargoProductRows);
      const totalCount = cargoNetworkCapture.totalCount || Number(clean(document.querySelector('#fba-wrapper')?.textContent).match(/共\s*(\d+)\s*条/)?.[1] || 0);
      const orders = new Map();
      const wantedShipments = new Set(products.filter((row) => /^SHIPPED$/i.test(row.status) && normalizeMsku(row.msku) === normalizeMsku(identity.msku)).map((row) => row.shipmentId));
      window.postMessage({ type: 'LX_FORMAL_CARGO_SHIPMENTS', requestId, shipmentIds: [...wantedShipments] }, location.origin);
      const completePacketDetails = packetProducts.length && packetProducts.filter((row) => /^SHIPPED$/i.test(row.status))
        .every((row) => row.orderNumber && row.shippedAt && (/-US$|-MX$/i.test(row.store) ? row.arrivalAt : row.shippingMethod));
      if (!completePacketDetails && wantedShipments.size) {
        await report(`已找到 ${wantedShipments.size} 票 SHIPPED 货件，正在补充发货单与到货时间…`);
        const cargoRadio = document.querySelector('label[role="radio"] input[value="order"]')?.closest('label');
        cargoRadio?.click();
        for (let i = 0; i < 35 && ![...headerMap(document.querySelector('#fba-wrapper .vxe-table--main-wrapper') || document.createElement('div')).values()].includes('发货单'); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        for (const item of await collectCargoRows(cargoShipmentOrderRows, async (row) =>
          wantedShipments.has(row.shipmentId) && /^SHIPPED$/i.test(row.status) ? cargoOrderDates(row.orderCell) : {})) {
          if (wantedShipments.has(item.shipmentId) && /^SHIPPED$/i.test(item.status)) {
            orders.set(item.shipmentId, { orderNumber: item.orderNumber, shippedAt: item.shippedAt, arrivalAt: item.arrivalAt, shippingMethod: item.shippingMethod || products.find((row) => row.shipmentId === item.shipmentId)?.shippingMethod || '' });
          }
        }
      }
      const rows = products.map((row) => ({ ...row, ...cargoNetworkCapture.orders.get(row.shipmentId), ...orders.get(row.shipmentId) }));
      for (const row of rows) {
        const packet = cargoNetworkCapture.rows.get(`${clean(row.shipmentId)}|${normalizeMsku(row.msku)}|${clean(row.store).toUpperCase()}`);
        if (!packet) continue;
        for (const field of ['orderNumber', 'shippedAt', 'arrivalAt', 'shippingMethod']) if (!row[field] && packet[field]) row[field] = packet[field];
      }
      const result = LXShipmentDetail.fromRows(rows, identity, totalCount || (packetProducts.length ? 0 : rows.length));
      result.orderMissing = [...wantedShipments].filter((shipmentId) => !orders.has(shipmentId) && !rows.find((row) => row.shipmentId === shipmentId && row.orderNumber)).length;
      const scope = pageDateRange();
      result.scope = scope ? `${scope.start} 至 ${scope.end}` : '';
      await send({ type: 'LX_FORMAL_TRANSIT_DETAIL_RESULT', requestId, result });
    } catch (error) {
      await send({ type: 'LX_FORMAL_TRANSIT_DETAIL_RESULT', requestId, error: String(error?.message || error) });
    } finally {
      window.postMessage({ type: 'LX_FORMAL_CARGO_QUERY_STOP', requestId }, location.origin);
      if (cargoNetworkCapture?.requestId === requestId) cargoNetworkCapture = null;
      sourceQueryBusy = false;
    }
  }

  function syncTransitValues() {
    if (stopped || !isTransitPage()) return;
    const mount = findTableMount();
    const main = mount?.querySelector?.(".vxe-table--main-wrapper");
    const colid = main && fbaAvailableColId(main);
    if (!colid) return;
    const fixed = mount.querySelector(".vxe-table--fixed-left-wrapper");
    for (const item of vxeRenderedRows(main, fixed)) {
      const { mainRow } = item;
      const identity = transitItemIdentity(item);
      const reference = mainRow.querySelector(`td[colid="${CSS.escape(colid)}"] .el-popover__reference[aria-describedby]`);
      const key = transitRowKey(identity);
      const value = transitValueFromPopover(reference)
        ?? transitValueFromNetwork(identity)
        ?? (key && transitValues.has(key) ? transitValues.get(key) : null);
      if (value === null) continue;
      if (key) {
        transitValues.set(key, value);
        if (transitValues.size > 1000) transitValues.delete(transitValues.keys().next().value);
      }
      const cell = mainRow.querySelector("td.lx-fba-transit-column .lx-transit-value");
      if (cell && cell.textContent !== value) { cell.textContent = value; cell.title = value; }
    }
  }

  function scheduleTransitSync() {
    if (!isTransitPage() || transitSyncTimer) return;
    transitSyncTimer = setTimeout(() => {
      transitSyncTimer = null;
      syncTransitValues();
    }, 50);
  }

  function transitColumnNeedsRepair(mount) {
    if (!isTransitPage() || mount?.tagName === "TABLE" || mount?.classList?.contains("ak-table-list")) return false;
    const main = mount?.querySelector(".vxe-table--main-wrapper");
    const colid = main && fbaAvailableColId(main);
    if (!colid) return false;
    const nativeHeader = main.querySelector(`.vxe-table--header thead th[colid="${CSS.escape(colid)}"]`);
    const rows = [...main.querySelectorAll(".vxe-table--body tbody tr")];
    return !nativeHeader?.nextElementSibling?.classList.contains("lx-fba-transit-column")
      || rows.some((row) => {
        const anchor = row.querySelector(`td[colid="${CSS.escape(colid)}"]`);
        return anchor && !anchor.nextElementSibling?.classList.contains("lx-fba-transit-column");
      });
  }

  function injectTransitColumn(mount) {
    if (!isTransitPage() || mount?.tagName === "TABLE" || mount?.classList?.contains("ak-table-list")) return;
    const main = mount?.querySelector(".vxe-table--main-wrapper");
    const colid = main && fbaAvailableColId(main);
    if (!colid) return;
    const width = 135;
    const regularCount = main.querySelectorAll(".vxe-table--header th.lx-formal-column:not(.lx-fba-transit-column)").length;
    for (const table of [main.querySelector(".vxe-table--header"), main.querySelector(".vxe-table--body"), main.querySelector(".vxe-table--footer")].filter(Boolean)) {
      const colgroup = table.querySelector("colgroup");
      const anchor = colgroup?.querySelector(`col[name="${CSS.escape(colid)}"]`);
      if (anchor && anchor.nextElementSibling?.dataset.lxFormalCol !== "fba-transit") {
        const col = document.createElement("col");
        col.dataset.lxFormalCol = "fba-transit";
        col.style.width = `${width}px`;
        anchor.after(col);
      }
      expandWidth(table, regularCount * 175 + width);
    }
    main.querySelectorAll(".vxe-body--x-space").forEach((node) => expandWidth(node, regularCount * 175 + width));
    const header = main.querySelector(`.vxe-table--header thead th[colid="${CSS.escape(colid)}"]`);
    if (header && !header.nextElementSibling?.classList.contains("lx-fba-transit-column")) {
      const th = document.createElement("th");
      th.className = "vxe-header--column col--ellipsis lx-formal-column lx-fba-transit-column";
      th.style.cssText = `width:${width}px;background:#edf5ff;color:#174f91;font-weight:700`;
      th.innerHTML = `<div class="vxe-cell" title="${transitColumnLabel()}">${transitColumnLabel()}</div>`;
      header.after(th);
    }
    for (const footerRow of main.querySelectorAll('.vxe-table--footer tbody tr')) {
      const anchor = footerRow.querySelector(`td[colid="${CSS.escape(colid)}"]`);
      if (!anchor || anchor.nextElementSibling?.classList.contains('lx-fba-transit-column')) continue;
      const td = document.createElement('td');
      td.className = 'vxe-footer--column lx-formal-column lx-fba-transit-column';
      td.style.width = `${width}px`;
      td.title = '各产品在途数量总计请查看下拉明细';
      anchor.after(td);
    }
    const fixed = mount.querySelector(".vxe-table--fixed-left-wrapper");
    for (const item of vxeRenderedRows(main, fixed)) {
      const { mainRow } = item;
      const identity = transitItemIdentity(item);
      const anchor = mainRow.querySelector(`td[colid="${CSS.escape(colid)}"]`);
      if (!anchor) continue;
      const key = transitRowKey(identity);
      const reference = anchor.querySelector(".el-popover__reference[aria-describedby]");
      const fromPopover = transitValueFromPopover(reference);
      const fromNetwork = transitValueFromNetwork(identity);
      const value = fromPopover ?? fromNetwork ?? (key && transitValues.has(key) ? transitValues.get(key) : "待读取");
      if (key && value !== "待读取") transitValues.set(key, value);
      const existing = anchor.nextElementSibling?.classList.contains("lx-fba-transit-column") ? anchor.nextElementSibling : null;
      if (existing) {
        existing.setAttribute('role', 'button'); existing.tabIndex = 0; existing.style.cursor = 'pointer';
        existing.title = '点击查看 SHIPPED 货件明细';
        const cell = existing.querySelector(".lx-transit-value");
        if (cell && cell.textContent !== value) { cell.textContent = value; cell.title = value; }
        continue;
      }
      const td = document.createElement("td");
      td.className = "vxe-body--column col--ellipsis lx-formal-column lx-fba-transit-column";
      td.style.cssText = `width:${width}px;background:#f8fbff`;
      td.setAttribute('role', 'button'); td.tabIndex = 0; td.style.cursor = 'pointer';
      td.title = '点击查看 SHIPPED 货件明细';
      const cell = document.createElement("div");
      cell.className = "vxe-cell";
      cell.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:4px';
      const amount = document.createElement('span');
      amount.className = 'lx-transit-value';
      amount.textContent = value;
      amount.title = value;
      const arrow = document.createElement('span');
      arrow.textContent = '⌄';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.style.color = '#4374b4';
      cell.append(amount, arrow);
      td.append(cell);
      anchor.after(td);
    }
  }

  function repairTransitColumn(mount) {
    if (injecting || stopped) return;
    injecting = true;
    try { injectTransitColumn(mount); }
    finally { injecting = false; }
  }

  function columnsNeedRepair(mount, count) {
    if (mount.classList?.contains("ak-table-list")) {
      const parts = akTableParts();
      if (!parts) return true;
      const headerRow = parts.mainHeader.table.querySelector("thead tr:last-child") || parts.mainHeader.table.querySelector("tr");
      const bodyRows = tableDataRows(parts.mainBody);
      return headerRow?.querySelectorAll("th.lx-formal-column:not(.lx-fba-transit-column)").length !== count
        || bodyRows.some((row) => row.querySelectorAll("td.lx-formal-column:not(.lx-fba-transit-column)").length !== count);
    }
    if (mount.tagName === "TABLE") return mount.querySelectorAll("thead th.lx-formal-column:not(.lx-fba-transit-column)").length !== count
      || [...nativeBodyRows(mount)].some((tr) => tr.querySelectorAll("td.lx-formal-column:not(.lx-fba-transit-column)").length !== count);
    const main = mount.querySelector(".vxe-table--main-wrapper");
    if (!main) return true;
    const fixed = mount.querySelector(".vxe-table--fixed-left-wrapper");
    const beforeId = insertionBeforeColId(main, fixed);
    const headerRow = main.querySelector(".vxe-table--header thead tr:last-child") || main.querySelector(".vxe-table--header thead tr");
    const injectedHeaders = [...(headerRow?.querySelectorAll("th.lx-formal-column:not(.lx-fba-transit-column)") || [])];
    if (injectedHeaders.length !== count) return true;
    const nextHeader = beforeId ? headerRow?.querySelector(`th[colid="${CSS.escape(beforeId)}"]`) : null;
    if (count && nextHeader && injectedHeaders.at(-1)?.nextElementSibling !== nextHeader) return true;
    const bodyRows = [...main.querySelectorAll(".vxe-table--body tbody tr")];
    return bodyRows.some((tr) => {
      const cells = [...tr.querySelectorAll("td.lx-formal-column:not(.lx-fba-transit-column)")];
      if (cells.length !== count) return true;
      const nextCell = beforeId ? tr.querySelector(`td[colid="${CSS.escape(beforeId)}"]`) : null;
      return count && nextCell && cells.at(-1)?.nextElementSibling !== nextCell;
    });
  }

  function injectNativeColumns(table, fields) {
    cleanupColumns(table);
    if (!fields.length) { scheduleSourceBackfill(fields, currentRows); return; }
    const headers = nativeHeaders(table);
    const contextIndex = headers.findIndex((label) => /店铺|国家|站点/.test(label));
    const mskuIndex = headers.findIndex((label) => /MSKU/i.test(label));
    const headerRow = table.tHead?.rows?.[table.tHead.rows.length - 1] || table.rows?.[0];
    const insertionIndex = contextIndex >= 0 ? contextIndex + 1 : 0;
    fields.forEach((field, offset) => {
      const th = document.createElement("th");
      th.className = "lx-formal-column";
      th.style.cssText = "min-width:175px;background:#edf5ff;color:#174f91;font-weight:700";
      th.textContent = `${routeLabel(field.sourceKind)}.${field.label}`;
      headerRow?.insertBefore(th, headerRow.cells[insertionIndex + offset] || null);
    });
    nativeBodyRows(table).forEach((tr) => {
      const cells = [...tr.cells].filter((cell) => !cell.classList.contains("lx-formal-column"));
      const msku = identityLine(cells[mskuIndex]?.innerText || cells[mskuIndex]?.textContent, "msku");
      if (!msku) return;
      const master = currentRows.find((row) => clean(row.identity?.msku) === msku);
      fields.forEach((field, offset) => {
        const sourceRows = field.sourceKind === routeKind() ? currentRows : sourceRowsFor(field.sourceKind);
        const match = master ? findFieldMatchingRow(master.identity, sourceRows, field) : null;
        const value = match?.fields?.[field.label] || (master ? "未命中" : "未识别");
        const td = document.createElement("td");
        td.className = "lx-formal-column";
        td.style.cssText = `min-width:175px;${inventoryDaysCellStyle(field, value)}`;
        td.textContent = value;
        td.title = value;
        tr.insertBefore(td, tr.cells[insertionIndex + offset] || null);
      });
    });
    scheduleSourceBackfill(fields, currentRows);
  }

  function injectAkColumns(mount, fields) {
    cleanupColumns(mount);
    if (!fields.length) { scheduleSourceBackfill(fields, currentRows); return; }
    const parts = akTableParts();
    if (!parts) return;
    const headerRow = parts.mainHeader.table.querySelector("thead tr:last-child") || parts.mainHeader.table.querySelector("tr");
    const bodyRows = tableDataRows(parts.mainBody);
    const width = 175;
    const headerAnchor = headerRow?.querySelector("th");
    const headerColgroup = parts.mainHeader.table.querySelector("colgroup");
    const bodyColgroup = parts.mainBody.querySelector("colgroup");
    fields.forEach((field) => {
      for (const colgroup of new Set([headerColgroup, bodyColgroup].filter(Boolean))) {
        const col = document.createElement("col");
        col.dataset.lxFormalCol = field.id;
        col.style.width = `${width}px`;
        colgroup.insertBefore(col, colgroup.firstElementChild);
      }
      const th = document.createElement("th");
      th.className = "lx-formal-column";
      th.style.cssText = `min-width:${width}px;width:${width}px;background:#edf5ff;color:#174f91;font-weight:700`;
      th.textContent = `${routeLabel(field.sourceKind)}.${field.label}`;
      headerRow?.insertBefore(th, headerAnchor || null);
    });
    bodyRows.forEach((row, index) => {
      const master = currentRows[index];
      const anchor = row.querySelector("td:not(.lx-formal-column)");
      fields.forEach((field) => {
        const sourceRows = field.sourceKind === routeKind() ? currentRows : sourceRowsFor(field.sourceKind);
        const match = master ? findFieldMatchingRow(master.identity, sourceRows, field) : null;
        const value = match?.fields?.[field.label] || (master ? "未命中" : "未识别");
        const td = document.createElement("td");
        td.className = "lx-formal-column";
        td.style.cssText = `min-width:${width}px;width:${width}px;${inventoryDaysCellStyle(field, value)}`;
        td.textContent = value;
        td.title = value;
        row.insertBefore(td, anchor || null);
      });
    });
    scheduleSourceBackfill(fields, currentRows);
  }

  function scheduleColumnVerification() {
    clearTimeout(columnVerifyTimer);
    columnVerifyTimer = setTimeout(() => {
      const mount = findTableMount();
      if (!mount) return;
      if (state.selected.length && columnsNeedRepair(mount, state.selected.length)) injectColumns(true, false);
      else if (transitColumnNeedsRepair(mount)) repairTransitColumn(mount);
    }, 650);
  }

  function injectColumns(force = false, verify = true) {
    if (injecting || stopped) return;
    renderOrderGrossMarginWarnings();
    renderAcoasWarnings();
    const fields = state.selected.map((id) => state.data.fields.find((field) => field.id === id)).filter(Boolean);
    const mount = findTableMount();
    if (!mount) return;
    if (!force && !columnsNeedRepair(mount, fields.length)) {
      if (transitColumnNeedsRepair(mount)) repairTransitColumn(mount);
      return;
    }
    injecting = true;
    try {
      if (mount.classList?.contains("ak-table-list")) { injectAkColumns(mount, fields); return; }
      if (mount.tagName === "TABLE") { injectNativeColumns(mount, fields); return; }
      cleanupColumns(mount);
      if (!fields.length) { scheduleSourceBackfill(fields, currentRows); return; }
      const fixed = mount.querySelector(".vxe-table--fixed-left-wrapper");
      const main = mount.querySelector(".vxe-table--main-wrapper");
      if (!main) return;
      const beforeColId = insertionBeforeColId(main, fixed);
      const width = 175;
      const extra = width * fields.length;
      const tables = [main.querySelector(".vxe-table--header"), main.querySelector(".vxe-table--body"), main.querySelector(".vxe-table--footer")].filter(Boolean);
      for (const table of tables) {
        const colAnchor = (beforeColId && table.querySelector(`col[name="${CSS.escape(beforeColId)}"]`)) || table.querySelector("col[name=col_gutter]");
        const colgroup = table.querySelector("colgroup");
        fields.forEach((field) => {
          const col = document.createElement("col"); col.dataset.lxFormalCol = field.id; col.style.width = `${width}px`;
          colgroup?.insertBefore(col, colAnchor || null);
        });
        expandWidth(table, extra);
      }
      main.querySelectorAll(".vxe-body--x-space").forEach((node) => expandWidth(node, extra));
      const headerRow = main.querySelector(".vxe-table--header thead tr:last-child") || main.querySelector(".vxe-table--header thead tr");
      const headerAnchor = beforeColId ? headerRow?.querySelector(`th[colid="${CSS.escape(beforeColId)}"]`) : null;
      fields.forEach((field) => {
        const th = document.createElement("th"); th.className = "vxe-header--column col--ellipsis lx-formal-column";
        th.style.cssText = `width:${width}px;background:#edf5ff;color:#174f91;font-weight:700`;
        th.innerHTML = `<div class="vxe-cell" title="${esc(routeLabel(field.sourceKind))}.${esc(field.label)}">${esc(routeLabel(field.sourceKind))}.${esc(field.label)}</div>`;
        headerRow?.insertBefore(th, headerAnchor);
      });
      const renderedRows = vxeRenderedRows(main, fixed);
      renderedRows.forEach(({ mainRow: tr, master }) => {
        const anchor = beforeColId ? tr.querySelector(`td[colid="${CSS.escape(beforeColId)}"]`) : null;
        fields.forEach((field) => {
          const sourceRows = field.sourceKind === routeKind() ? currentRows : sourceRowsFor(field.sourceKind);
          const match = master ? findFieldMatchingRow(master.identity, sourceRows, field) : null;
          const value = match?.fields?.[field.label];
          const td = document.createElement("td"); td.className = "vxe-body--column col--ellipsis lx-formal-column";
          td.style.cssText = `width:${width}px;${inventoryDaysCellStyle(field, value)}`;
          td.innerHTML = `<div class="vxe-cell" title="${esc(value || (master ? "未命中" : "未识别"))}">${esc(value || (master ? "未命中" : "未识别"))}</div>`;
          tr.insertBefore(td, anchor);
        });
      });
      scheduleSourceBackfill(fields, currentRows);
    } catch (error) {
      console.warn("[领星跨页面字段库] 字段列渲染失败", error);
      updateBackfill(`字段列渲染失败，正在自动重试：${String(error?.message || error).slice(0, 120)}`, "bad");
    } finally {
      try { injectTransitColumn(mount); }
      catch (error) { console.warn("[领星跨页面字段库] FBA 标发在途列渲染失败", error); }
      injecting = false;
      if (verify && (fields.length || isTransitPage())) scheduleColumnVerification();
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "LX_FORMAL_RUNTIME") {
      sendResponse({ ok: true, version: VERSION, route: routeKind() });
      return;
    }
    if (message?.type === "LX_FORMAL_RUN_SOURCE_QUERY" && message.requestId) {
      sendResponse({ ok: true });
      runSourceQuery(message.requestId, message.matchBy === 'asin' ? message.asins : message.mskus, message.dateRange, message.fieldLabels || [], message.matchBy);
      return;
    }
    if (message?.type === 'LX_FORMAL_RUN_TRANSIT_DETAIL_QUERY' && message.requestId) {
      if (location.pathname.replace(/\/+$/, '') !== '/erp/msupply/fbaCargo') { sendResponse({ ok: false }); return; }
      sendResponse({ ok: true });
      runFocusedTransitDetailQuery(message.requestId, message.identity);
      return;
    }
    if (message?.type === 'LX_FORMAL_RUN_CARGO_SNAPSHOT' && message.requestId) {
      if (location.pathname.replace(/\/+$/, '') !== '/erp/msupply/fbaCargo') { sendResponse({ ok: false }); return; }
      sendResponse({ ok: true });
      runCargoSnapshot(message.requestId);
      return;
    }
    if (message?.type === 'LX_FORMAL_CARGO_SNAPSHOT_ROWS') {
      sendResponse({ ok: true });
      if (!activeTransitDetail) return;
      if (!activeTransitDetail.requestId) { activeTransitDetail.pendingMessage = message; return; }
      if (activeTransitDetail.requestId !== message.requestId) return;
      activeTransitDetail.error = message.error || '';
      activeTransitDetail.result = message.error ? null : cargoSnapshotResult(message.rows, activeTransitDetail.identity, message.complete, message.scope);
      renderTransitDetail();
      return;
    }
    if (message?.type === 'LX_FORMAL_TRANSIT_DETAIL_RESULT') {
      if (!activeTransitDetail) return;
      if (!activeTransitDetail.requestId) { activeTransitDetail.pendingMessage = message; return; }
      if (activeTransitDetail.requestId !== message.requestId) return;
      activeTransitDetail.error = message.error || '';
      activeTransitDetail.result = message.result || null;
      renderTransitDetail();
      return;
    }
    if (message?.type === 'LX_FORMAL_TRANSIT_DETAIL_PROGRESS') {
      sendResponse({ ok: true });
      if (!activeTransitDetail || (activeTransitDetail.requestId && activeTransitDetail.requestId !== message.requestId)) return;
      if (!message.telemetryOnly) {
        activeTransitDetail.stage = clean(message.stage).slice(0, 160);
        activeTransitDetail.lastProgressAt = Date.now();
        activeTransitDetail.stalled = false;
      }
      if (message.diagnosticText) activeTransitDetail.diagnostic = clean(message.diagnosticText).slice(0, 300);
      renderTransitDetail();
      return;
    }
    if (message?.type === "LX_FORMAL_SOURCE_PROGRESS") {
      const progress = message.progress || {};
      if (!acceptBackfillMessage(progress)) return;
      activeBackfill.lastProgressAt = Date.now();
      activeBackfill.lastProgressText = String(progress.currentMsku || '—');
      updateBackfill(`${routeLabel(progress.sourceKind)}正在筛查 ${progress.completed || 0}/${progress.total || 0}；已命中 ${progress.matched || 0}；当前 ${progress.currentMsku || "—"}`, "running");
      return;
    }
    if (message?.type === "LX_FORMAL_SOURCE_RESULT") {
      const result = message.result || {};
      if (!acceptBackfillMessage(result)) return;
      backfillAttempts.set(activeBackfill.signature, Date.now());
      if (result.sourceKind) {
        const reason = result.error || result.note;
        if (reason) backfillFailureReasons.set(result.sourceKind, clean(reason).slice(0, 220));
        else backfillFailureReasons.delete(result.sourceKind);
      }
      if (activeBackfill?.requestId === result.requestId) {
        if (!result.ok && /\b不计入连续未命中\b|不计入连续未命中/.test(String(result.error || ""))) {
          const signature = activeBackfill.signature;
          backfillAttemptCounts.set(signature, Math.max(0, (backfillAttemptCounts.get(signature) || 1) - 1));
        }
        activeBackfill = null;
      }
      updateBackfill(result.ok
        ? `${routeLabel(result.sourceKind)}补查完成：${result.matched || 0}/${result.requested || 0} 命中，仍未命中 ${result.unresolved?.length || 0}${result.note ? `；${result.note}` : ''}`
        : `来源页补查失败：${result.error || "未知错误"}`,
      result.ok && !(result.unresolved?.length) ? "success" : "bad");
      clearTimeout(libraryRefreshTimer);
      libraryRefreshTimer = setTimeout(refreshLibrary, 500);
      return;
    }
    if (message?.type === "LX_FORMAL_LIBRARY_UPDATED") {
      if (message.recapture && message.sourceKind === routeKind()) {
        lastCaptureSignature = "";
        scheduleCapture(0);
      }
      clearTimeout(libraryRefreshTimer);
      libraryRefreshTimer = setTimeout(refreshLibrary, 250);
    }
  });

  setInterval(() => {
    if (stopped || !routeKind()) return;
    checkBackfillTimeout();
    syncRoute();
    if (!host?.isConnected) install();
  }, 2000);
  install();
})();
