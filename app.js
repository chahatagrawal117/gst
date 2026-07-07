const HOME_STATE = 'RJ';
const HSN = 4909;
const TAX_RATE = 0.18;

const OFFLINE_COLUMNS = ['Date', 'Party', 'Amount', 'GST', 'Total', 'GSTIN'];
const OUTPUT_HEADING = [
  'Invoice Date', 'Invoice Number', 'Customer Billing Name', 'Customer Billing GSTIN',
  'Supply State', 'HSN', 'Item Taxable Value', 'CGST', 'SGST', 'IGST', 'Total Transaction Value'
];
const OFFLINE_OUTPUT_HEADING = ['Date', 'Invoice No.', 'Party', 'Amount', 'GST', 'IGST', 'Total', 'GSTIN'];

const LS_KEY = 'gst-offline-rows-v1';
const LS_LAST_INVOICE = 'gst-last-invoice-v1';
const LS_MIN_TOTAL = 'gst-min-total-v1';
const LS_HISTORY_CACHE = 'gst-history-cache-v1';
const LS_TOMBSTONES = 'gst-deleted-filings-v1';
const HISTORY_VERSION = 1;
const DEFAULT_MIN_TOTAL = 10;

const round2 = n => Math.round(n * 100) / 100;

function parseShopifyDate(s) {
  const dateOnly = String(s).split(' ')[0];
  const [y, m, d] = dateOnly.split('-').map(Number);
  return { year: y, month: m, day: d };
}

function parseOfflineDate(s) {
  const normalized = String(s).replace(/\./g, '-');
  const parts = normalized.split('-');
  let [d, m, y] = parts;
  if (y && y.length === 2) y = '20' + y;
  return { year: Number(y), month: Number(m), day: Number(d) };
}

