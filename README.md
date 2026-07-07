# GST Invoice Generator

Combines Shopify export + offline sales, sorts by date, assigns sequential invoice numbers, and generates the CSV needed for filing GST returns.

## How to use (browser)

Open the site (locally with `python3 -m http.server 8000` inside this folder, or deployed via GitHub Pages). Use the sticky nav bar at the top to jump between **New filing** and **History**.

1. Enter the starting invoice number (auto-prefilled from your last run after you download).
3. Upload the Shopify `orders_export_*.csv` and set the "Skip orders below ₹" threshold if needed. Click **View orders** to inspect what was imported / skipped and recover skipped rows.
4. Add offline sales — paste rows directly from Excel/Sheets, upload a CSV, or type into the table.
5. Click **Generate output**. Review the summary; the filename base defaults to `1Jan26_31Mar26_gst_sheet` (snapped to the fiscal quarter).
6. Click **Download combined CSV** and **Download offline CSV**. Downloading also saves the filing to your local history (bottom of the page) — total tax, invoice range, and month-wise breakdown accumulate over time.

## Configuration (hardcoded — visible in the UI)

- Home state: `RJ` — orders from RJ get CGST+SGST split; every other state gets IGST
- HSN code: `4909`
- Tax rate: `18%`
- Fiscal quarters: Apr-Jun / Jul-Sep / Oct-Dec / Jan-Mar

## Deploying to GitHub Pages

1. Create a repository on GitHub (public — the `.gitignore` here already excludes all `*.csv` so your customer data won't be pushed).
2. Push this folder:
   ```
   git init
   git add index.html app.js style.css README.md .gitignore run.py
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<username>/<repo>.git
   git push -u origin main
   ```
3. GitHub → Settings → Pages → Source: `Deploy from a branch` → Branch: `main` / root → Save.
4. Wait ~1 minute. Your app is live at `https://<username>.github.io/<repo>/`.

## Files

- `index.html` / `app.js` / `style.css` — the browser app (100% client-side, no server)
- `run.py` — original Python script; edit paths at the bottom and run for a CLI version
- `.gitignore` — excludes CSVs, IDE folders, and the Python venv

## Cross-device history sync

The app looks for a file called `history.json` at the site root. If it's there, it's fetched on every page load and merged with the local browser cache — that's how new devices/browsers see your past filings.

**To sync a new filing across devices:**
1. On the browser where you just filed, scroll to "Filing history" → click **Download history.json**.
2. Open your repo on github.com.
3. Replace (or upload for the first time) `history.json` — either click the existing file → pencil (Edit) → paste new content, or use **Add file → Upload files** and drop the file.
4. Commit.
5. On any other device, open the site — history loads automatically.

Since this uses the repo itself as storage, there's no token/backend needed. The manual upload takes ~30 seconds per filing.

## Notes

- All processing happens in your browser. No customer data ever leaves your machine except when you manually upload `history.json` to your repo.
- Starting invoice number auto-prefills from the highest invoice number found across all filings in history.
