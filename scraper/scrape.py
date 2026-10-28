#!/usr/bin/env python3
"""Scrape the UAPD Daily Crime and Safety Log into docs/data/incidents.csv.

The log is a Drupal table, 20 rows per page, sorted by offense date with the
newest first. A late report about an old offense lands deep in the list, so
each run re-reads pages until every row on a page is older than a cutoff,
then merges what it found into the CSV by case number. Rows that changed
(usually the disposition) are updated and logged to changes.csv.

Usage:
  python scraper/scrape.py --since-days 120            # daily run
  python scraper/scrape.py --since-days 400 --backfill # first run, ~12 months
  python scraper/scrape.py --all --backfill            # whole archive (~1 hr)

Standard library only, so the GitHub Action needs no pip install.
"""
import argparse
import csv
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from categories import categorize, disposition_group  # noqa: E402

BASE = "https://uapd.arizona.edu"
LIST_URL = BASE + "/public-information/uapd-daily-activity-log"
USER_AGENT = "Mozilla/5.0 (compatible; uapd-log-dashboard/0.1; public-records data project)"
AZ = timezone(timedelta(hours=-7))  # Arizona does not observe daylight saving time

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"
CSV_PATH = DATA_DIR / "incidents.csv"
CHANGES_PATH = DATA_DIR / "changes.csv"
META_PATH = DATA_DIR / "meta.json"

# Columns read from the list table; a change in any of them counts as an update.
LIST_FIELDS = ["case_number", "report_datetime", "offense_datetime", "nature", "address", "disposition"]
# Columns only on each case's own page.
DETAIL_FIELDS = ["general_location", "date_cleared"]
FIELDS = (LIST_FIELDS[:3] + ["nature", "category", "address", "disposition", "disposition_group"]
          + DETAIL_FIELDS + ["url", "first_seen", "last_changed", "details_fetched"])

TABLE_COLUMNS = {
    "title": "case_number",
    "field-uapd-report-datetime": "report_datetime",
    "field-uapd-offense-datetime": "offense_datetime",
    "field-uapd-crime-code-def": "nature",
    "field-uapd-street-address": "address",
    "field-uapd-clearance-code-def": "disposition",
}

ROW_RE = re.compile(r"<tr>(.*?)</tr>", re.S)
CELL_RE = re.compile(r'<td[^>]*headers="view-(.+?)-table-column"[^>]*>(.*?)</td>', re.S)
TIME_RE = re.compile(r'<time datetime="([^"]+)"')
HREF_RE = re.compile(r'<a href="([^"]+)"')
LAST_PAGE_RE = re.compile(r'href="\?page=(\d+)"[^>]*title="Go to last page"')
NORMAL_CASE_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]*$")