function formatDate({ year, month, day }) {
  return `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatFriendlyDate({ year, month, day }) {
  return `${day}${MONTH_ABBR[month - 1]}${String(year).slice(-2)}`;
}

// Indian fiscal quarter (Apr-Mar): Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar.
function fiscalQuarterStartMonth(month) {
  if (month >= 4 && month <= 6) return 4;
  if (month >= 7 && month <= 9) return 7;
  if (month >= 10 && month <= 12) return 10;
  return 1;
}
function fiscalQuarterEndMonth(month) {
  if (month >= 4 && month <= 6) return 6;
  if (month >= 7 && month <= 9) return 9;
  if (month >= 10 && month <= 12) return 12;
  return 3;
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function dateSortKey({ year, month, day }) {
  return year * 10000 + month * 100 + day;
}

function pyFloatStr(n) {
  const s = String(n);
  return s.indexOf('.') === -1 ? s + '.0' : s;
}

function computeTax(total, state) {
  const taxable = round2(total / (1 + TAX_RATE));
  const totalTaxRaw = total - taxable;
  if (state === HOME_STATE) {
    const half = round2(totalTaxRaw / 2);
    return {
      taxable: pyFloatStr(taxable),
      cgst: pyFloatStr(half),
      sgst: pyFloatStr(half),
      igst: '0'
    };
  }
  return {
    taxable: pyFloatStr(taxable),
    cgst: '0',
    sgst: '0',
    igst: pyFloatStr(round2(totalTaxRaw))
  };
}

function processShopifyRows(rows, minTotal) {
  // Group by order Name — Shopify writes one CSV row per line item.
  // Only the primary row (the one with Total filled) has order-level metadata.
  const byName = new Map();
  const nameOrder = [];
  for (const row of rows) {
    const name = String(row['Name'] || '').replace('#', '').trim();
    if (!name) continue;
    if (!byName.has(name)) {
      byName.set(name, []);
      nameOrder.push(name);
    }
    byName.get(name).push(row);
  }

  const orders = [];
  const skipped = [];
  for (const name of nameOrder) {
    const group = byName.get(name);
    const primary = group.find(r => String(r['Total'] || '').trim()) || group[0];
    const raw = {
      invoiceNo: name,
      paidAt: String(primary['Paid at'] || '').trim(),
      totalStr: String(primary['Total'] || '').trim(),
      name: String(primary['Billing Name'] || '').trim(),
      state: String(primary['Billing Province'] || '').trim()
    };
    const result = tryBuildOnlineOrder(raw, minTotal);
    if (result.ok) {
      orders.push(result.order);
    } else {
      skipped.push({
        raw,
        reason: result.reason,
        missing: result.missing || [],
        badFields: result.badFields || []
      });
    }
  }
  return { orders, skipped };
}

function tryBuildOnlineOrder(raw, minTotal) {
  // Check Total first — for ₹1 payment tokens, the meaningful reason is
  // "Total < threshold", not "missing state" (state is often empty for those).
  if (raw.totalStr) {
    const total = parseFloat(raw.totalStr);
    if (isNaN(total)) {
      return { ok: false, reason: `Total is not a number (${raw.totalStr})`, badFields: ['totalStr'] };
    }
    if (total < minTotal) {
      return { ok: false, reason: `Total < ₹${minTotal} (₹${raw.totalStr})`, badFields: ['totalStr'] };
    }
  }

  const missing = [];
  if (!raw.invoiceNo) missing.push('Name');
  if (!raw.paidAt) missing.push('Paid at');
  if (!raw.totalStr) missing.push('Total');
  if (!raw.name) missing.push('Billing Name');
  if (!raw.state) missing.push('Billing Province');
  if (missing.length) return { ok: false, reason: `missing: ${missing.join(', ')}`, missing };

  const total = parseFloat(raw.totalStr);
  const parsed = parseShopifyDate(raw.paidAt);
  if (!parsed.year || !parsed.month || !parsed.day) {
    return { ok: false, reason: `Invalid date (${raw.paidAt})`, badFields: ['paidAt'] };
  }

  const tax = computeTax(total, raw.state);
  return {
    ok: true,
    order: {
      _source: 'online',
      _tempKey: `on-${raw.invoiceNo}`,
      _dateObj: parsed,
      'Invoice Date': formatDate(parsed),
      'Invoice Number': raw.invoiceNo,
      'Customer Billing Name': raw.name,
      'Customer Billing GSTIN': '-',
      'Supply State': raw.state,
      'HSN': HSN,
      'Item Taxable Value': tax.taxable,
      'CGST': tax.cgst,
      'SGST': tax.sgst,
      'IGST': tax.igst,
      'Total Transaction Value': raw.totalStr
    }
  };
}

function processOfflineRows(rows) {
  const orders = [];
  const originalRows = [];
  let skipped = 0;
  let tempNo = 0;

  for (const row of rows) {
    const dateStr = String(row['Date'] || '').trim();
    if (!dateStr) continue;
    const totalStr = String(row['Total'] || '').trim();
    if (!totalStr) { skipped++; continue; }
    const total = parseFloat(totalStr);
    if (isNaN(total)) { skipped++; continue; }

    tempNo++;
    const parsed = parseOfflineDate(dateStr);
    const tax = computeTax(total, 'OTHER');

    orders.push({
      _source: 'offline',
      _tempKey: `off-${tempNo}`,
      _dateObj: parsed,
      _tempNo: tempNo,
      'Invoice Date': formatDate(parsed),
      'Invoice Number': `OFF-${tempNo}`,
      'Customer Billing Name': String(row['Party'] || '').trim(),
      'Customer Billing GSTIN': String(row['GSTIN'] || '').trim(),
      'Supply State': '-',
      'HSN': HSN,
      'Item Taxable Value': tax.taxable,
      'CGST': tax.cgst,
      'SGST': tax.sgst,
      'IGST': tax.igst,
      'Total Transaction Value': totalStr
    });
    originalRows.push({
      _tempNo: tempNo,
      Date: dateStr,
      'Invoice No.': String(row['Invoice No.'] || '').trim(),
      Party: String(row['Party'] || '').trim(),
      Amount: String(row['Amount'] || '').trim(),
      GST: String(row['GST'] || '').trim(),
      IGST: String(row['IGST'] || '').trim(),
      Total: totalStr,
      GSTIN: String(row['GSTIN'] || '').trim()
    });
  }
  return { orders, originalRows, skipped };
}

function combineAndRenumber(shopifyOrders, offlineOrders, startingInvoiceNo) {
  const combined = [...shopifyOrders, ...offlineOrders];
  combined.sort((a, b) => dateSortKey(a._dateObj) - dateSortKey(b._dateObj));

  const invoiceMap = {};
  combined.forEach((order, idx) => {
    const newNo = String(startingInvoiceNo + idx);
    invoiceMap[order._tempKey] = newNo;
    order['Invoice Number'] = newNo;
  });
  return { combined, invoiceMap };
}

function toCsv(rows, heading) {
  return Papa.unparse({ fields: heading, data: rows.map(r => heading.map(h => r[h] ?? '')) }) + '\r\n';
}

function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------- Offline table UI ----------------

function emptyOfflineRow() {
  return { Date: '', Party: '', Amount: '', GST: '', Total: '', GSTIN: '' };
}

function renderOfflineTable(rows) {
  const tbody = document.getElementById('offlineTableBody');
  tbody.innerHTML = '';
  rows.forEach((row, idx) => {
    const tr = document.createElement('tr');
    OFFLINE_COLUMNS.forEach(col => {
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'text';
      input.value = row[col] ?? '';
      input.placeholder = col;
      input.dataset.col = col;
      input.dataset.idx = String(idx);
      input.addEventListener('input', onOfflineCellChange);
      td.appendChild(input);
      tr.appendChild(td);
    });
    const tdDel = document.createElement('td');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'delete-row';
    btn.textContent = '×';
    btn.title = 'Delete row';
    btn.addEventListener('click', () => {
      offlineRows.splice(idx, 1);
      persistOfflineRows();
      renderOfflineTable(offlineRows);
    });
    tdDel.appendChild(btn);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
}

function onOfflineCellChange(e) {
  const idx = Number(e.target.dataset.idx);
  const col = e.target.dataset.col;
  offlineRows[idx][col] = e.target.value;
  persistOfflineRows();
}

function persistOfflineRows() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(offlineRows)); } catch (_) {}
}

function loadOfflineRows() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

function saveLastInvoice(n) {
  try { localStorage.setItem(LS_LAST_INVOICE, String(n)); } catch (_) {}
}

function loadLastInvoice() {
  try {
    const raw = localStorage.getItem(LS_LAST_INVOICE);
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  } catch (_) { return null; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getMinTotal() {
  const el = document.getElementById('minTotal');
  const n = parseFloat(el && el.value);
  return isNaN(n) || n < 0 ? DEFAULT_MIN_TOTAL : n;
}

function setLastInvoiceHint(text) {
  let hint = document.getElementById('lastInvoiceHint');
  if (!hint) {
    hint = document.createElement('p');
    hint.className = 'hint';
    hint.id = 'lastInvoiceHint';
    document.getElementById('startingInvoice').parentElement.appendChild(hint);
  }
  hint.textContent = text;
}

function persistLastInvoiceAfterDownload() {
  if (!lastResult || lastResult.counterSaved) return;
  saveLastInvoice(lastResult.lastNo);
  lastResult.counterSaved = true;
  setLastInvoiceHint(
    `Last invoice used: ${lastResult.lastNo}. Next run will prefill ${lastResult.lastNo + 1}.`
  );
}

function currentFilenameBase() {
  const input = document.getElementById('filenameBase');
  const val = input && input.value.trim();
  const base = val || (lastResult && lastResult.filenameBase) || `gst_sheet_${todayStamp()}`;
  return base.replace(/[\\/:*?"<>|]/g, '_');
}

function updateFilenamePreview() {
  const base = currentFilenameBase();
  const preview = document.getElementById('filenamePreview');
  if (preview) {
    preview.innerHTML = `Saves as <code>${escapeHtml(base)}.csv</code> and <code>${escapeHtml(base)}_offline.csv</code>`;
  }
  if (lastResult) {
    lastResult.filenameBase = base;
    if (!document.getElementById('resultsModal').hidden) {
      const combinedMeta = document.getElementById('resultsCombinedMeta');
      const offlineMeta = document.getElementById('resultsOfflineMeta');
      if (combinedMeta) combinedMeta.innerHTML =
        `${lastResult.rangeLabel} · ${lastResult.combined.length} rows · ` +
        `saves as <code>${escapeHtml(base)}.csv</code>`;
      if (offlineMeta && (lastResult.offlineOutputRows || []).length) {
        offlineMeta.innerHTML =
          `${lastResult.offlineOutputRows.length} offline invoices · saves as ` +
          `<code>${escapeHtml(base)}_offline.csv</code>`;
      }
    }
  }
}

function wireFilenameInput() {
  const input = document.getElementById('filenameBase');
  if (!input) return;
  input.addEventListener('input', updateFilenamePreview);
  updateFilenamePreview();
}

function saveMinTotal(n) {
  try { localStorage.setItem(LS_MIN_TOTAL, String(n)); } catch (_) {}
}

function loadMinTotal() {
  try {
    const raw = localStorage.getItem(LS_MIN_TOTAL);
    if (raw == null) return null;
    const n = parseFloat(raw);
    return isNaN(n) ? null : n;
  } catch (_) { return null; }
}

// ---------------- History persistence (local only) ----------------

function emptyHistory() {
  return { version: HISTORY_VERSION, filings: [] };
}
function normaliseHistory(h) {
  if (!h || typeof h !== 'object') return emptyHistory();
  const filings = Array.isArray(h.filings) ? h.filings : [];
  return { version: h.version || HISTORY_VERSION, filings };
}
function loadCachedHistory() {
  try {
    const raw = localStorage.getItem(LS_HISTORY_CACHE);
    return raw ? normaliseHistory(JSON.parse(raw)) : null;
  } catch (_) { return null; }
}
function cacheHistory(history) {
  try { localStorage.setItem(LS_HISTORY_CACHE, JSON.stringify(history)); } catch (_) {}
}

function loadTombstones() {
  try {
    const raw = localStorage.getItem(LS_TOMBSTONES);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (_) { return new Set(); }
}
function saveTombstones(s) {
  try { localStorage.setItem(LS_TOMBSTONES, JSON.stringify([...s])); } catch (_) {}
}

function detectRepoInfo() {
  const host = location.hostname;
  const parts = location.pathname.split('/').filter(Boolean);
  if (host.endsWith('.github.io')) {
    const owner = host.replace('.github.io', '');
    if (parts.length > 0) return { owner, repo: parts[0] };
    return { owner, repo: `${owner}.github.io` };
  }
  return null;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) { return false; }
  }
}

async function fetchRemoteHistory() {
  try {
    const resp = await fetch('history.json', { cache: 'no-store' });
    if (!resp.ok) return null;
    const parsed = await resp.json();
    return normaliseHistory(parsed);
  } catch (_) { return null; }
}

function mergeHistories(a, b) {
  // Union by filing id. When ids collide, prefer the one with newer generatedAt.
  // Locally-deleted ids (tombstones) are never re-added, even if remote still has them.
  const byId = new Map();
  const add = f => {
    if (!f || !f.id || tombstones.has(f.id)) return;
    const existing = byId.get(f.id);
    if (!existing) byId.set(f.id, f);
    else {
      const aT = Date.parse(f.generatedAt || '') || 0;
      const bT = Date.parse(existing.generatedAt || '') || 0;
      if (aT >= bT) byId.set(f.id, f);
    }
  };
  (a.filings || []).forEach(add);
  (b.filings || []).forEach(add);
  const filings = sortFilingsByMonth([...byId.values()]);
  return { version: HISTORY_VERSION, filings };
}

function parseFriendlyDateStr(s) {
  const m = String(s || '').match(/^(\d{1,2})([A-Za-z]+)(\d{2,4})$/);
  if (!m) return null;
  const monthIdx = MONTH_ABBR.indexOf(m[2]);
  if (monthIdx < 0) return null;
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  return { year, month: monthIdx + 1, day: parseInt(m[1], 10) };
}

function filingYearMonthKey(f) {
  if (f && f.filingStartYearMonth) return f.filingStartYearMonth;
  const p = f && parseFriendlyDateStr(f.filingStart);
  return p ? `${p.year}-${String(p.month).padStart(2, '0')}` : '';
}

function sortFilingsByMonth(filings) {
  filings.sort((a, b) => filingYearMonthKey(b).localeCompare(filingYearMonthKey(a)));
  return filings;
}

function maxInvoiceFromHistory() {
  const filings = history.filings || [];
  let max = 0;
  for (const f of filings) {
    if (typeof f.invoiceRangeEnd === 'number' && f.invoiceRangeEnd > max) {
      max = f.invoiceRangeEnd;
    }
  }
  return max;
}

// ---------------- State ----------------

let offlineRows = loadOfflineRows();
let shopifyProcessed = null;
let lastResult = null;
let history = loadCachedHistory() || emptyHistory();
let tombstones = loadTombstones();
let remoteSnapshot = null; // set to the last-fetched history.json content (source of truth)

// ---------------- History rendering + management ----------------

function currentFilingSummary() {
  if (!lastResult) return null;
  const totalTax = Object.values(lastResult.monthlyTax || {}).reduce((a, b) => round2(a + b), 0);
  return {
    id: currentFilenameBase(),
    period: lastResult.rangeLabel.replace(/<[^>]+>/g, '').trim(),
    filingStart: formatFriendlyDate(lastResult.filingStart),
    filingEnd: formatFriendlyDate(lastResult.filingEnd),
    filingStartYearMonth: `${lastResult.filingStart.year}-${String(lastResult.filingStart.month).padStart(2, '0')}`,
    generatedAt: new Date().toISOString(),
    onlineOrders: lastResult.onlineCount,
    offlineOrders: lastResult.offlineCount,
    totalInvoices: lastResult.combined.length,
    invoiceRangeStart: lastResult.startingInvoiceNo,
    invoiceRangeEnd: lastResult.lastNo,
    totalTax,
    monthlyTax: lastResult.monthlyTax
  };
}

function upsertFiling(filing) {
  // If the user is re-adding a previously deleted filing, clear the tombstone.
  if (tombstones.has(filing.id)) {
    tombstones.delete(filing.id);
    saveTombstones(tombstones);
  }
  const idx = history.filings.findIndex(f => f.id === filing.id);
  if (idx >= 0) history.filings[idx] = filing;
  else history.filings.push(filing);
  sortFilingsByMonth(history.filings);
  cacheHistory(history);
  renderHistoryCard();
}

function removeFilingById(id) {
  history.filings = history.filings.filter(f => f.id !== id);
  tombstones.add(id);
  saveTombstones(tombstones);
  cacheHistory(history);
  renderHistoryCard();
}

function monthLabelFromKey(key) {
  const [year, month] = key.split('-').map(Number);
  return `${MONTH_ABBR[month - 1]} ${String(year).slice(-2)}`;
}

function updateHistoryNavCount() {
  const el = document.getElementById('historyNavCount');
  if (!el) return;
  const n = (history.filings || []).length;
  if (n > 0) { el.hidden = false; el.textContent = String(n); }
  else { el.hidden = true; }
}

function setupNav() {
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      switchView(link.dataset.view);
      window.history.replaceState(null, '', '#' + link.dataset.view);
    });
  });
  updateHistoryNavCount();
  const initial = (location.hash || '').replace('#', '');
  switchView(['new-filing', 'history'].includes(initial) ? initial : 'new-filing');
}

function switchView(name) {
  document.querySelectorAll('main > .view').forEach(v => {
    v.hidden = v.dataset.view !== name;
  });
  document.querySelectorAll('.nav-link').forEach(l => {
    l.classList.toggle('active', l.dataset.view === name);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function computeSyncDelta() {
  // Returns { pendingAdds, pendingDeletes, remoteFilings } comparing local to the last remote fetch.
  if (!remoteSnapshot) return { pendingAdds: 0, pendingDeletes: 0, remoteFilings: 0, remoteMissing: true };
  const remoteIds = new Set((remoteSnapshot.filings || []).map(f => f.id));
  const localIds = new Set((history.filings || []).map(f => f.id));
  let pendingAdds = 0;
  for (const id of localIds) if (!remoteIds.has(id)) pendingAdds++;
  let pendingDeletes = 0;
  for (const id of remoteIds) if (!localIds.has(id) && tombstones.has(id)) pendingDeletes++;
  return { pendingAdds, pendingDeletes, remoteFilings: remoteIds.size, remoteMissing: false };
}

function renderSyncStatus() {
  const el = document.getElementById('historyRemoteStatus');
  if (!el) return;
  const totalLocal = (history.filings || []).length;
  const { pendingAdds, pendingDeletes, remoteFilings, remoteMissing } = computeSyncDelta();
  const isDirty = pendingAdds > 0 || pendingDeletes > 0;

  const parts = [];
  parts.push(`Database: <code>history.json</code>`);
  if (remoteMissing) {
    parts.push(`<span class="sync-note">(not found in repo yet — will be created on first upload)</span>`);
  } else {
    parts.push(`— <b>${remoteFilings}</b> filing${remoteFilings === 1 ? '' : 's'} loaded from repo`);
  }
  if (isDirty) {
    const bits = [];
    if (pendingAdds) bits.push(`${pendingAdds} new`);
    if (pendingDeletes) bits.push(`${pendingDeletes} deleted`);
    parts.push(`<span class="sync-dirty">· ${bits.join(', ')} — not yet uploaded to GitHub</span>`);
  } else if (!remoteMissing && totalLocal > 0) {
    parts.push(`<span class="sync-clean">· in sync with repo</span>`);
  }
  el.innerHTML = parts.join(' ');
}

function renderHistoryCard() {
  const card = document.getElementById('historyCard');
  history.filings = sortFilingsByMonth(history.filings || []);
  const filings = history.filings;
  card.hidden = false;
  updateHistoryNavCount();
  renderSyncStatus();
  const syncActions = document.getElementById('historySyncActions');
  if (syncActions) syncActions.hidden = filings.length === 0 && !computeSyncDelta().pendingDeletes;

  const empty = document.getElementById('historyEmpty');
  const totals = document.getElementById('historyTotals');
  const tableWrap = document.getElementById('historyTableWrap');
  const monthlyWrap = document.getElementById('historyMonthlyWrap');

  if (filings.length === 0) {
    empty.hidden = false;
    totals.hidden = true;
    tableWrap.hidden = true;
    monthlyWrap.hidden = true;
    return;
  }
  empty.hidden = true;

  const totalTax = filings.reduce((s, f) => round2(s + (f.totalTax || 0)), 0);
  const totalInvoices = filings.reduce((s, f) => s + (f.totalInvoices || 0), 0);

  totals.hidden = false;
  totals.innerHTML = `
    <div><span class="label">Filings recorded</span><span class="value">${filings.length}</span></div>
    <div><span class="label">Total invoices</span><span class="value">${totalInvoices}</span></div>
    <div><span class="label">Total tax filed</span><span class="value">₹${totalTax.toFixed(2)}</span></div>
  `;

  tableWrap.hidden = false;
  const tbody = document.getElementById('historyTableBody');
  tbody.innerHTML = filings.map(f => `
    <tr>
      <td>${escapeHtml(f.period)}</td>
      <td>${escapeHtml(new Date(f.generatedAt).toLocaleString())}</td>
      <td>${f.totalInvoices || 0}</td>
      <td>${f.invoiceRangeStart}–${f.invoiceRangeEnd}</td>
      <td>₹${(f.totalTax || 0).toFixed(2)}</td>
      <td><button type="button" class="delete-row" data-id="${escapeHtml(f.id)}" title="Delete">×</button></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('button.delete-row').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm(`Remove this filing from history?`)) return;
      removeFilingById(btn.dataset.id);
    });
  });

  const monthTotals = {};
  for (const f of filings) {
    const m = f.monthlyTax || {};
    for (const k of Object.keys(m)) {
      monthTotals[k] = round2((monthTotals[k] || 0) + m[k]);
    }
  }
  const sortedMonths = Object.keys(monthTotals).sort().reverse();
  if (sortedMonths.length) {
    monthlyWrap.hidden = false;
    document.getElementById('historyMonthlyBody').innerHTML = sortedMonths.map(k => `
      <tr><td>${monthLabelFromKey(k)}</td><td>₹${monthTotals[k].toFixed(2)}</td></tr>
    `).join('');
  } else {
    monthlyWrap.hidden = true;
  }
}


