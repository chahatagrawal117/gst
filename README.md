# GST Invoice Generator

Browser-only tool for **[SV Graphics](https://sv-graphics.com)** to generate quarterly GST return CSVs by combining Shopify online orders with offline sales. Runs entirely client-side — no server, no data upload, no database. All customer data stays on your machine; only a summary `history.json` (period, invoice range, totals) is committed to this repo for cross-device access.

**Live app:** https://chahatagrawal117.github.io/gst/

---

## Table of contents

- [What it does](#what-it-does)
- [Workflow](#workflow)
  - [1. New filing](#1-new-filing)
  - [2. Save to filing history](#2-save-to-filing-history)
  - [3. Sync to GitHub (one click)](#3-sync-to-github-one-click)
- [History view](#history-view)
- [Configuration (hardcoded)](#configuration-hardcoded)
- [Code structure](#code-structure)
- [Running locally](#running-locally)
- [Deploying changes](#deploying-changes)
- [Privacy](#privacy)

---

## What it does

1. **Reads a Shopify order export CSV** — groups by order ID (one CSV row per line item, so the same order can span many rows), filters out low-value payment tokens (Total < ₹10 by default), and normalises dates.
2. **Takes offline sales** — either paste tab-separated rows from Excel/Sheets, upload a CSV, or type into an editable table. Data auto-saves in `localStorage` so refreshes don't lose it.
3. **Computes tax** — `taxable = Total ÷ 1.18`, `total_tax = Total − taxable`. For RJ (home state) orders: split evenly into CGST + SGST. For all other states and every offline order: assigned entirely to IGST. Uses raw float arithmetic (not intermediate-rounded) so numbers match the original Python script byte-for-byte.
4. **Merges and renumbers** — combines online + offline, sorts by date, assigns sequential invoice numbers starting from a configurable base. Numbers are never duplicated or skipped (the original Python had a subtle double-counting bug that consumed one number per offline order — fixed here).
5. **Snaps filename to fiscal quarter** — a filing with any date in Jan–Mar automatically names its CSV `1Jan26_31Mar26_gst_sheet.csv` (full Indian fiscal quarter, even if actual data only covers 2 months). Filename remains editable.
6. **Outputs two CSVs** — combined output (the GST return itself, columns exactly as the Python original) and an offline output (your bill book with the newly-assigned invoice numbers filled in).
7. **Records the filing** — a compact summary (period, totals, monthly tax breakdown, invoice range) goes into local history and can be one-click-synced to a shared `history.json` in this repo. History is loaded on every device automatically.

## Workflow

Open **https://chahatagrawal117.github.io/gst/** — the top nav lets you switch between **New filing** and **History** views.

### 1. New filing

- **Starting invoice number** — auto-prefills to `latest quarter's max + 1`. Uses the most-recent quarter only (not global max), because invoice numbering can reset between quarters.
- **Shopify order export** — click "Choose Shopify orders_export CSV". The status line shows `X rows read, Y orders kept, Z skipped`. Adjust "Skip orders below ₹" if you want to include or exclude payment tokens. Click **"View orders"** for a modal with two tabs:
  - **Imported (N)** — orders that will go into the GST return, with computed tax values
  - **Skipped (M)** — with the exact reason per row (`Total < ₹10`, `missing: Billing Province`, etc.). Edit the highlighted fields in-place and click **Recover** to move any row back into the imported list.
  - A search box at the top filters both tabs live; tab labels show match counts like `Imported (2/125) · Skipped (0/114)`.
- **Offline orders** — pick any of three methods:
  1. **Paste** — copy rows from Excel/Sheets and paste into the box. Accepts 6, 7, or 8 column layouts; auto-detects.
  2. **Upload CSV** — same schema as your existing offline sheet.
  3. **Type manually** — click "+ Add row" and fill in.
- **Generate output** — shows the summary card with counts, invoice range, total tax, filing period, and the auto-computed filename.
- **View full output** — opens a modal with two tabs (Combined + Offline) showing the exact rows with a live search box (search a GSTIN, party name, order #, etc.).
- **Download combined CSV** and **Download offline CSV** — filenames come from the filename base input, which defaults to `${firstDay}_${lastDay}_gst_sheet` snapped to the fiscal quarter but is fully editable.

### 2. Save to filing history

Click **"Save to filing history"** in the results card. This adds an entry to your local history with:
- Filing period (e.g. `1Apr26 → 30Jun26`)
- Total invoices, invoice range start/end, total tax
- Month-wise tax breakdown
- Online vs offline order counts

The button then changes to **"✓ Saved to history"** with a link to the History view.

### 3. Sync to GitHub (one click)

Go to the History view. The **sync panel** at the top has four actions:

- **Sync now → open GitHub** *(primary)* — copies the JSON to your clipboard AND opens the GitHub edit page for `history.json` in a new tab. Paste (⌘+V), scroll down, click **Commit changes**. That's it — history is now visible on all your other devices.
- **📋 Copy JSON** — just copies to clipboard (no tab open).
- **💾 Download file** — saves `history.json` locally so you can drag-drop into GitHub's upload page.
- **🔄 Refresh from GitHub** — re-fetches `history.json` and discards local changes (confirms first if you have unsynced edits). Perfect for recovering from accidental deletes.

A live status banner shows whether your local view is in sync with the repo:
- 🟢 `in sync with repo`
- 🟡 `2 new — not yet uploaded to GitHub`

## History view

The History tab shows:
- **Total tax filed to date** across all quarters
- **Total invoices** across all quarters
- **Quarter-by-quarter table** — sortable by fiscal quarter, with a delete button per row (tombstoned locally so deletes stick across page reloads even if the remote still has them)
- **Yearly tax dashboard** — grouped by Indian fiscal year (Apr–Mar). Each year row shows the FY label, month count, and total tax. Click a year to expand its month-wise breakdown. Latest year is expanded by default.

## Configuration (hardcoded)

Visible in the UI so you can see what applies:

| Field | Value | Notes |
|---|---|---|
| Home state | `RJ` (Rajasthan) | RJ orders → CGST + SGST split. All other states → IGST |
| HSN code | `4909` | Written on every output row |
| Tax rate | `18%` | Divisor for taxable value = Total ÷ 1.18 |
| Minimum order value | `₹10` (editable) | Orders below this are skipped (typical ₹1 UPI payment tokens) |
| Fiscal quarters | Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar | Filenames and yearly rollups use these boundaries |

Changing any of these requires editing the constants at the top of `app.js`.

## Code structure

Single-page app, three files handle everything:

### `index.html`

Semantic markup only — nav bar, two view containers (`data-view="new-filing"` and `data-view="history"`), two modals (import viewer + results viewer), and the sync panel. All logic lives in `app.js`.

### `app.js` (~ 800 lines, no dependencies except PapaParse)

Organised into sections:

- **Constants** — `HOME_STATE`, `HSN`, `TAX_RATE`, `MONTH_ABBR`, localStorage keys, headings
- **Date helpers** — Shopify date parser, offline date parser (handles `DD.MM.YY` and `DD-MM-YYYY`), fiscal quarter math, friendly date formatting
- **Tax math** — `computeTax(total, state)` returning taxable/CGST/SGST/IGST as pre-formatted strings that match Python's `str(float)` output
- **CSV processing** — `processShopifyRows` groups by order Name (primary + line-item continuation), `tryBuildOnlineOrder` per-order validation with structured skip reasons, `processOfflineRows`, `combineAndRenumber` merges & assigns sequential invoice numbers
- **History persistence** — localStorage cache, tombstones for cross-fetch deletes, `sortFilingsByMonth` (uses `filingStartYearMonth` YYYY-MM keys), `mergeHistories` with remote-priority-by-timestamp
- **GitHub sync** — `detectRepoInfo()` from Pages URL, `copyToClipboard()` with execCommand fallback, wire-up for Sync now / Copy / Download / Refresh buttons
- **UI rendering** — imported/skipped/results modals, offline-table CRUD, tabbed modal switching (`setupModalTabs`), filename editor with live preview, yearly-tax with expandable `<details>` per fiscal year
- **DOMContentLoaded init** — restores state from localStorage, fetches remote `history.json`, wires all event listeners

### `style.css`

- CSS variables for colours (single `--primary` for the whole app)
- Card layout with responsive breakpoint at 640px
- Sticky nav with translucent blur background
- Two modals (Import viewer, Results) sharing tab and search-bar styles
- Sticky-right column on the offline table so the delete button stays visible on horizontal scroll

### `favicon.svg`

A simple three-bar chart icon in the app's primary blue. Loaded from `<link rel="icon">`.

### `run.py` (original Python script)

Kept for reference and as a CLI-usable equivalent. Edit paths at the bottom, then `python3 run.py`. Was the source of the ported logic; bug fixes (numbering-gap and offline-row-drift) applied to both.

### `history.json`

Not source code — it's the database. Structure:

```json
{
  "version": 1,
  "filings": [
    {
      "id": "1Apr26_30Jun26_gst_sheet",
      "period": "1Apr26 → 30Jun26",
      "filingStart": "1Apr26",
      "filingEnd": "30Jun26",
      "filingStartYearMonth": "2026-04",
      "generatedAt": "2026-07-07T16:37:40.662Z",
      "onlineOrders": 96,
      "offlineOrders": 25,
      "totalInvoices": 121,
      "invoiceRangeStart": 636,
      "invoiceRangeEnd": 756,
      "totalTax": 43705.23,
      "monthlyTax": {
        "2026-04": 11935.54,
        "2026-05": 18927.60,
        "2026-06": 12842.09
      }
    }
  ]
}
```

Sorted by `filingStartYearMonth` descending (latest first). Fetched on every page load. Merged with `localStorage` cache — filings in local that aren't in remote count as "pending upload"; ids in the local tombstones set are never re-added even if remote has them.

## Running locally

```bash
cd /path/to/gst
python3 -m http.server 8000
# open http://localhost:8000
```

Any change to `index.html`, `app.js`, or `style.css` — just refresh the browser tab. State (offline rows, last invoice, min-total, history) persists across refreshes in `localStorage`.

## Deploying changes

The repo is set up so any commit to `main` triggers a GitHub Pages redeploy in ~30–60 seconds.

```bash
git add index.html app.js style.css
git commit -m "your message"
git push origin main
# check https://chahatagrawal117.github.io/gst/ shortly
```

Pages settings: **Settings → Pages → Source: `main` / root**. History file (`history.json`) is at the repo root; it's fetched with `cache: 'no-store'` so browsers always get the latest.

## Privacy

- All CSV parsing, tax computation, and history reads happen in the browser. Nothing is uploaded to any server, ever.
- The `.gitignore` blocks all `*.csv` files, so customer data never accidentally gets committed to the repo.
- Only `history.json` — which contains summary data (filing period, invoice range, total tax, month-wise breakdown, order counts) — gets committed to the repo when you manually upload it via the Sync flow. No customer names, addresses, or GSTINs are in this file.
- The repo is public because GitHub Pages requires a public repo on the free tier. If that ever becomes a concern, switch to GitHub Pro ($4/mo) and make the repo private.

---

_Built for SV Graphics · https://sv-graphics.com_