def fetch(url, tries=4):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=40) as resp:
                return resp.read().decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            if attempt == tries - 1:
                raise
            wait = 10 * (attempt + 1)
            print(f"  fetch failed ({err}); retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)


def clean_text(fragment):
    text = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def to_local(iso_utc):
    """'2026-10-27T03:23:00Z' -> '2026-10-26 20:23' Arizona time.

    The log has placeholder dates (1801, 1970, 3313); those become ''.
    """
    try:
        dt = datetime.strptime(iso_utc, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return ""
    local = dt.astimezone(AZ)
    if not 2000 <= local.year <= datetime.now(AZ).year + 1:
        return ""
    return local.strftime("%Y-%m-%d %H:%M")


def parse_list_page(page_html):
    body = page_html[page_html.find("<tbody>"):page_html.find("</tbody>")]
    rows = []
    for tr in ROW_RE.findall(body):
        row = {}
        for header, cell in CELL_RE.findall(tr):
            col = TABLE_COLUMNS.get(header)
            if not col:
                continue
            stamp = TIME_RE.search(cell)
            if col.endswith("_datetime"):
                row[col] = to_local(stamp.group(1)) if stamp else ""
            else:
                row[col] = clean_text(cell)
            if col == "case_number":
                link = HREF_RE.search(cell)
                row["url"] = BASE + html.unescape(link.group(1)) if link else ""
        if row.get("case_number") or row.get("nature"):
            rows.append(row)
    return rows


def last_page_index(page_html):
    m = LAST_PAGE_RE.search(page_html)
    return int(m.group(1)) if m else 0


def row_key(row):
    # Most case numbers are unique IDs. A few are junk ("UNKNOWN", a timestamp),
    # so those get a composite key to avoid collapsing different incidents.
    case = row.get("case_number", "")
    if NORMAL_CASE_RE.match(case) and case != "UNKNOWN":
        return case
    return "|".join([case, row.get("report_datetime", ""), row.get("nature", ""), row.get("address", "")])


def sort_date(row):
    return row.get("offense_datetime") or row.get("report_datetime") or ""


def scan_list(cutoff, scan_all, max_pages, delay):
    found = {}
    first = fetch(LIST_URL)
    last = last_page_index(first)
    print(f"Log has {last + 1} pages")
    page, page_html, old_pages = 0, first, 0
    while True:
        rows = parse_list_page(page_html)
        if not rows:
            break
        for row in rows:
            found[row_key(row)] = row
        dated = [sort_date(r) for r in rows if sort_date(r)]
        if not scan_all and dated and all(d[:10] < cutoff for d in dated):
            old_pages += 1
        else:
            old_pages = 0
        if page % 10 == 0:
            print(f"  page {page}: {len(found)} rows, oldest on page {min(dated) if dated else 'n/a'}")
        # Two whole pages past the cutoff means we are clear of the window.
        if old_pages >= 2 or page >= last or page + 1 >= max_pages:
            break
        page += 1
        time.sleep(delay)
        page_html = fetch(f"{LIST_URL}?page={page}")
    print(f"Scanned {page + 1} pages, {len(found)} rows")
    return found, page + 1


DETAIL_RE = {
    "general_location": re.compile(r'field--name-field-uapd-premise-code-def[^>]*>(.*?)</div>', re.S),
    "date_cleared": re.compile(r'field--name-field-uapd-date-cleared[^>]*>(.*?)</div>', re.S),
}


def parse_detail_page(page_html):
    out = {}
    for field, pattern in DETAIL_RE.items():
        m = pattern.search(page_html)
        value = clean_text(m.group(1)) if m else ""
        if field == "date_cleared" and value:
            stamp = TIME_RE.search(m.group(1))
            if stamp:
                value = to_local(stamp.group(1))[:10]
            else:
                try:
                    value = datetime.strptime(value, "%A, %B %d, %Y").strftime("%Y-%m-%d")
                except ValueError:
                    pass
        out[field] = value
    return out


def load_csv(path):
    if not path.exists():
        return {}
    with path.open(newline="", encoding="utf-8") as f:
        return {row_key(r): r for r in csv.DictReader(f)}


def merge(existing, scraped, today, backfill):
    """Fold scraped rows into existing ones. Returns (new_count, change records)."""
    new_count, changes = 0, []
    for key, row in scraped.items():
        old = existing.get(key)
        if old is None:
            row.update({f: "" for f in DETAIL_FIELDS + ["details_fetched"]})
            # In a backfill we don't know when a row was first posted, so leave it blank.
            row["first_seen"] = "" if backfill else today
            row["last_changed"] = row["first_seen"]
            existing[key] = row
            new_count += 1
            continue
        diffs = [f for f in LIST_FIELDS if old.get(f, "") != row.get(f, "")]
        if diffs:
            for f in diffs:
                changes.append({"date": today, "case_number": row["case_number"], "field": f,
                                "old": old.get(f, ""), "new": row.get(f, "")})
            old.update({f: row.get(f, "") for f in LIST_FIELDS})
            old["last_changed"] = today
            old["details_fetched"] = ""  # date cleared may have changed too
        old["url"] = row.get("url") or old.get("url", "")
    # Re-derive the groups for every row, so edits to categories.py apply to old rows too.
    for row in existing.values():
        row["category"] = categorize(row.get("nature", ""))
        row["disposition_group"] = disposition_group(row.get("disposition", ""))
    return new_count, changes


def fill_details(rows, limit, delay, today, since=""):
    todo = [r for r in rows.values()
            if not r.get("details_fetched") and r.get("url") and sort_date(r)[:10] >= since]
    todo.sort(key=sort_date, reverse=True)
    todo = todo[:limit]
    if todo:
        print(f"Fetching {len(todo)} case pages for location and date cleared")
    for i, row in enumerate(todo):
        try:
            row.update(parse_detail_page(fetch(row["url"])))
            row["details_fetched"] = today
        except urllib.error.HTTPError as err:
            print(f"  {row['case_number']}: HTTP {err.code}", file=sys.stderr)
        if i and i % 100 == 0:
            print(f"  {i} of {len(todo)} done")
        time.sleep(delay)
    return len(todo)


def write_outputs(rows, changes, meta):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ordered = sorted(rows.values(), key=lambda r: (r.get("report_datetime") or "", r.get("case_number", "")),
                     reverse=True)
    tmp = CSV_PATH.with_suffix(".tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(ordered)
    tmp.replace(CSV_PATH)
    if changes:
        new_file = not CHANGES_PATH.exists()
        with CHANGES_PATH.open("a", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["date", "case_number", "field", "old", "new"])
            if new_file:
                writer.writeheader()
            writer.writerows(changes)
    META_PATH.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since-days", type=int, default=120,
                    help="re-read pages until offense dates are this many days old (default 120)")
    ap.add_argument("--all", action="store_true", help="read every page of the log")
    ap.add_argument("--max-pages", type=int, default=5000)
    ap.add_argument("--backfill", action="store_true",
                    help="leave first_seen blank for new rows (their posting date is unknown)")
    ap.add_argument("--details-limit", type=int, default=150,
                    help="max case pages to fetch this run for location/date cleared (0 to skip)")
    ap.add_argument("--details-since-days", type=int, default=400,
                    help="only fetch case pages for offenses within this many days")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    args = ap.parse_args()

    now = datetime.now(AZ)
    today = now.strftime("%Y-%m-%d")
    cutoff = (now - timedelta(days=args.since_days)).strftime("%Y-%m-%d")
    print(f"Reading log back to offense date {cutoff}" if not args.all else "Reading the whole log")

    rows = load_csv(CSV_PATH)
    prev_meta = json.loads(META_PATH.read_text(encoding="utf-8")) if META_PATH.exists() else {}
    scraped, pages = scan_list(cutoff, args.all, args.max_pages, args.delay)
    new_count, changes = merge(rows, scraped, today, args.backfill)
    print(f"{new_count} new rows, {len(changes)} field changes")

    details_since = (now - timedelta(days=args.details_since_days)).strftime("%Y-%m-%d")
    detail_count = fill_details(rows, args.details_limit, args.delay, today, details_since) \
        if args.details_limit else 0

    # The earliest date the CSV fully covers: every run reads back to its cutoff,
    # so coverage starts at the oldest cutoff any run has used.
    dated = [sort_date(r)[:10] for r in rows.values() if sort_date(r)]
    starts = [d for d in [prev_meta.get("coverage_start"), min(dated) if args.all and dated else cutoff] if d]
    meta = {
        "source": LIST_URL,
        "last_run": now.strftime("%Y-%m-%d %H:%M"),
        "coverage_start": min(starts),
        "timezone": "America/Phoenix",
        "rows": len(rows),
        "pages_scanned": pages,
        "new_rows": new_count,
        "changed_fields": len(changes),
        "case_pages_fetched": detail_count,
        "details_missing": sum(1 for r in rows.values() if not r.get("details_fetched")),
    }
    write_outputs(rows, changes, meta)
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