// ---------------- Wiring ----------------

document.addEventListener('DOMContentLoaded', () => {
  if (offlineRows.length === 0) offlineRows = [emptyOfflineRow()];
  renderOfflineTable(offlineRows);

  const startingInput = document.getElementById('startingInvoice');
  refreshStartingInvoicePrefill();

  const minTotalInput = document.getElementById('minTotal');
  const savedMinTotal = loadMinTotal();
  if (savedMinTotal != null) minTotalInput.value = savedMinTotal;
  minTotalInput.addEventListener('input', () => {
    saveMinTotal(getMinTotal());
    reprocessShopifyIfLoaded();
  });

  renderHistoryCard();

  document.getElementById('shopifyFile').addEventListener('change', onShopifyFileChosen);
  document.getElementById('offlineFile').addEventListener('change', onOfflineFileChosen);
  document.getElementById('viewShopifyBtn').addEventListener('click', () => {
    if (!shopifyProcessed) return;
    openImportModal();
  });
  document.getElementById('modalCloseBtn').addEventListener('click', () => closeAnyModal('modal'));
  document.querySelector('#modal .modal-backdrop').addEventListener('click', () => closeAnyModal('modal'));
  document.getElementById('resultsModalCloseBtn').addEventListener('click', () => closeAnyModal('resultsModal'));
  document.querySelector('#resultsModal .modal-backdrop').addEventListener('click', () => closeAnyModal('resultsModal'));
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!document.getElementById('resultsModal').hidden) closeAnyModal('resultsModal');
    else if (!document.getElementById('modal').hidden) closeAnyModal('modal');
  });
  setupModalTabs(document.getElementById('modal'));
  setupModalTabs(document.getElementById('resultsModal'));
  document.getElementById('viewResultsBtn').addEventListener('click', openResultsModal);
  document.getElementById('modalDownloadCombinedBtn').addEventListener('click', () => {
    if (!lastResult) return;
    downloadCsv(lastResult.combinedCsv, `${currentFilenameBase()}.csv`);
    persistLastInvoiceAfterDownload();
  });
  document.getElementById('modalDownloadOfflineBtn').addEventListener('click', () => {
    if (!lastResult) return;
    downloadCsv(lastResult.offlineCsv, `${currentFilenameBase()}_offline.csv`);
    persistLastInvoiceAfterDownload();
  });
  document.getElementById('resultsSearch').addEventListener('input', applyResultsSearch);
  document.getElementById('importSearch').addEventListener('input', applyImportSearch);
  document.getElementById('parsePasteBtn').addEventListener('click', onParsePaste);
  document.getElementById('clearPasteBtn').addEventListener('click', () => {
    document.getElementById('pasteArea').value = '';
  });
  document.getElementById('addRowBtn').addEventListener('click', () => {
    offlineRows.push(emptyOfflineRow());
    persistOfflineRows();
    renderOfflineTable(offlineRows);
  });
  document.getElementById('clearRowsBtn').addEventListener('click', () => {
    if (!confirm('Clear all offline rows?')) return;
    offlineRows = [emptyOfflineRow()];
    persistOfflineRows();
    renderOfflineTable(offlineRows);
  });
  document.getElementById('generateBtn').addEventListener('click', onGenerate);
  document.getElementById('downloadCombinedBtn').addEventListener('click', () => {
    if (!lastResult) return;
    downloadCsv(lastResult.combinedCsv, `${currentFilenameBase()}.csv`);
    persistLastInvoiceAfterDownload();
  });
  document.getElementById('downloadOfflineBtn').addEventListener('click', () => {
    if (!lastResult) return;
    downloadCsv(lastResult.offlineCsv, `${currentFilenameBase()}_offline.csv`);
    persistLastInvoiceAfterDownload();
  });

  document.getElementById('saveToHistoryBtn').addEventListener('click', () => {
    const summary = currentFilingSummary();
    if (!summary) return;
    upsertFiling(summary);
    const status = document.getElementById('saveHistoryStatus');
    const btn = document.getElementById('saveToHistoryBtn');
    status.className = 'status ok';
    status.innerHTML = `Saved. History now has <b>${history.filings.length}</b> filings. ` +
      `<a href="#history" id="jumpHistory">Go to History →</a>`;
    btn.textContent = '✓ Saved to history';
    btn.disabled = true;
    document.getElementById('jumpHistory').addEventListener('click', e => {
      e.preventDefault();
      switchView('history');
      window.history.replaceState(null, '', '#history');
    });
  });

  setupNav();

  document.getElementById('downloadHistoryBtn').addEventListener('click', e => {
    e.preventDefault();
    const content = JSON.stringify(history, null, 2) + '\n';
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'history.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  document.getElementById('syncNowBtn').addEventListener('click', async () => {
    const info = detectRepoInfo();
    if (!info) {
      alert('Repo auto-detect only works when the app is deployed to GitHub Pages.\n' +
            'On localhost, please use "Download history.json manually" instead.');
      return;
    }
    const content = JSON.stringify(history, null, 2) + '\n';
    const copied = await copyToClipboard(content);
    const exists = remoteSnapshot !== null;
    const url = exists
      ? `https://github.com/${info.owner}/${info.repo}/edit/main/history.json`
      : `https://github.com/${info.owner}/${info.repo}/new/main?filename=history.json`;
    window.open(url, '_blank', 'noopener');

    const fb = document.getElementById('syncNowFeedback');
    if (copied) {
      fb.innerHTML = '<span class="sync-clean">✓ JSON copied. GitHub tab opened — paste and commit.</span>';
    } else {
      fb.innerHTML = '<span class="sync-dirty">Clipboard blocked. Use "Download history.json manually" then drop the file into the GitHub tab.</span>';
    }
  });

  // history.json in the repo is the database. Always fetch on load; local cache is a
  // fallback for offline access + pending-upload state.
  (async () => {
    const remote = await fetchRemoteHistory();
    remoteSnapshot = remote;
    if (remote) {
      history = mergeHistories(remote, history);
      cacheHistory(history);
    }
    renderHistoryCard();
    refreshStartingInvoicePrefill();
  })();
});

