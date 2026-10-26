(() => {
  'use strict';
  if (window.__LX_FORMAL_LOADED_TABLE__) return;
  window.__LX_FORMAL_LOADED_TABLE__ = true;
  const learnedPaths = new WeakMap();
  const tableRevisions = new WeakMap();
  const expandedCargoControls = new WeakMap();
  const clean = (value) => String(value ?? '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
  const scalar = (value) => ['string', 'number', 'boolean'].includes(typeof value) ? clean(value) : '';
  const get = (row, path) => {
    if (!path || !row) return undefined;
    if (Object.hasOwn(row, path)) return row[path];
    return String(path).split('.').reduce((value, key) => value?.[key], row);
  };
  const visible = (element) => element?.getBoundingClientRect().width > 0;
  function datePicker() {
    for (const element of document.querySelectorAll('.el-date-editor--daterange')) {
      if (!visible(element)) continue;
      const candidates = [];
      let vue2 = element.__vue__;
      for (let i = 0; vue2 && i < 4; i += 1, vue2 = vue2.$parent) candidates.push(vue2);
      let vue3 = element.__vueParentComponent;
      for (let i = 0; vue3 && i < 4; i += 1, vue3 = vue3.parent) candidates.push(vue3.exposed, vue3.proxy);
      const component = candidates.find((value) => /DatePicker/i.test(value?.$options?.name || '')
        && /daterange/.test(value.type || value.$props?.type || '')
        && typeof value.emitInput === 'function' && typeof value.emitChange === 'function');
      if (component) return component;
    }
    return null;
  }
  function pickerDateKey(component) {
    const values = typeof component.parseValue === 'function' ? component.parseValue(component.value) : component.value;
    if (!Array.isArray(values) || values.length !== 2) return '';
    const days = values.map((value) => {
      if (value === null || value === undefined || value === '') return '';
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    });
    return days.every(Boolean) ? days.join(':') : '';
  }
  async function commitDateRange(range) {
    const component = datePicker();
    if (!component) return { ok: false, supported: false, reason: '日期组件未提供原生提交接口' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(range?.start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(range?.end || '') || range.start > range.end) {
      return { ok: false, supported: true, reason: '目标日期格式无效' };
    }
    if (component.disabled || component.pickerDisabled || component.readonly) return { ok: false, supported: true, reason: '日期组件已禁用或只读' };
    const target = `${range.start}:${range.end}`;
    const changed = pickerDateKey(component) !== target;
    const values = [range.start, range.end].map((value) => {
      const [year, month, day] = value.split('-').map(Number);
      return new Date(year, month - 1, day);
    });
    if (typeof component.isValidValue === 'function' && !component.isValidValue(values)) return { ok: false, supported: true, reason: '日期组件拒绝目标范围' };
    // 使用日期控件自身的格式化和 v-model 提交，再向业务页发送 change。
    // 两端同时提交，避免单独 change 把另一端旧值写回；不依赖日历是否展开。
    component.userInput = null;
    component.emitInput(values);
    if (typeof component.$nextTick === 'function') await new Promise((resolve) => component.$nextTick(resolve));
    const actual = pickerDateKey(component);
    if (actual !== target) return { ok: false, supported: true, dateKey: actual, reason: `日期组件未接受目标范围，实际 ${actual || '未读取到'}` };
    component.emitChange(component.value);
    component.pickerVisible = false;
    if (typeof component.$nextTick === 'function') await new Promise((resolve) => component.$nextTick(resolve));
    const committed = pickerDateKey(component);
    return { ok: committed === target, supported: true, dateKey: committed, changed,
      reason: committed === target ? '' : `业务页修改了日期范围，实际 ${committed || '未读取到'}` };
  }
  async function pickSalesDateRange(range) {
    const component = datePicker();
    if (!component || typeof component.focus !== 'function' || typeof component.$nextTick !== 'function') {
      return { ok: false, supported: false, reason: '日期组件未提供原生日历选中接口' };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(range?.start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(range?.end || '') || range.start > range.end) {
      return { ok: false, supported: true, reason: '目标日期格式无效' };
    }
    if (component.disabled || component.pickerDisabled || component.readonly) return { ok: false, supported: true, reason: '日期组件已禁用或只读' };
    const target = `${range.start}:${range.end}`;
    if (pickerDateKey(component) === target) return { ok: true, supported: true, changed: false, dateKey: target };
    const nextTick = () => new Promise((resolve) => component.$nextTick(resolve));
    // 与日期面板选中完成一致：先 focus 记录 valueOnOpen，再由面板发出 pick。
    // 关闭面板的 watcher 自行触发业务 change，不手工跳过该生命周期 emitChange。
    component.focus();
    await nextTick();
    if (typeof component.picker?.$emit !== 'function') {
      component.pickerVisible = false;
      return { ok: false, supported: false, reason: '原生日历面板尚未挂载' };
    }
    const values = [range.start, range.end].map((value) => {
      const [year, month, day] = value.split('-').map(Number);
      return new Date(year, month - 1, day);
    });
    if (typeof component.isValidValue === 'function' && !component.isValidValue(values)) {
      component.pickerVisible = false;
      return { ok: false, supported: true, reason: '原生日历拒绝目标范围' };
    }
    component.picker.$emit('pick', values, false);
    await nextTick();
    const actual = pickerDateKey(component);
    return { ok: actual === target, supported: true, changed: true, dateKey: actual,
      reason: actual === target ? '' : `原生日历选中事件未提交，实际 ${actual || '未读取到'}` };
  }
  async function selectSalesMsku(mode = 'MSKU') {
    const label = location.pathname === '/erp/listing' ? 'Listing' : location.pathname === '/erp/productExpressionNew' ? '产品表现' : '销量';
    // 只操作当前页面搜索栏自身的 field-select，不修改文字或猜测选项的内部值。
    for (const element of document.querySelectorAll('.ak-search-wrapper .field-select')) {
      if (!visible(element)) continue;
      const candidates = [];
      let component = element.__vue__;
      for (let i = 0; component && i < 4; i += 1, component = component.$parent) candidates.push(component);
      const select = candidates.find((value) => /Select/i.test(value?.$options?.name || '')
        && typeof value.handleOptionSelect === 'function' && Array.isArray(value.options));
      if (!select || select.multiple || select.disabled || select.selectDisabled) continue;
      const input = () => element.querySelector('input');
      if (clean(input()?.value).toUpperCase() === mode) return { ok: true, supported: true, mode };
      const option = select.options.find((item) => clean(item.currentLabel || item.label).toUpperCase() === mode
        && !item.disabled && !item.groupDisabled);
      if (!option) return { ok: false, supported: false, reason: `${label}搜索组件未提供可用 ${mode} 选项` };
      // 与原生选项点击相同的 input/change 路径；不依赖后台菜单动画或是否传送到 body。
      select.handleOptionSelect(option, true);
      if (typeof select.$nextTick === 'function') await new Promise((resolve) => select.$nextTick(resolve));
      const actual = clean(input()?.value).toUpperCase();
      return { ok: actual === mode, supported: true, mode: actual,
        reason: actual === mode ? '' : `${label}搜索组件未接受 ${mode}，实际 ${actual || '未读取到'}` };
    }
    return { ok: false, supported: false, reason: `${label}搜索组件原生选项接口不可用` };
  }
  async function querySalesMsku(query, mode = 'MSKU') {
    const label = location.pathname === '/erp/listing' ? 'Listing' : location.pathname === '/erp/productExpressionNew' ? '产品表现' : '销量';
    query = clean(query);
    if (!query || query.length > 150 || (mode === 'ASIN' && !/^[A-Z0-9]{10}$/.test(query))) return { ok: false, supported: true, reason: `${mode} 查询词无效` };
    const scope = [...document.querySelectorAll('.ak-search-wrapper')].find(visible);
    const input = scope?.querySelector('.search-input input:not([readonly])');
    if (!input || input.disabled || clean(scope.querySelector('.field-select input')?.value).toUpperCase() !== mode) {
      return { ok: false, supported: mode === 'ASIN' || label === '产品表现', reason: `${label} ${mode} 搜索栏尚未就绪` };
    }
    const component = input.closest('.el-input')?.__vue__;
    if (typeof component?.$emit !== 'function' || typeof component?.$nextTick !== 'function') {
      return { ok: false, supported: false, reason: `${label}输入组件原生提交接口不可用` };
    }
    // 先让 ElInput 的原生 input 事件更新搜索组件模型，下一次业务渲染后才发送 Enter。
    component.$emit('input', query);
    await new Promise((resolve) => component.$nextTick(resolve));
    const current = scope.querySelector('.search-input input:not([readonly])');
    if (clean(current?.value) !== query) return { ok: false, supported: true, reason: `${label}搜索词未提交到输入组件` };
    current.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) current.dispatchEvent(new KeyboardEvent(type,
      { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    return { ok: true, supported: true, submitted: query };
  }
  function tableApi() {
    const scope = location.pathname === '/erp/msupply/fbaCargo' ? '#fba-wrapper ' : '';
    for (const element of document.querySelectorAll(`${scope}.vxe-table`)) {
      if (!visible(element)) continue;
      const candidates = [];
      let vue2 = element.__vue__;
      for (let i = 0; vue2 && i < 4; i += 1, vue2 = vue2.$parent) candidates.push(vue2);
      let instance = element.__vueParentComponent;
      for (let i = 0; instance && i < 4; i += 1, instance = instance.parent) candidates.push(instance.exposed, instance.proxy);
      const api = candidates.find((value) => typeof value?.getTableData === 'function' && typeof value?.getTableColumn === 'function');
      if (api) return { element, api };
    }
    return null;
  }
  function pathsFor(row, wanted, prefix = '', depth = 0) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || depth > 4) return [];
    const found = [];
    for (const [key, value] of Object.entries(row)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (wanted && scalar(value) === clean(wanted)) found.push(path);
      else if (value && typeof value === 'object') found.push(...pathsFor(value, wanted, path, depth + 1));
    }
    return found;
  }
  const aliases = {
    asin: ['asin', 'ASIN', 'product_asin', 'productAsin'],
    msku: ['msku', 'seller_sku', 'sellerSku', 'merchant_sku', 'merchantSku', 'product_msku'],
    shipmentId: ['shipment_id', 'shipmentId', 'shipment_no', 'shipmentNo', 'shipment_code', 'shipmentCode', 'fba_shipment_id'],
    store: ['seller_name', 'sellerName', 'store_name', 'storeName', 'shop_name', 'shopName', 'store'],
    status: ['shipment_status', 'shipmentStatus', 'fba_status', 'fbaStatus', 'status'],
    declared: ['declare_num', 'declareNum', 'declare_quantity', 'declared_quantity', 'declareQty', 'declared'],
    received: ['receive_num', 'receiveNum', 'receive_quantity', 'received_quantity', 'receiveQty', 'received'],
    marketplace: ['country_name', 'countryName', 'marketplace', 'country']
  };
  function columnsFor(api, element) {
    const headers = new Map([...element.querySelectorAll('thead th[colid]')].map((node) => [node.getAttribute('colid'), clean(node.innerText || node.textContent)]));
    return (api.getTableColumn().fullColumn || []).map((column) => ({
      column, field: column.field || column.property || '',
      label: headers.get(column.id) || clean(typeof column.getTitle === 'function' ? column.getTitle() : column.title || column.label)
    })).filter((entry) => entry.label && !entry.label.startsWith('销量统计.') && !entry.label.startsWith('Listing.'));
  }
  function valueFor(api, row, entry) {
    if (!entry) return '';
    try {
      const value = typeof api.getCellLabel === 'function' ? api.getCellLabel(row, entry.column) : get(row, entry.field);
      return scalar(value) || scalar(get(row, entry.field));
    } catch { return scalar(get(row, entry.field)); }
  }
  function rowId(api, row) {
    try { return String(api.getRowid?.(row) || ''); } catch { return ''; }
  }
  function learn(api, samples) {
    // 定位“展开剩余”时父行会移出虚拟视口，字段路径必须沿用同一业务表的校准结果。
    const paths = learnedPaths.get(api) || {};
    learnedPaths.set(api, paths);
    const known = new Map();
    for (const sample of samples) {
      const raw = api.getRowById?.(sample.rowid);
      if (!raw) continue;
      known.set(raw, sample);
      for (const [key, value] of Object.entries(sample)) {
        if (key === 'rowid') continue;
        paths[key] ||= [];
        for (const path of pathsFor(raw, value)) if (!(key === 'asin' && /parent.*asin|父/i.test(path)) && !paths[key].includes(path)) paths[key].push(path);
      }
    }
    return {
      value(row, key) {
        const values = [scalar(known.get(row)?.[key]), ...[...(paths[key] || []), ...(aliases[key] || [])].map((path) => scalar(get(row, path)))];
        return values.find((value) => value && (key !== 'asin' || /^[A-Z0-9]{10}$/i.test(value)) && (key !== 'shipmentId' || /^FBA[A-Z0-9]+$/i.test(value)) && (key !== 'store' || !/^\d+$/.test(value))) || '';
      }
    };
  }
  function tableSignature(api, rows, columns) {
    // 既比较值也比较业务行对象的批次；新日期可能返回相同库存值和相同业务主键。
    const previous = tableRevisions.get(api);
    const changed = !previous || previous.rows.length !== rows.length || rows.some((row, index) => row !== previous.rows[index]);
    const revision = (previous?.revision || 0) + (changed ? 1 : 0);
    tableRevisions.set(api, { rows: rows.slice(), revision });
    let hash = 2166136261;
    const text = rows.map((row) => `${rowId(api, row)}:${columns.map(({ field }) => scalar(get(row, field))).join('|')}`).join('\n');
    for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `${revision}:${rows.length}:${hash >>> 0}`;
  }
  function loadedTransitQuantity(row) {
    const values = new Set();
    let visited = 0;
    const walk = (node, depth) => {
      // 仅单品行的明确库存字段；不下钻商品数组，以免把汇总/其他商品冒充本行。
      if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 5 || ++visited > 500) return;
      if (Object.hasOwn(node, 'afn_inbound_shipped_quantity')) {
        const value = node.afn_inbound_shipped_quantity;
        if (['string', 'number'].includes(typeof value) && /^\d+$/.test(String(value))) values.add(String(value));
      }
      for (const child of Object.values(node)) if (child && typeof child === 'object') walk(child, depth + 1);
    };
    walk(row, 0);
    return values.size === 1 ? [...values][0] : null;
  }
  function sourceRows(api, data, columns, samples) {
    const learned = learn(api, samples);
    const mskuColumn = columns.find(({ label }) => /MSKU/i.test(label));
    return data.map((row) => {
      const fields = {};
      for (const entry of columns) {
        const value = valueFor(api, row, entry);
        if (value) fields[entry.label] = value;
      }
      const msku = learned.value(row, 'msku') || valueFor(api, row, mskuColumn);
      const asinColumn = columns.find(({ label }) => /^ASIN(?:$|\s|\/)/i.test(label));
      const asin = [valueFor(api, row, asinColumn), learned.value(row, 'asin')]
        .map((value) => clean(value).toUpperCase()).find((value) => /^[A-Z0-9]{10}$/.test(value)) || '';
      const transitQuantity = location.pathname === '/erp/mreport/salesStat' ? loadedTransitQuantity(row) : null;
      return { identity: { msku, asin, store: learned.value(row, 'store'), marketplace: learned.value(row, 'marketplace') }, fields,
        ...(transitQuantity === null ? {} : { transitQuantity }) };
    }).filter((row) => row.identity.msku && row.identity.msku.length <= 150);
  }
  function cargoRows(api, data, columns, samples, shippedOnly, resolvedRows) {
    let expanded = expandedCargoControls.get(api);
    if (!expanded) { expanded = new WeakSet(); expandedCargoControls.set(api, expanded); }
    for (const sample of samples.filter((sample) => sample.kind === 'expanded')) {
      const raw = api.getRowById?.(sample.rowid);
      if (raw) expanded.add(raw);
    }
    const learned = learn(api, samples);
    const find = (pattern) => columns.find(({ label }) => pattern.test(label));
    const mskuColumn = find(/^MSKU$/i);
    const declaredColumn = find(/^申报量/);
    const receivedColumn = find(/^签收量/);
    if (!mskuColumn || !declaredColumn || !receivedColumn) return { rows: [], shipments: [], collapsed: [], reason: '产品表缺少 MSKU、申报量或签收量列' };
    const rows = new Map();
    const shipments = new Set();
    const collapsed = [];
    let unknownRows = 0;
    let inherited = {};
    const rowClass = api.rowClassName || api.props?.rowClassName;
    for (const [index, row] of data.entries()) {
      let classes = '';
      try { classes = typeof rowClass === 'function' ? clean(rowClass({ row, rowIndex: index, $rowIndex: index, $table: api })) : clean(rowClass); } catch { /* sample calibration remains available */ }
      const id = rowId(api, row);
      const sample = samples.find((item) => item.rowid === id);
      const shipmentId = learned.value(row, 'shipmentId');
      const msku = valueFor(api, row, mskuColumn) || learned.value(row, 'msku');
      const parent = classes.includes('special-row') || sample?.kind === 'parent' || (shipmentId && !msku);
      if (parent) {
        const explicit = learned.value(row, 'status');
        inherited = { shipmentId, store: learned.value(row, 'store'), status: /^(SHIPPED|WORKING|RECEIVING|CLOSED|CANCELLED)$/i.test(explicit) ? explicit : shippedOnly ? 'SHIPPED' : '' };
        if (shipmentId) shipments.add(shipmentId);
        else unknownRows += 1;
        continue;
      }
      if (classes.includes('loading-row') || sample?.kind === 'collapsed') {
        if (!resolvedRows.has(id) && !expanded.has(row)) collapsed.push({ rowid: id, shipmentId: shipmentId || inherited.shipmentId || '' });
        continue;
      }
      const declared = valueFor(api, row, declaredColumn);
      const received = valueFor(api, row, receivedColumn);
      if (!msku || !/^\d+$/.test(declared) || !/^\d+$/.test(received)) { unknownRows += 1; continue; }
      const context = { ...inherited, shipmentId: shipmentId || inherited.shipmentId || '', store: learned.value(row, 'store') || inherited.store || '' };
      if (!context.shipmentId) { unknownRows += 1; continue; }
      shipments.add(context.shipmentId);
      const product = { ...context, msku, declared, received };
      rows.set(`${product.shipmentId}|${product.msku}|${product.store}`, product);
    }
    return { rows: [...rows.values()], shipments: [...shipments], collapsed, unknownRows,
      reason: !data.length ? '空表' : !shipments.size ? '已载入数据尚未识别货件父行' : '' };
  }
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'LX_FORMAL_LOADED_TABLE_REQUEST') return;
    const request = event.data;
    if (!['/erp/listing', '/erp/mreport/salesStat', '/erp/msupply/fbaCargo', '/erp/productExpressionNew'].includes(location.pathname) || typeof request.requestId !== 'string') return;
    const respond = (result) => window.postMessage({ type: 'LX_FORMAL_LOADED_TABLE_RESULT', requestId: request.requestId, ...result }, location.origin);
    try {
      if (request.action === 'setDate') return respond(await commitDateRange(request.range));
      if (request.action === 'selectSourceAsin' && location.pathname !== '/erp/msupply/fbaCargo') return respond(await selectSalesMsku('ASIN'));
      if (request.action === 'querySourceAsin' && location.pathname !== '/erp/msupply/fbaCargo') return respond(await querySalesMsku(request.query, 'ASIN'));
      if (request.action === 'pickSalesDate' && location.pathname === '/erp/mreport/salesStat') return respond(await pickSalesDateRange(request.range));
      if (request.action === 'selectSalesMsku' && location.pathname === '/erp/mreport/salesStat') return respond(await selectSalesMsku());
      if (request.action === 'querySalesMsku' && location.pathname === '/erp/mreport/salesStat') return respond(await querySalesMsku(request.query));
      if (request.action === 'selectProductMsku' && location.pathname === '/erp/productExpressionNew') return respond(await selectSalesMsku());
      if (request.action === 'queryProductMsku' && location.pathname === '/erp/productExpressionNew') return respond(await querySalesMsku(request.query));
      if (location.pathname === '/erp/productExpressionNew' && document.querySelector('#tab-msku')?.getAttribute('aria-selected') !== 'true') return respond({ ok: false, reason: '产品表现尚未切到 MSKU 视图' });
      const table = tableApi();
      if (!table) return respond({ ok: false, reason: '业务表未提供已载入数据接口' });
      const { api, element } = table;
      if (request.action === 'rowWindow' && location.pathname === '/erp/msupply/fbaCargo') {
        const data = api.getTableData().fullData || [];
        const positions = new Map(data.map((row, index) => [rowId(api, row), index]));
        const indices = [...element.querySelectorAll('.vxe-table--main-wrapper tbody tr')]
          .map((node) => positions.get(node.getAttribute('rowid'))).filter(Number.isInteger);
        return respond({ ok: true, targetIndex: positions.get(String(request.rowid || '')) ?? -1,
          firstIndex: indices.length ? Math.min(...indices) : -1, lastIndex: indices.length ? Math.max(...indices) : -1 });
      }
      if (request.action === 'reveal') {
        const row = api.getRowById?.(String(request.rowid || ''));
        if (!row || typeof api.scrollToRow !== 'function') return respond({ ok: false, reason: '目标商品展开行尚未就绪' });
        // 展开大量商品后，旧的行高/虚拟滚动尺寸可能把末尾控件截在滚动范围之外。
        // 仅重算现有表格布局，不重载数据、不修改行，也不把定位调用当作展开证明。
        if (typeof api.recalculate === 'function') await api.recalculate(true);
        await api.scrollToRow(row);
        return respond({ ok: true });
      }
      const data = api.getTableData().fullData || [];
      if (data.length > 50000) return respond({ ok: false, reason: '单页已载入数据超过安全上限' });
      const columns = columnsFor(api, element);
      const base = { signature: tableSignature(api, data, columns), loadedCount: data.length, loading: Boolean(api.loading || api.props?.loading) };
      if (request.action === 'state') return respond({ ok: true, ...base });
      const samples = Array.isArray(request.samples) ? request.samples.slice(0, 500) : [];
      const result = location.pathname === '/erp/msupply/fbaCargo'
        ? cargoRows(api, data, columns, samples, request.shippedOnly === true, new Set(request.resolvedRows || []))
        : { rows: sourceRows(api, data, columns, samples) };
      respond({ ok: true, ...result, ...base, labels: columns.map(({ label }) => label).slice(0, 100) });
    } catch (error) { respond({ ok: false, supported: ['setDate', 'pickSalesDate', 'selectSalesMsku', 'querySalesMsku', 'selectProductMsku', 'queryProductMsku', 'selectSourceAsin', 'querySourceAsin'].includes(request.action), reason: `${['setDate', 'pickSalesDate'].includes(request.action) ? '日期组件提交失败' : /Asin$/.test(request.action) ? 'ASIN 搜索组件提交失败' : ['selectSalesMsku', 'querySalesMsku', 'selectProductMsku', 'queryProductMsku'].includes(request.action) ? 'MSKU 搜索组件提交失败' : '读取已载入业务表失败'}：${String(error?.message || error).slice(0, 120)}` }); }
  });
})();
