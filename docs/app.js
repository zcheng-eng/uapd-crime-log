(function () {
  "use strict";

  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const DOW_LONG = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
  const AP_MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
  const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ARREST = "Arrest or citation";
  const NOT_CHECKED = "Not yet checked";
  const PAGE_SIZE = 50;
  const SVGNS = "http://www.w3.org/2000/svg";

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => n.toLocaleString("en-US");

  let ROWS = [];
  let FIRST = 0; // first day the data fully covers
  let TODAY = 0;
  let hasLocations = false;
  let lastBase = [];
  let lastBounds = [0, 0];
  let sortKey = "report_datetime";
  let sortDir = -1;
  let shown = PAGE_SIZE;
  const DEFAULTS = { range: "365", from: "", to: "", cat: "", disp: "", loc: "", q: "" };
  const state = Object.assign({}, DEFAULTS);

  // ---------- Parsing & dates ----------

  function parseCSV(text) {
    const out = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); out.push(row); row = []; field = "";
      } else field += c;
    }
    if (field || row.length) { row.push(field); out.push(row); }
    const head = out.shift() || [];
    return out.filter((r) => r.length > 1).map((r) => {
      const o = {};
      head.forEach((h, j) => { o[h] = r[j] || ""; });
      return o;
    });
  }

  // Dates are handled as whole-day numbers (days since 1970-01-01) so no
  // browser time zone can shift them. All source times are Arizona time.
  function dayNum(s) {
    if (!s || s.length < 10) return null;
    const t = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
    return Number.isNaN(t) ? null : Math.round(t / 864e5);
  }
  const dayDate = (n) => new Date(n * 864e5);
  const isoDay = (n) => dayDate(n).toISOString().slice(0, 10);
  const dowOf = (n) => (((n + 3) % 7) + 7) % 7; // 0 = Monday; day 0 was a Thursday

  function apDate(n, withYear) {
    const d = dayDate(n);
    let s = AP_MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
    if (withYear !== false) s += ", " + d.getUTCFullYear();
    return s;
  }
  function apTime(hhmm) {
    let h = +hhmm.slice(0, 2);
    const m = hhmm.slice(3, 5);
    if (h === 0 && m === "00") return "midnight";
    if (h === 12 && m === "00") return "noon";
    const suffix = h < 12 ? "a.m." : "p.m.";
    h = h % 12 || 12;
    return m === "00" ? h + " " + suffix : h + ":" + m + " " + suffix;
  }
  function apDateTime(s) {
    const n = dayNum(s);
    if (n === null) return "";
    return apDate(n) + (s.length >= 16 ? ", " + apTime(s.slice(11, 16)) : "");
  }
  const hourTick = (h) => (h === 0 ? "12a" : h === 12 ? "12p" : h < 12 ? h + "a" : h - 12 + "p");
  function hourSpan(h) {
    const a = apTime(String(h).padStart(2, "0") + ":00");
    const b = apTime(String((h + 1) % 24).padStart(2, "0") + ":00");
    return a + " to " + b;
  }

  const SUFFIX = { AVENUE: "AVE", AV: "AVE", BOULEVARD: "BLVD", BL: "BLVD", STREET: "ST", DRIVE: "DR", ROAD: "RD", PLACE: "PL", LANE: "LN" };
  const KEEP_UPPER = new Set(["UA", "UAPD", "AZ", "UMC", "PSU"]);
  function addrKey(a) {
    const s = a.toUpperCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
    if (!s || /^UNK/.test(s) || s === "NO CASE" || s === "CASE PULLED IN ERROR") return "";
    return s.split(" ").map((w) => SUFFIX[w] || w).join(" ")
      // "E 1 ST" and "E 1ST ST" are the same street
      .replace(/\b([NSEW]) (\d+) (ST|AVE)\b/g, (m, dir, n, suffix) => dir + " " + ordinal(+n) + " " + suffix);
  }
  function ordinal(n) {
    const t = n % 100;
    return n + (t >= 11 && t <= 13 ? "TH" : ["TH", "ST", "ND", "RD"][n % 10] || "TH");
  }
  function titleCase(s) {
    return s.split(" ").map((w) => (KEEP_UPPER.has(w) ? w : w.charAt(0) + w.slice(1).toLowerCase())).join(" ");
  }

  // location_group is the scraper's grouping of UAPD's many spellings (see categories.py).
  function locationType(r) {
    if (!r.details_fetched) return NOT_CHECKED;
    return r.location_group || "Not listed";
  }

  function prep(r) {
    r.rday = dayNum(r.report_datetime);
    r.oday = dayNum(r.offense_datetime);
    // A few entries are reported years before the offense (a typo in the year); count those on the offense date.
    if (r.rday !== null && r.oday !== null && r.rday < r.oday - 1) r.rday = r.oday;
    r.otime = r.offense_datetime.length >= 16 ? r.offense_datetime.slice(11, 16) : "";
    r.akey = addrKey(r.address);
    r.loc = locationType(r);
    r.hay = [r.case_number, r.nature, r.category, r.address, r.akey, r.disposition, r.general_location]
      .join(" ").toLowerCase();
    return r;
  }

  // ---------- Filtering ----------

  function bounds() {
    if (state.range === "custom") {
      let a = dayNum(state.from), b = dayNum(state.to);
      if (a === null) a = FIRST;
      if (b === null) b = TODAY;
      return a <= b ? [a, b] : [b, a];
    }
    if (state.range === "all") return [FIRST, TODAY];
    return [Math.max(FIRST, TODAY - Number(state.range) + 1), TODAY];
  }

  function makeFilter(skip, lo, hi) {
    const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    return (r) => {
      if (r.rday === null || r.rday < lo || r.rday > hi) return false;
      if (skip !== "cat" && state.cat && r.category !== state.cat) return false;
      if (skip !== "disp" && state.disp && r.disposition_group !== state.disp) return false;
      if (skip !== "loc" && state.loc && r.loc !== state.loc) return false;
      for (const t of terms) if (!r.hay.includes(t)) return false;
      return true;
    };
  }

  function countBy(rows, key) {
    const m = new Map();
    for (const r of rows) m.set(r[key], (m.get(r[key]) || 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  }

  // ---------- Small DOM helpers ----------

  function div(cls, text) {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }
  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function td(text, cls) {
    const c = document.createElement("td");
    if (cls) c.className = cls;
    c.textContent = text;
    return c;
  }
  function simpleTable(head, rows) {
    const t = document.createElement("table");
    t.className = "data";
    const hr = t.createTHead().insertRow();
    head.forEach((h, i) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = h;
      if (i > 0) th.className = "num";
      hr.appendChild(th);
    });
    const tb = t.createTBody();
    rows.forEach((r) => {
      const tr = tb.insertRow();
      r.forEach((v, i) => tr.appendChild(td(typeof v === "number" ? fmt(v) : v, i > 0 ? "num" : "")));
    });
    return t;
  }

  // ---------- Tooltip ----------

  const tip = $("tooltip");
  function showTip(value, label, x, y) {
    tip.replaceChildren();
    const v = div("tv");
    v.appendChild(div("key"));
    v.appendChild(document.createTextNode(value));
    tip.append(v, div("tl", label));
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = x + 14, top = y - h - 10;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top < 8) top = y + 16;
    tip.style.left = Math.max(8, left) + "px";
    tip.style.top = top + "px";
  }
  const hideTip = () => { tip.hidden = true; };

  // ---------- Stat tiles ----------

  function renderStats(base, lo, hi) {
    const n = base.length;
    const days = hi - lo + 1;
    $("s-total").textContent = fmt(n);

    const delta = $("s-delta");
    const prevLo = lo - days;
    if (prevLo >= FIRST) {
      const prev = ROWS.filter(makeFilter(null, prevLo, lo - 1)).length;
      if (prev === 0) delta.textContent = "None in the previous " + fmt(days) + " days";
      else {
        const pct = Math.round(((n - prev) / prev) * 100);
        const word = pct > 0 ? "Up " + pct + "%" : pct < 0 ? "Down " + -pct + "%" : "No change";
        delta.textContent = word + " from the previous " + fmt(days) + " days (" + fmt(prev) + ")";
      }
    } else {
      delta.textContent = apDate(lo) + " to " + apDate(hi);
    }

    $("s-avg").textContent = (n / days).toFixed(1);
    $("s-avg-sub").textContent = "Over " + fmt(days) + " days";

    const arrests = base.filter((r) => r.disposition_group === ARREST).length;
    $("s-arrest").textContent = fmt(arrests);
    $("s-arrest-sub").textContent = n ? Math.round((arrests / n) * 100) + "% of reports" : "";

    const top = countBy(base, "category")[0];
    $("s-top").textContent = top ? top[0] : "None";
    $("s-top-sub").textContent = top ? fmt(top[1]) + " reports (" + Math.round((top[1] / n) * 100) + "%)" : "";
  }

  // ---------- Reports over time (columns) ----------

  function buckets(rows, lo, hi) {
    const daily = hi - lo + 1 <= 92;
    const start = daily ? lo : lo - dowOf(lo);
    const size = daily ? 1 : 7;
    const out = [];
    for (let s = start; s <= hi; s += size) {
      const a = Math.max(s, lo), b = Math.min(s + size - 1, hi);
      out.push({ a: a, b: b, n: 0, partial: !daily && b - a < 6 });
    }
    for (const r of rows) {
      const i = Math.floor((r.rday - start) / size);
      if (out[i]) out[i].n++;
    }
    return { list: out, daily: daily };
  }

  function niceStep(max, ticks) {
    const raw = max / ticks;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    return Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag);
  }
  const compact = (v) => (v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + "K" : String(v));

  function barPath(x, base, w, h) {
    if (h <= 0) return "";
    const r = Math.min(4, w / 2, h);
    const t = base - h;
    return "M" + x + "," + base + "V" + (t + r) + "A" + r + "," + r + " 0 0 1 " + (x + r) + "," + t +
      "H" + (x + w - r) + "A" + r + "," + r + " 0 0 1 " + (x + w) + "," + (t + r) + "V" + base + "Z";
  }

  function bucketLabel(b, daily) {
    if (daily) return DOW_LONG[dowOf(b.a)].slice(0, -1) + ", " + apDate(b.a);
    if (b.partial) return apDate(b.a, false) + " to " + apDate(b.b) + " (partial week)";
    return "Week of " + apDate(b.a);
  }

  function renderTime(rows, lo, hi) {
    const box = $("time-chart");
    const bk = buckets(rows, lo, hi);
    const list = bk.list, daily = bk.daily;
    $("time-note").textContent = daily
      ? "Reports per day, by date reported"
      : "Reports per week, by date reported. Weeks start Monday; lighter bars are partial weeks.";

    const W = Math.max(280, box.clientWidth || 600);
    const H = W < 520 ? 200 : 240;
    const m = { t: 10, r: 4, b: 26, l: 34 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const max = Math.max(1, ...list.map((b) => b.n));
    const step = niceStep(max, 4);
    const top = Math.ceil(max / step) * step;
    const y = (v) => m.t + ph - (v / top) * ph;
    const band = pw / list.length;
    const bw = Math.max(1, Math.min(24, band - 2));
    const base = m.t + ph;

    const svg = svgEl("svg", {
      viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", tabindex: "0",
      "aria-label": "Column chart of reports per " + (daily ? "day" : "week") +
        ". Use the left and right arrow keys to read each value, or open the table.",
    });
    const axis = svgEl("g", { class: "axis" }, svg);
    for (let v = 0; v <= top; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      svgEl("line", { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: v === 0 ? "baseline" : "gridline" }, svg);
      svgEl("text", { x: m.l - 6, y: yy + 4, "text-anchor": "end" }, axis).textContent = compact(v);
    }

    // X labels: Mondays for short ranges, month starts otherwise; skip any that would collide.
    let lastX = -Infinity;
    list.forEach((b, i) => {
      const d = dayDate(b.a);
      const short = daily && hi - lo < 36;
      const isFirstOfMonth = daily ? d.getUTCDate() === 1 : d.getUTCDate() <= 7 && (i > 0 || d.getUTCDate() === 1);
      if (!(short ? dowOf(b.a) === 0 : isFirstOfMonth)) return;
      const x = m.l + i * band + band / 2;
      if (x - lastX < 44) return;
      lastX = x;
      const mon = SHORT_MONTHS[d.getUTCMonth()];
      let text = daily ? mon + " " + d.getUTCDate() : mon;
      if (!daily && d.getUTCMonth() === 0) text += " " + d.getUTCFullYear();
      svgEl("text", { x: x, y: H - 8, "text-anchor": "middle" }, axis).textContent = text;
    });

    const bars = [], hits = [];
    list.forEach((b, i) => {
      const x = m.l + i * band;
      const hit = svgEl("rect", { x: x, y: m.t, width: band, height: ph, class: "hit" }, svg);
      const bar = svgEl("path", {
        d: barPath(x + (band - bw) / 2, base, bw, base - y(b.n)),
        class: "bar" + (b.partial ? " partial" : ""),
      }, svg);
      bars.push(bar); hits.push(hit);
      const on = (ev) => focusBar(i, ev);
      hit.addEventListener("pointerenter", on);
      hit.addEventListener("pointermove", on);
      hit.addEventListener("pointerleave", () => { clearOn(); hideTip(); });
    });

    let current = -1;
    function clearOn() {
      if (current >= 0) { bars[current].classList.remove("on"); hits[current].classList.remove("on"); }
      current = -1;
    }
    function focusBar(i, ev) {
      clearOn();
      current = i;
      bars[i].classList.add("on"); hits[i].classList.add("on");
      const b = list[i];
      let px, py;
      if (ev && ev.clientX !== undefined) { px = ev.clientX; py = ev.clientY; } else {
        const r = hits[i].getBoundingClientRect();
        px = r.left + r.width / 2;
        py = svg.getBoundingClientRect().top + (y(b.n) / H) * svg.getBoundingClientRect().height;
      }
      showTip(fmt(b.n) + (b.n === 1 ? " report" : " reports"), bucketLabel(b, daily), px, py);
    }
    svg.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowRight" && ev.key !== "ArrowLeft") return;
      ev.preventDefault();
      const next = current < 0 ? list.length - 1 : current + (ev.key === "ArrowRight" ? 1 : -1);
      focusBar(Math.max(0, Math.min(list.length - 1, next)));
    });
    svg.addEventListener("blur", () => { clearOn(); hideTip(); });

    box.replaceChildren(svg);
    $("time-table").replaceChildren(simpleTable(
      [daily ? "Day" : "Week", "Reports"],
      list.slice().reverse().map((b) => [bucketLabel(b, daily), b.n])
    ));
  }

  // ---------- Horizontal bar lists ----------

  function renderBars(container, counts, selected, onPick, emptyText) {
    container.replaceChildren();
    if (!counts.length) { container.appendChild(div("note", emptyText || "No reports match these filters.")); return; }
    const max = counts[0][1] || 1;
    for (const [name, n] of counts) {
      const row = document.createElement(onPick ? "button" : "div");
      row.className = "bar-row" + (onPick ? " clickable" : "") +
        (selected ? (name === selected ? " sel" : " dim") : "");
      if (onPick) {
        row.type = "button";
        row.setAttribute("aria-pressed", String(name === selected));
        row.addEventListener("click", () => onPick(name === selected ? "" : name));
      }
      const track = div("track");
      const fill = div("fill");
      fill.style.width = (n / max) * 100 + "%";
      track.appendChild(fill);
      row.append(div("name", name), track, div("n", fmt(n)));
      container.appendChild(row);
    }
  }

  // ---------- Heatmap: day of week x hour ----------

  function renderHeat(rows) {
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let used = 0, midnight = 0, missing = 0;
    for (const r of rows) {
      if (r.oday === null || !r.otime) { missing++; continue; }
      if (r.otime === "00:00") { midnight++; continue; }
      grid[dowOf(r.oday)][+r.otime.slice(0, 2)]++;
      used++;
    }
    const max = Math.max(1, ...grid.map((row) => Math.max(...row)));
    const wrap = div("heat");
    wrap.appendChild(div("hr", ""));
    for (let h = 0; h < 24; h++) wrap.appendChild(div("hr", h % 3 === 0 ? hourTick(h) : ""));
    for (let d = 0; d < 7; d++) {
      wrap.appendChild(div("dow", DOW[d]));
      for (let h = 0; h < 24; h++) {
        const v = grid[d][h];
        const cell = div("cell");
        cell.style.background = v
          ? "color-mix(in oklab, var(--seq-hi) " + Math.round(8 + (92 * v) / max) + "%, var(--surface-1))"
          : "var(--grid)";
        const label = DOW_LONG[d] + ", " + hourSpan(h);
        cell.setAttribute("aria-label", v + " incidents, " + label);
        cell.addEventListener("pointermove", (ev) =>
          showTip(fmt(v) + (v === 1 ? " incident" : " incidents"), label, ev.clientX, ev.clientY));
        cell.addEventListener("pointerleave", hideTip);
        wrap.appendChild(cell);
      }
    }
    const scale = div("scale");
    const ramp = div("ramp");
    scale.append(document.createTextNode("Fewer"), ramp, document.createTextNode("More (max " + fmt(max) + " in one hour slot)"));
    $("heatmap").replaceChildren(wrap, scale);

    const left = [];
    if (midnight) left.push(fmt(midnight) + " logged at exactly midnight");
    if (missing) left.push(fmt(missing) + " with no offense time");
    $("heat-note").textContent = "Based on " + fmt(used) + " reports." +
      (left.length ? " Not shown: " + left.join(" and ") + "." : "");

    const headers = ["Day"].concat(Array.from({ length: 24 }, (_, h) => hourTick(h)));
    $("heat-table").replaceChildren(simpleTable(headers, grid.map((row, d) => [DOW[d]].concat(row))));
  }

  // ---------- Address table ----------

  function renderAddresses(rows) {
    const groups = new Map();
    for (const r of rows) {
      if (!r.akey) continue;
      let g = groups.get(r.akey);
      if (!g) { g = { n: 0, cats: new Map() }; groups.set(r.akey, g); }
      g.n++;
      g.cats.set(r.category, (g.cats.get(r.category) || 0) + 1);
    }
    const top = Array.from(groups.entries()).sort((a, b) => b[1].n - a[1].n).slice(0, 12);
    const tbody = $("addr-table").tBodies[0];
    tbody.replaceChildren();
    for (const [key, g] of top) {
      const tr = tbody.insertRow();
      const cell = document.createElement("td");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = titleCase(key);
      btn.addEventListener("click", () => {
        state.q = titleCase(key);
        $("f-q").value = state.q;
        update();
      });
      cell.appendChild(btn);
      const cat = Array.from(g.cats.entries()).sort((a, b) => b[1] - a[1])[0];
      tr.append(cell, td(fmt(g.n), "num"), td(cat[0] + " (" + fmt(cat[1]) + ")", "muted"));
    }
    if (!top.length) {
      const tr = tbody.insertRow();
      const c = td("No addresses match these filters.", "muted");
      c.colSpan = 3;
      tr.appendChild(c);
    }
  }

  // ---------- Incident list ----------

  function renderList(rows) {
    const sorted = rows.slice().sort((a, b) => {
      const x = a[sortKey] || "", y = b[sortKey] || "";
      return x < y ? -sortDir : x > y ? sortDir : 0;
    });
    const tbody = $("list-table").tBodies[0];
    tbody.replaceChildren();
    for (const r of sorted.slice(0, shown)) {
      const tr = tbody.insertRow();
      const when = td(apDateTime(r.report_datetime), "when");
      if (r.offense_datetime) when.title = "Offense: " + apDateTime(r.offense_datetime);
      const caseCell = document.createElement("td");
      if (r.url) {
        const a = document.createElement("a");
        a.href = r.url;
        a.textContent = r.case_number;
        a.rel = "noopener";
        caseCell.appendChild(a);
      } else caseCell.textContent = r.case_number;
      tr.append(when, caseCell, td(r.nature), td(r.category, "muted"), td(r.address),
        td(r.disposition), td(r.general_location, "muted"));
    }
    $("list-note").textContent = fmt(rows.length) + (rows.length === 1 ? " report" : " reports") +
      (rows.length > shown ? ", showing the first " + fmt(Math.min(shown, rows.length)) : "") +
      ". Click a column to sort.";
    const more = $("more");
    more.hidden = rows.length <= shown;
    more.textContent = "Show " + fmt(Math.min(PAGE_SIZE, rows.length - shown)) + " more";
    document.querySelectorAll("#list-table th button").forEach((b) => {
      if (b.dataset.sort === sortKey) b.setAttribute("aria-sort", sortDir > 0 ? "ascending" : "descending");
      else b.removeAttribute("aria-sort");
    });
  }

  // ---------- Controls & state ----------

  function fillSelect(sel, values, allLabel) {
    sel.replaceChildren();
    const all = document.createElement("option");
    all.value = "";
    all.textContent = allLabel;
    sel.appendChild(all);
    for (const v of values) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    }
  }

  function syncControls() {
    $("f-range").value = state.range;
    $("custom-range").hidden = state.range !== "custom";
    $("f-from").value = state.from || (state.range === "custom" ? isoDay(bounds()[0]) : "");
    $("f-to").value = state.to || (state.range === "custom" ? isoDay(bounds()[1]) : "");
    $("f-cat").value = state.cat;
    $("f-disp").value = state.disp;
    $("f-loc").value = state.loc;
    $("f-q").value = state.q;
  }

  function readHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    for (const k in DEFAULTS) if (p.has(k)) state[k] = p.get(k);
  }
  function writeHash() {
    const p = new URLSearchParams();
    for (const k in DEFAULTS) if (state[k] && state[k] !== DEFAULTS[k]) p.set(k, state[k]);
    const h = p.toString();
    history.replaceState(null, "", h ? "#" + h : location.pathname + location.search);
  }

  function update() {
    shown = PAGE_SIZE;
    render();
  }

  function render() {
    const [lo, hi] = bounds();
    lastBounds = [lo, hi];
    const base = ROWS.filter(makeFilter(null, lo, hi));
    lastBase = base;
    renderStats(base, lo, hi);
    renderTime(base, lo, hi);
    renderBars($("cat-bars"), countBy(ROWS.filter(makeFilter("cat", lo, hi)), "category"), state.cat,
      (v) => { state.cat = v; syncControls(); update(); });
    renderBars($("disp-bars"), countBy(ROWS.filter(makeFilter("disp", lo, hi)), "disposition_group"), state.disp,
      (v) => { state.disp = v; syncControls(); update(); });
    if (hasLocations) {
      const locRows = ROWS.filter(makeFilter("loc", lo, hi));
      renderBars($("loc-bars"), countBy(locRows, "loc"), state.loc,
        (v) => { state.loc = v; syncControls(); update(); });
      const unchecked = locRows.filter((r) => r.loc === NOT_CHECKED).length;
      $("loc-note").textContent = unchecked
        ? fmt(unchecked) + " of these reports have not had their case page checked yet; they fill in over the next few daily runs."
        : "";
    }
    renderHeat(base);
    renderAddresses(base);
    renderList(base);
    writeHash();
  }

  function wire() {
    $("f-range").addEventListener("change", (e) => {
      state.range = e.target.value;
      if (state.range !== "custom") { state.from = ""; state.to = ""; }
      syncControls();
      update();
    });
    $("f-from").addEventListener("change", (e) => { state.from = e.target.value; update(); });
    $("f-to").addEventListener("change", (e) => { state.to = e.target.value; update(); });
    $("f-cat").addEventListener("change", (e) => { state.cat = e.target.value; update(); });
    $("f-disp").addEventListener("change", (e) => { state.disp = e.target.value; update(); });
    $("f-loc").addEventListener("change", (e) => { state.loc = e.target.value; update(); });
    let timer = 0;
    $("f-q").addEventListener("input", (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.q = e.target.value.trim(); update(); }, 180);
    });
    $("reset").addEventListener("click", () => {
      Object.assign(state, DEFAULTS);
      syncControls();
      update();
    });
    $("more").addEventListener("click", () => { shown += PAGE_SIZE; renderList(lastBase); });
    document.querySelectorAll("#list-table th button").forEach((b) => {
      b.addEventListener("click", () => {
        if (sortKey === b.dataset.sort) sortDir = -sortDir;
        else { sortKey = b.dataset.sort; sortDir = sortKey === "report_datetime" ? -1 : 1; }
        renderList(lastBase);
      });
    });
    document.querySelectorAll("[data-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.toggle;
        const chart = $(id === "time" ? "time-chart" : "heatmap");
        const table = $(id + "-table");
        const showTable = table.hidden;
        table.hidden = !showTable;
        chart.hidden = showTable;
        btn.textContent = showTable ? "Show chart" : "Show table";
      });
    });
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => renderTime(lastBase, lastBounds[0], lastBounds[1]), 120);
    });
    window.addEventListener("scroll", hideTip, { passive: true });
    // A shared link pasted into an open tab only changes the hash.
    window.addEventListener("hashchange", () => {
      Object.assign(state, DEFAULTS);
      readHash();
      syncControls();
      update();
    });
  }

  async function load() {
    try {
      const [csvText, meta] = await Promise.all([
        fetch("data/incidents.csv", { cache: "no-cache" }).then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.text();
        }),
        fetch("data/meta.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      ]);
      ROWS = parseCSV(csvText).map(prep);
      const days = ROWS.map((r) => r.rday).filter((d) => d !== null);
      const latest = days.reduce((a, b) => Math.max(a, b), -Infinity);
      TODAY = dayNum(meta.last_run) !== null ? dayNum(meta.last_run) : latest;
      FIRST = dayNum(meta.coverage_start) !== null
        ? dayNum(meta.coverage_start)
        : days.reduce((a, b) => Math.min(a, b), Infinity);
      $("updated").textContent = meta.last_run ? apDateTime(meta.last_run) : "date unknown";

      fillSelect($("f-cat"), countBy(ROWS, "category").map((c) => c[0]), "All categories");
      fillSelect($("f-disp"), countBy(ROWS, "disposition_group").map((c) => c[0]), "All outcomes");
      hasLocations = ROWS.some((r) => r.general_location);
      fillSelect($("f-loc"), countBy(ROWS, "loc").map((c) => c[0]), "All locations");
      $("loc-field").hidden = !hasLocations;
      $("loc-block").hidden = !hasLocations;
      $("f-from").min = $("f-to").min = isoDay(FIRST);
      $("f-from").max = $("f-to").max = isoDay(TODAY);

      readHash();
      syncControls();
      wire();
      $("status").textContent = "";
      $("main").hidden = false;
      render();
    } catch (err) {
      $("status").textContent = "Could not load the data (" + err.message + ")." +
        (location.protocol === "file:" ? " Open this page through a local web server; see the README." : "");
    }
  }

  load();
})();