function refreshStartingInvoicePrefill() {
  const startingInput = document.getElementById('startingInvoice');
  if (!startingInput) return;
  const historyMax = maxInvoiceFromHistory();
  const lastLocal = loadLastInvoice();
  let suggested = null;
  let source = '';
  if (historyMax > 0) {
    suggested = historyMax + 1;
    source = `next after highest in history (#${historyMax})`;
  } else if (lastLocal != null) {
    suggested = lastLocal + 1;
    source = `next after last local download (#${lastLocal})`;
  }
  if (suggested != null && !startingInput.value) {
    startingInput.value = suggested;
  }
  if (source) setLastInvoiceHint(`Prefilled ${suggested} — ${source}. Editable.`);
}

function openImportModal() {
  renderImportedTable();
  renderSkippedTable();
  updateModalTabCounts();
  const searchInput = document.getElementById('importSearch');
  searchInput.value = '';
  applyImportSearch();
  switchModalTab(document.getElementById('modal'), 'imported');
  showModal('modal');
  setTimeout(() => searchInput.focus(), 100);
}

function applyImportSearch() {
  if (!shopifyProcessed) return;
  const query = document.getElementById('importSearch').value.trim().toLowerCase();
  const imported = document.querySelectorAll('#importedTable tbody tr');
  const skipped = document.querySelectorAll('#skippedTable tbody tr');

  let importedMatches = 0;
  imported.forEach(tr => {
    const match = !query || tr.textContent.toLowerCase().includes(query);
    tr.style.display = match ? '' : 'none';
    if (match && query) importedMatches++;
  });

  let skippedMatches = 0;
  skipped.forEach(tr => {
    // Read from row inputs too so edits are searchable
    let text = tr.textContent.toLowerCase();
    tr.querySelectorAll('input').forEach(inp => { text += ' ' + inp.value.toLowerCase(); });
    const match = !query || text.includes(query);
    tr.style.display = match ? '' : 'none';
    if (match && query) skippedMatches++;
  });

  const modal = document.getElementById('modal');
  const importedTab = modal.querySelector('.modal-tab[data-tab="imported"]');
  const skippedTab = modal.querySelector('.modal-tab[data-tab="skipped"]');
  const importedTotal = shopifyProcessed.orders.length;
  const skippedTotal = shopifyProcessed.skipped.length;

  if (query) {
    importedTab.textContent = `Imported (${importedMatches}/${importedTotal})`;
    skippedTab.textContent = `Skipped (${skippedMatches}/${skippedTotal})`;
    const total = importedMatches + skippedMatches;
    const info = document.getElementById('importSearchInfo');
    if (total === 0) {
      info.textContent = 'No matches';
      info.className = 'search-info no-match';
    } else {
      info.textContent = `${total} match${total === 1 ? '' : 'es'} — Imported: ${importedMatches}, Skipped: ${skippedMatches}`;
      info.className = 'search-info';
    }
  } else {
    updateModalTabCounts();
    document.getElementById('importSearchInfo').textContent = '';
    document.getElementById('importSearchInfo').className = 'search-info';
  }
}

