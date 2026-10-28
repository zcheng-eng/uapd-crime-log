# UAPD Crime Log Tracker

An interactive dashboard of the University of Arizona Police Department's
[Daily Crime and Safety Log](https://uapd.arizona.edu/public-information/uapd-daily-activity-log),
refreshed every morning by GitHub Actions and hosted free on GitHub Pages.

```
uapd.arizona.edu log  ──(daily, 7:15 a.m. AZ)──>  scraper/scrape.py  ──>  docs/data/incidents.csv
                                                                              │
                                    GitHub Pages  <──  docs/index.html reads it
```

## What's here

| Path | What it does |
|---|---|
| `scraper/scrape.py` | Reads the log page by page and merges rows into the CSV by case number. Standard-library Python only. |
| `scraper/categories.py` | Groups UAPD's raw "Nature of Crime" and "Disposition" labels into broad categories. Edit this to change the groupings. |
| `docs/index.html`, `app.js`, `style.css` | The dashboard. Plain HTML/JS, no build step. |
| `docs/data/incidents.csv` | The dataset (one row per log entry). |
| `docs/data/changes.csv` | Every field that changed on an existing entry, with the date the change was noticed. |
| `docs/data/meta.json` | When the scraper last ran and how much of the log the data covers. |
| `.github/workflows/update.yml` | The daily schedule: scrape, commit the data, redeploy the site. |

## Putting it online (one-time setup, ~10 minutes)

1. **Create a public GitHub repository**, for example `uapd-crime-log`. (GitHub Pages and
   Actions are free for public repositories.)
2. **Push these files to it.** From this folder:
   ```bash
   git init -b main
   git add .
   git commit -m "UAPD crime log dashboard"
   git remote add origin https://github.com/YOUR-USERNAME/uapd-crime-log.git
   git push -u origin main
   ```
   GitHub Desktop works too. If you upload through the GitHub website instead, make sure the
   hidden `.github` folder comes along; macOS Finder hides it by default.
3. In the repository, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
4. Go to the **Actions** tab, open **Update UAPD log data**, and click **Run workflow** to test it.
   When it finishes, the dashboard is live at `https://YOUR-USERNAME.github.io/uapd-crime-log/`.

After that it runs on its own every day. Each run commits the updated data, so the
repository's history doubles as a record of when each entry appeared or changed.

### If something goes wrong

- **The commit step fails with a permissions error:** Settings → Actions → General →
  Workflow permissions → choose "Read and write permissions".
- **The schedule stops:** GitHub pauses scheduled workflows in repositories with no activity
  for 60 days. The daily data commits normally count as activity; if it ever pauses,
  re-enable the workflow from the Actions tab.
- **UAPD changes its website:** the scraper looks for the table's column IDs
  (e.g. `view-field-uapd-report-datetime-table-column`). If the run reports `0 rows`,
  the page layout changed and `parse_list_page` in `scrape.py` needs updating.

## How the daily update works

The log is sorted by **offense** date, not report date. A report filed today about an
incident from last month shows up several pages deep, not on page 1. So each run:

- **Daily:** re-reads the log back to offenses 120 days old (about 40–60 pages, 1 second
  apart), adds new entries and updates changed ones, then opens up to 300 individual case pages
  to collect *General Location* and *Date Cleared*, which only appear there.
- **Monthly (the 1st):** re-reads about 13 months to catch very late entries.
- **On demand:** Actions → Update UAPD log data → Run workflow, with custom arguments.

To add the whole archive back to 2015 (about 40,000 entries and an hour of scraping), run the
workflow with the arguments `--all --backfill --details-limit 0`. The dashboard's "All data"
option will then cover everything.

## Running it on your computer

```bash
python3 scraper/scrape.py --since-days 120
```

```bash
python3 -m http.server 8765 --directory docs
```

Then open http://localhost:8765. (The page has to be served; opening `index.html` directly won't
load the data.)

## The data: `docs/data/incidents.csv`

| Column | Meaning |
|---|---|
| `case_number` | UAPD case number; links to the case page via `url` |
| `report_datetime` | When it was reported, Arizona time (`YYYY-MM-DD HH:MM`) |
| `offense_datetime` | When it happened, if known. Midnight often means "time unknown" |
| `nature` | UAPD's "Nature of Crime" label, exactly as listed |
| `category` | This project's broad grouping of `nature` (see `scraper/categories.py`) |
| `address` | Street address as listed |
| `disposition` | UAPD's disposition, exactly as listed |
| `disposition_group` | Grouping: Closed, Arrest or citation, Referral or diversion, Open / pending, Unfounded |
| `general_location` | From the case page: On Campus, Public Property, etc. Blank until fetched |
| `date_cleared` | From the case page |
| `first_seen` | The day this project first saw the entry. Blank for entries loaded in the initial backfill |
| `last_changed` | The day any listed field last changed |
| `details_fetched` | The day the case page was last read |

Placeholder dates in the source (years like 1801, 1970 or 3313) are left blank.

## Caveats to keep in mind when reporting

- The log records **reports**, not proven crimes, and includes non-criminal entries
  (found property, collisions, assists to other agencies).
- UAPD changed its labeling format around July–August 2026. `categories.py` maps both
  formats into the same groups; check it before comparing categories across that line.
- An entry listing several offenses ("Drugs and Warrants") is counted once, under the first
  matching category.
- UAPD updates the log within two business days and may delay entries that could jeopardize
  an investigation, so the most recent days are always incomplete.
- If UAPD deletes an entry from its log, it stays in this dataset. The scraper doesn't detect
  removals yet.
- `first_seen` minus `report_datetime` measures how long an entry took to appear in the log,
  but only for entries added after the initial backfill.
