# GST Invoice Generator

A browser-only tool for **SV Graphics** to generate quarterly GST return CSVs by combining Shopify online orders with offline sales. Runs entirely client-side — customer data never leaves the machine.

**Live app:** https://chahatagrawal117.github.io/gst/
**Website:** https://sv-graphics.com

---

## What it does

- Reads Shopify's `orders_export.csv`, groups by order, filters out payment tokens (Total < ₹10)
- Accepts offline sales via three input methods: paste from a spreadsheet, upload a CSV, or type into an editable table
- Computes taxable value, CGST/SGST (RJ orders) or IGST (all others) at 18%
- Sorts all orders (online + offline) by date, assigns sequential invoice numbers starting from a configurable base
- Snaps the filename to the full fiscal quarter (e.g. `1Jan26_31Mar26_gst_sheet.csv`)
- Downloads two files: **combined output** (the GST return) and **offline output** (your bill book with the new invoice numbers filled in)
- Maintains a filing history — total tax filed to date, month-wise breakdown, list of past quarters — stored in `history.json` in this repo so it's available on any device

## How to use

Open the app at **https://chahatagrawal117.github.io/gst/**. Use the top nav to switch between **New filing** and **History**.

### New filing

1. **Starting invoice number** — auto-prefills to `1 + max invoice from history`. Editable if you need to override.
2. **Shopify order export** — click "Choose Shopify orders_export CSV" and select the file you downloaded from Shopify → Orders → Export. Adjust the "Skip orders below ₹" threshold if needed (default ₹10 hides UPI payment tokens). Click "View imported orders" to see what was kept vs. skipped; you can edit and recover any skipped row.
3. **Offline orders** — pick one:
   - **Paste**: copy tab-separated rows from your Excel/Google Sheet and paste into the box → click "Add pasted rows"
   - **Upload CSV**: same 8-column schema as the paste format
   - **Type manually**: click "+ Add row" and fill in the table
4. **Generate output** — reviews the summary card with counts, invoice range, total tax, and filing period.
5. **Download combined CSV** and **Download offline CSV** — filenames come from the fiscal quarter, editable via the "Filename base" input.
6. **Save to filing history** — appends this quarter's summary to your history file.

### History

- Shows total tax filed to date, invoice range across all quarters, and a month-wise tax dashboard.
- Search a specific GSTIN / invoice # / party name from the results modal.
- To sync a new filing across devices:
  1. Click **Download history.json**
  2. Open this repo on github.com → navigate to `history.json` (or use "Add file → Upload files" if it doesn't exist yet)
  3. Replace the file → commit
  4. On any other device, open the app → history loads automatically

The status banner at the top of History indicates whether your local view is in sync with the repo or has pending uploads.

## Configuration (hardcoded, visible in the UI)

- **Home state:** RJ (Rajasthan) — RJ orders get CGST+SGST split; all other states get IGST. Offline orders always get IGST.
- **HSN code:** 4909
- **Tax rate:** 18%
- **Fiscal quarters:** Apr-Jun (Q1), Jul-Sep (Q2), Oct-Dec (Q3), Jan-Mar (Q4)

## Files in the repo

| File | Purpose |
|---|---|
| `index.html` | UI markup |
| `app.js` | All logic — CSV parsing, tax math, tables, modals, history, sync |
| `style.css` | Styling |
| `favicon.svg` | Browser tab icon |
| `run.py` | Original Python script (CLI equivalent). Edit paths at the bottom, run with `python3 run.py`. |
| `history.json` *(not tracked; you upload it)* | Cross-device filing history, treated as the database |
| `.gitignore` | Excludes customer CSVs, IDE folders, and the Python venv |

## Deploying (already done)

The app is deployed to GitHub Pages from the `main` branch root. Any commit to `main` triggers a redeploy within ~1 minute. To make changes:

```bash
git add index.html app.js style.css   # whatever you changed
git commit -m "your message"
git push
```

## Privacy notes

- All CSV parsing and tax computation happens in your browser. Nothing is uploaded to any server.
- The `.gitignore` blocks all `*.csv` files, so customer data never accidentally gets committed.
- Only `history.json` (summary data — filing period, invoice range, total tax, month-wise breakdown) gets committed to the repo when you manually upload it.