function openResultsModal() {
  if (!lastResult) return;
  renderResultsCombinedTable();
  renderResultsOfflineTable();
  updateResultsTabCounts();
  const searchInput = document.getElementById('resultsSearch');
  searchInput.value = '';
  applyResultsSearch();
  switchModalTab(document.getElementById('resultsModal'), 'combined');
  showModal('resultsModal');
  setTimeout(() => searchInput.focus(), 100);
}

function applyResultsSearch() {
  if (!lastResult) return;
  const query = document.getElementById('resultsSearch').value.trim().toLowerCase();
  const combined = document.querySelectorAll('#resultsCombinedTable tbody tr');
  const offline = document.querySelectorAll('#resultsOfflineTable tbody tr');

  let combinedMatches = 0;
  combined.forEach(tr => {
    const match = !query || tr.textContent.toLowerCase().includes(query);
    tr.style.display = match ? '' : 'none';
    if (match && query) combinedMatches++;
  });

  let offlineMatches = 0;
  offline.forEach(tr => {
    const match = !query || tr.textContent.toLowerCase().includes(query);
    tr.style.display = match ? '' : 'none';
    if (match && query) offlineMatches++;
  });

  const modal = document.getElementById('resultsModal');
  const combinedTab = modal.querySelector('.modal-tab[data-tab="combined"]');
  const offlineTab = modal.querySelector('.modal-tab[data-tab="offline"]');
  const combinedTotal = lastResult.combined.length;
  const offlineTotal = (lastResult.offlineOutputRows || []).length;

  if (query) {
    combinedTab.textContent = `Combined (${combinedMatches}/${combinedTotal})`;
    offlineTab.textContent = `Offline (${offlineMatches}/${offlineTotal})`;
    const total = combinedMatches + offlineMatches;
    const info = document.getElementById('resultsSearchInfo');
    if (total === 0) {
      info.textContent = 'No matches';
      info.className = 'search-info no-match';
    } else {
      info.textContent = `${total} match${total === 1 ? '' : 'es'} — Combined: ${combinedMatches}, Offline: ${offlineMatches}`;
      info.className = 'search-info';
    }
  } else {
    updateResultsTabCounts();
    document.getElementById('resultsSearchInfo').textContent = '';
    document.getElementById('resultsSearchInfo').className = 'search-info';
  }
}

function showModal(modalId) {
  document.getElementById(modalId).hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeAnyModal(modalId) {
  document.getElementById(modalId).hidden = true;
  const anyOpen = [...document.querySelectorAll('.modal')].some(m => !m.hidden);
  if (!anyOpen) document.body.style.overflow = '';
}

function setupModalTabs(modalEl) {
  modalEl.querySelectorAll('.modal-tab').forEach(tab => {
    tab.addEventListener('click', () => switchModalTab(modalEl, tab.dataset.tab));
  });
}

function switchModalTab(modalEl, tabName) {
  modalEl.querySelectorAll('.modal-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabName);
  });
  modalEl.querySelectorAll('.tab-panel').forEach(p => {
    p.hidden = p.dataset.panel !== tabName;
  });
}

function updateModalTabCounts() {
  if (!shopifyProcessed) return;
  document.querySelector('.modal-tab[data-tab="imported"]').textContent =
    `Imported (${shopifyProcessed.orders.length})`;
  document.querySelector('.modal-tab[data-tab="skipped"]').textContent =
    `Skipped (${shopifyProcessed.skipped.length})`;
}

function renderImportedTable() {
  const table = document.getElementById('importedTable');
  const rows = shopifyProcessed ? shopifyProcessed.orders : [];
  const thead = `<thead><tr>${OUTPUT_HEADING.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const body = rows.map(r =>
    `<tr>${OUTPUT_HEADING.map(h => `<td>${escapeHtml(r[h] ?? '')}</td>`).join('')}</tr>`
  ).join('');
  table.innerHTML = thead + `<tbody>${body || '<tr><td>No orders imported yet.</td></tr>'}</tbody>`;
}

const SKIPPED_FIELDS = [
  { key: 'invoiceNo', label: 'Order #' },
  { key: 'paidAt',    label: 'Paid at' },
  { key: 'name',      label: 'Billing Name' },
  { key: 'state',     label: 'State' },
  { key: 'totalStr',  label: 'Total' }
];

function renderSkippedTable() {
  const table = document.getElementById('skippedTable');
  const skipped = shopifyProcessed ? shopifyProcessed.skipped : [];
  const headers = ['Reason', ...SKIPPED_FIELDS.map(f => f.label), ''];
  const thead = `<thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const body = skipped.map((s, idx) => {
    const badSet = new Set([...(s.missing || []).map(fieldKeyFromLabel), ...(s.badFields || [])]);
    const cells = SKIPPED_FIELDS.map(f => {
      const bad = badSet.has(f.key);
      return `<td><input type="text" data-idx="${idx}" data-field="${f.key}" value="${escapeHtml(s.raw[f.key] || '')}" class="${bad ? 'field-bad' : ''}"/></td>`;
    }).join('');
    return `<tr>
      <td class="reason-cell">${escapeHtml(s.reason)}</td>
      ${cells}
      <td><button type="button" class="recover-btn" data-idx="${idx}">Recover</button></td>
    </tr>`;
  }).join('');
  table.innerHTML = thead + `<tbody>${body || '<tr><td>No skipped rows.</td></tr>'}</tbody>`;

  table.querySelectorAll('input[data-idx]').forEach(input => {
    input.addEventListener('input', e => {
      const idx = Number(e.target.dataset.idx);
      const field = e.target.dataset.field;
      shopifyProcessed.skipped[idx].raw[field] = e.target.value;
    });
  });
  table.querySelectorAll('.recover-btn').forEach(btn => {
    btn.addEventListener('click', () => recoverSkippedRow(Number(btn.dataset.idx)));
  });
}

function fieldKeyFromLabel(label) {
  const map = {
    'Name': 'invoiceNo',
    'Paid at': 'paidAt',
    'Total': 'totalStr',
    'Billing Name': 'name',
    'Billing Province': 'state'
  };
  return map[label] || label;
}

function recoverSkippedRow(idx) {
  const entry = shopifyProcessed.skipped[idx];
  const result = tryBuildOnlineOrder(entry.raw, getMinTotal());
  if (!result.ok) {
    alert(`Still can't import: ${result.reason}`);
    entry.reason = result.reason;
    entry.missing = result.missing || [];
    entry.badFields = result.badFields || [];
    renderSkippedTable();
    return;
  }
  shopifyProcessed.orders.push(result.order);
  shopifyProcessed.skipped.splice(idx, 1);
  updateShopifyPreviewBtn();
  updateModalTabCounts();
  renderImportedTable();
  renderSkippedTable();
  applyImportSearch();
  renderShopifyStatus();
}

function updateShopifyPreviewBtn() {
  const btn = document.getElementById('viewShopifyBtn');
  if (shopifyProcessed) {
    btn.hidden = false;
    btn.textContent = `View orders (${shopifyProcessed.orders.length} imported, ${shopifyProcessed.skipped.length} skipped)`;
  } else {
    btn.hidden = true;
  }
}

function renderShopifyStatus() {
  const status = document.getElementById('shopifyStatus');
  if (!status || !shopifyProcessed) return;
  status.innerHTML =
    `Loaded: <b>${escapeHtml(shopifyProcessed.fileName)}</b> — ` +
    `${shopifyProcessed.totalRows} CSV rows, ` +
    `<b>${shopifyProcessed.orders.length}</b> orders kept, ` +
    `<b>${shopifyProcessed.skipped.length}</b> skipped`;
  status.className = 'status ok';
}

function reprocessShopifyIfLoaded() {
  if (!shopifyProcessed || !shopifyProcessed.rawRows) return;
  const res = processShopifyRows(shopifyProcessed.rawRows, getMinTotal());
  shopifyProcessed.orders = res.orders;
  shopifyProcessed.skipped = res.skipped;
  renderShopifyStatus();
  updateShopifyPreviewBtn();
  if (!document.getElementById('modal').hidden) {
    renderImportedTable();
    renderSkippedTable();
    updateModalTabCounts();
    applyImportSearch();
  }
}

function onShopifyFileChosen(e) {
  const file = e.target.files[0];
  const status = document.getElementById('shopifyStatus');
  if (!file) {
    shopifyProcessed = null;
    status.textContent = '';
    updateShopifyPreviewBtn();
    return;
  }
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: results => {
      const res = processShopifyRows(results.data, getMinTotal());
      shopifyProcessed = {
        orders: res.orders,
        skipped: res.skipped,
        totalRows: results.data.length,
        rawRows: results.data,
        fileName: file.name
      };
      renderShopifyStatus();
      updateShopifyPreviewBtn();
    },
    error: err => {
      shopifyProcessed = null;
      status.textContent = 'Parse error: ' + err.message;
      status.className = 'status err';
      updateShopifyPreviewBtn();
    }
  });
}

function parsePastedRows(text) {
  const lines = text.split(/\r?\n/);
  const parsed = [];
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;
    // Prefer tab (spreadsheet paste); fall back to 2+ whitespace.
    let cells = rawLine.split('\t');
    if (cells.length === 1) cells = rawLine.split(/\s{2,}/);
    cells = cells.map(c => c.trim());
    if (cells.every(c => !c)) continue;

    let row;
    if (cells.length >= 8) {
      // Date, Invoice#, Party, Amount, GST, IGST, Total, GSTIN — drop Invoice# and IGST
      row = { Date: cells[0], Party: cells[2], Amount: cells[3], GST: cells[4], Total: cells[6], GSTIN: cells[7] };
    } else if (cells.length === 7) {
      // Date, Invoice#, Party, Amount, GST, Total, GSTIN — drop Invoice#
      row = { Date: cells[0], Party: cells[2], Amount: cells[3], GST: cells[4], Total: cells[5], GSTIN: cells[6] };
    } else if (cells.length >= 6) {
      // Date, Party, Amount, GST, Total, GSTIN
      row = { Date: cells[0], Party: cells[1], Amount: cells[2], GST: cells[3], Total: cells[4], GSTIN: cells[5] };
    } else {
      continue;
    }
    if (!row.Date && !row.Party) continue;
    parsed.push(row);
  }
  return parsed;
}

function onParsePaste() {
  const textarea = document.getElementById('pasteArea');
  const text = textarea.value;
  if (!text.trim()) return;
  const newRows = parsePastedRows(text);
  if (newRows.length === 0) {
    alert('No rows detected. Make sure you pasted tab-separated data (copy directly from a spreadsheet).');
    return;
  }
  const nonEmpty = offlineRows.filter(r => Object.values(r).some(v => String(v || '').trim() !== ''));
  offlineRows = [...nonEmpty, ...newRows];
  persistOfflineRows();
  renderOfflineTable(offlineRows);
  textarea.value = '';
}

function onOfflineFileChosen(e) {
  const file = e.target.files[0];
  if (!file) return;
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: results => {
      const newRows = results.data
        .filter(r => Object.values(r).some(v => String(v || '').trim() !== ''))
        .map(r => ({
          Date: r['Date'] || '',
          Party: r['Party'] || '',
          Amount: r['Amount'] || '',
          GST: r['GST'] || '',
          Total: r['Total'] || '',
          GSTIN: r['GSTIN'] || ''
        }));
      if (newRows.length === 0) {
        alert('No rows found in that CSV.');
        return;
      }
      const merge = confirm(`Found ${newRows.length} rows. OK = replace existing table, Cancel = append to existing.`);
      if (merge) {
        offlineRows = newRows;
      } else {
        const nonEmpty = offlineRows.filter(r => Object.values(r).some(v => String(v || '').trim() !== ''));
        offlineRows = [...nonEmpty, ...newRows];
      }
      persistOfflineRows();
      renderOfflineTable(offlineRows);
    },
    error: err => alert('CSV parse error: ' + err.message)
  });
  e.target.value = '';
}

function onGenerate() {
  const status = document.getElementById('generateStatus');
  const startingRaw = document.getElementById('startingInvoice').value.trim();
  if (!startingRaw) {
    status.textContent = 'Enter a starting invoice number.';
    status.className = 'status err';
    return;
  }
  const startingInvoiceNo = parseInt(startingRaw, 10);
  if (isNaN(startingInvoiceNo) || startingInvoiceNo < 1) {
    status.textContent = 'Starting invoice number must be a positive integer.';
    status.className = 'status err';
    return;
  }

  const shopifyOrders = shopifyProcessed ? shopifyProcessed.orders : [];
  const shopifySkipped = shopifyProcessed ? shopifyProcessed.skipped.length : 0;

  const nonEmptyOfflineRows = offlineRows.filter(r => String(r.Date || '').trim() !== '');
  const { orders: offlineOrders, originalRows: originalOfflineRows, skipped: offlineSkipped } =
    processOfflineRows(nonEmptyOfflineRows);

  if (shopifyOrders.length === 0 && offlineOrders.length === 0) {
    status.textContent = 'No valid rows to process. Upload a Shopify CSV or add offline rows.';
    status.className = 'status err';
    return;
  }

  const { combined, invoiceMap } = combineAndRenumber(shopifyOrders, offlineOrders, startingInvoiceNo);

  // Rebuild offline output rows with new invoice numbers
  const offlineOutputRows = originalOfflineRows.map(r => ({
    Date: r.Date,
    'Invoice No.': invoiceMap[`off-${r._tempNo}`] || r['Invoice No.'],
    Party: r.Party,
    Amount: r.Amount,
    GST: r.GST,
    IGST: r.IGST,
    Total: r.Total,
    GSTIN: r.GSTIN
  }));

  const combinedCsv = toCsv(combined, OUTPUT_HEADING);
  const offlineCsv = toCsv(offlineOutputRows, OFFLINE_OUTPUT_HEADING);

  const totalTax = combined.reduce((sum, r) =>
    sum + (Number(r['Total Transaction Value']) - Number(r['Item Taxable Value'])), 0);

  // Date range (combined is already sorted by date)
  const firstDate = combined[0]._dateObj;
  const lastDate = combined[combined.length - 1]._dateObj;
  const firstStr = formatDate(firstDate);
  const lastStr = formatDate(lastDate);

  // Snap to full quarter boundaries — quarterly GST return covers the whole quarter.
  const startMonth = fiscalQuarterStartMonth(firstDate.month);
  const filingStart = { year: firstDate.year, month: startMonth, day: 1 };
  const endMonth = fiscalQuarterEndMonth(lastDate.month);
  const filingEnd = { year: lastDate.year, month: endMonth, day: daysInMonth(lastDate.year, endMonth) };

  const firstFriendly = formatFriendlyDate(filingStart);
  const lastFriendly = formatFriendlyDate(filingEnd);
  const actualFirstFriendly = formatFriendlyDate(firstDate);
  const actualLastFriendly = formatFriendlyDate(lastDate);
  const rangeLabel = firstFriendly === lastFriendly
    ? `${firstFriendly} <small>(orders: ${actualFirstFriendly} – ${actualLastFriendly})</small>`
    : `${firstFriendly} → ${lastFriendly} <small>(orders: ${actualFirstFriendly} – ${actualLastFriendly})</small>`;
  const filenameBase = firstFriendly === lastFriendly
    ? `${firstFriendly}_gst_sheet`
    : `${firstFriendly}_${lastFriendly}_gst_sheet`;

  const lastNo = startingInvoiceNo + combined.length - 1;

  // Month-wise tax breakdown (keys: "YYYY-MM")
  const monthlyTax = {};
  for (const order of combined) {
    const key = `${order._dateObj.year}-${String(order._dateObj.month).padStart(2, '0')}`;
    const rowTax = Number(order['Total Transaction Value']) - Number(order['Item Taxable Value']);
    monthlyTax[key] = round2((monthlyTax[key] || 0) + rowTax);
  }

  lastResult = {
    combined, combinedCsv, offlineCsv, offlineOutputRows, invoiceMap, startingInvoiceNo,
    firstStr, lastStr, rangeLabel, filenameBase, lastNo, counterSaved: false,
    monthlyTax,
    filingStart, filingEnd,
    onlineCount: shopifyOrders.length, offlineCount: offlineOrders.length
  };

  // Show pending-download hint. The persistent counter is only advanced after
  // a real download click (see persistLastInvoiceAfterDownload).
  setLastInvoiceHint(`Generated preview — counter will move to ${lastNo + 1} after you download a CSV.`);

  const summary = document.getElementById('summary');
  summary.innerHTML = `
    <div class="wide"><span class="label">Filing period (snapped to quarter)</span><span class="value">${rangeLabel}</span></div>
    <div><span class="label">Online orders</span><span class="value">${shopifyOrders.length}${shopifySkipped ? ` <small>(${shopifySkipped} skipped)</small>` : ''}</span></div>
    <div><span class="label">Offline orders</span><span class="value">${offlineOrders.length}${offlineSkipped ? ` <small>(${offlineSkipped} skipped)</small>` : ''}</span></div>
    <div><span class="label">Total invoices</span><span class="value">${combined.length}</span></div>
    <div><span class="label">Invoice range</span><span class="value">${startingInvoiceNo} – ${lastNo}</span></div>
    <div><span class="label">Total tax</span><span class="value">₹${round2(totalTax).toFixed(2)}</span></div>
    <div class="wide filename-tile">
      <span class="label">Filename base (edit to customise)</span>
      <div class="filename-editor">
        <input type="text" id="filenameBase" value="${escapeHtml(filenameBase)}" spellcheck="false" />
        <span class="filename-preview" id="filenamePreview"></span>
      </div>
    </div>
  `;
  wireFilenameInput();

  document.getElementById('resultsCard').hidden = false;
  const saveBtn = document.getElementById('saveToHistoryBtn');
  saveBtn.disabled = false;
  saveBtn.textContent = 'Save to filing history';
  document.getElementById('saveHistoryStatus').textContent = '';
  document.getElementById('saveHistoryStatus').className = 'status';
  status.textContent = 'Generated. Click "View full output" to inspect, or download directly.';
  status.className = 'status ok';
  document.getElementById('resultsCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderResultsCombinedTable() {
  const rows = lastResult.combined;
  const table = document.getElementById('resultsCombinedTable');
  const thead = `<thead><tr>${OUTPUT_HEADING.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const body = rows.map(r =>
    `<tr>${OUTPUT_HEADING.map(h => `<td>${escapeHtml(r[h] ?? '')}</td>`).join('')}</tr>`
  ).join('');
  table.innerHTML = thead + `<tbody>${body}</tbody>`;
  const first = lastResult.startingInvoiceNo;
  const last = first + rows.length - 1;
  document.getElementById('resultsCombinedMeta').innerHTML =
    `${lastResult.rangeLabel} · ${rows.length} rows · invoice #${first} – #${last} · saves as <code>${escapeHtml(currentFilenameBase())}.csv</code>`;
}

function renderResultsOfflineTable() {
  const rows = lastResult.offlineOutputRows || [];
  const table = document.getElementById('resultsOfflineTable');
  const heading = OFFLINE_OUTPUT_HEADING;
  const thead = `<thead><tr>${heading.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const body = rows.length
    ? rows.map(r => `<tr>${heading.map(h => `<td>${escapeHtml(r[h] ?? '')}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${heading.length}" style="color:var(--muted);text-align:center;padding:20px;">No offline orders in this run.</td></tr>`;
  table.innerHTML = thead + `<tbody>${body}</tbody>`;
  document.getElementById('resultsOfflineMeta').innerHTML = rows.length
    ? `${rows.length} offline invoices with newly assigned numbers · saves as <code>${escapeHtml(currentFilenameBase())}_offline.csv</code>`
    : '';
}

function updateResultsTabCounts() {
  if (!lastResult) return;
  const modal = document.getElementById('resultsModal');
  modal.querySelector('.modal-tab[data-tab="combined"]').textContent =
    `Combined output (${lastResult.combined.length})`;
  modal.querySelector('.modal-tab[data-tab="offline"]').textContent =
    `Offline output (${(lastResult.offlineOutputRows || []).length})`;
}
