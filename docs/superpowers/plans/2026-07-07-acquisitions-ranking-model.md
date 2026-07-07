# Acquisitions Ranking Model Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Acquisitions option to the dashboard's Forward Model tab — a generated `acquisitions-model.html` page (built from the Acquisition Screener Excel) behind a Development/Acquisitions toggle — and fix the `brandForwardModel()` selector bug.

**Architecture:** A new builder script reads the `Forward Looking Model` sheet of `Acquisition Screener - 2024.xlsx` and regenerates `acquisitions-model.html`, using the existing `forward-model.html` as its design template at build time (swap the two `<tbody>` blocks, title/h1, and footer source lines — CSS/JS/callouts carry over untouched). `index.html` gets a two-button pill toggle inside `#forward-view` that shows/hides two iframes; `dashboard.js` gets the toggle handler and the brand-CSS injection fix.

**Tech Stack:** Python 3 + openpyxl (builder); vanilla HTML/CSS/JS (dashboard). No test framework exists in this repo (static site + standalone scripts), so each task carries explicit run-and-verify steps with expected output instead of unit tests — the builder itself fail-louds on any template or workbook drift.

**Spec:** `docs/superpowers/specs/2026-07-07-acquisitions-ranking-model-design.md`

**Repo:** `C:\Users\JackBranding\OneDrive - Subtext\Desktop\Subhouse Branches\Market-Data-Dashboard-Version-1`, branch `feature/acquisitions-ranking-model`. All commands below run from the repo root.

---

## Chunk 1: Builder and generated page

### Task 1: Builder script `build_acquisitions_model.py`

**Files:**
- Create: `build_acquisitions_model.py`
- Reads: `forward-model.html` (template), `..\Aquisitions Ranking Model\Acquisition Screener - 2024.xlsx` (data)
- Writes: `acquisitions-model.html`

**Formatting contract** (mirrors `forward-model.html` exactly — verified against its generated markup):

| Field | Format | Example |
|---|---|---|
| FT Enrollment | comma int, no class | `<td>25,037</td>` |
| TTM Prelease / 3yr App Growth / POSH Occ LY / OoS Growth | int %, tercile class | `<td class="metric-lo">61%</td>` |
| PBSH Occ / 3yr Bed-Enroll Δ / TTM Prelease Δ | 1-dp %, tercile class | `<td class="metric-hi">96.2%</td>` |
| Rank badges | `<span class="rank rank-forward">1</span>` / `rank-current` | |
| Change | `change-up` `+4` / `change-down` `-4` / `change-flat` `0` | |
| Strongest/Weakest | `<span class="tag tag-strong">TTM Prelease</span>` / `tag-weak`; Excel names mapped to short labels | |
| Weighting scores | 2 dp; `w-pos` / `w-neg`; `w-zero` when abs(round(v,2)) < 0.005 (text keeps sign: `-0.00`) | |
| Counts | plain int | `<td>21</td>` |
| Power 4 / R1 | `<span class="flag-yes">✓</span>` when 1 else `<span class="flag-no">–</span>` | |
| Rent/Price | 1-dp % | `<td>12.3%</td>` |
| New Property Rent | `$` comma int | `<td>$1,766</td>` |
| Any blank/error cell | `<td>-</td>` (no class); excluded from terciles | |
| Market names | `" - "` replaced with `" – "` (en dash), HTML-escaped | |

Tercile rule: per metric column over non-blank values; sorted ascending, `lo_cut = nums[n//3]`, `hi_cut = nums[(2*n)//3]`; `v < lo_cut` → `metric-lo`, `v >= hi_cut` → `metric-hi`, else `metric-mid`. The builder emits raw terciles; the page's existing runtime script inverts the 3yr Bed/Enroll Δ column — do NOT pre-invert.

- [ ] **Step 1: Create `build_acquisitions_model.py` with this exact content**

```python
#!/usr/bin/env python3
"""Build acquisitions-model.html from the Acquisition Screener Excel.

Reads the 'Forward Looking Model' sheet and regenerates the Acquisitions
page for the dashboard's Forward Model tab. forward-model.html is used as
the design template at build time: its two <tbody> blocks, <title>, <h1>,
and footer source lines are swapped out; all CSS / JS / callout content
carries over untouched so the two pages never drift apart visually.

Spec: docs/superpowers/specs/2026-07-07-acquisitions-ranking-model-design.md

Usage:
    python build_acquisitions_model.py [--xlsx PATH]
"""

import argparse
import datetime
import html
import re
import sys
import warnings
from pathlib import Path

import openpyxl

REPO = Path(__file__).resolve().parent
DEFAULT_XLSX = (REPO.parent / "Aquisitions Ranking Model"
                / "Acquisition Screener - 2024.xlsx")
TEMPLATE = REPO / "forward-model.html"
OUTPUT = REPO / "acquisitions-model.html"
SHEET = "Forward Looking Model"

PAGE_TITLE = "Forward Looking Model - Acquisition Screener 2024"
PAGE_H1 = "Forward Looking Model - Acquisition Screener"
SOURCE_NAME = "Acquisition Screener &ndash; 2024.xlsx"

# 1-based column index -> exact expected header (row 1)
EXPECTED_HEADERS = {
    1: "Current Year Ranking", 2: "Forward Looking Ranking", 3: "Change",
    4: "Market", 5: "Full Time Enrollment", 6: "TTM Prelease",
    7: "PBSH Occupancy", 8: "3 Year Change In Student Bed To Enrollment Ratio",
    9: "TTM Prelease Change", 10: "Three Year Change In Applications",
    11: "POSH Occupancy Last Year", 12: "Growth In FT OoS Undergrads",
    13: "Strongest Variable", 14: "Weakest Variable",
    17: "TTM Prelease", 18: "PBSH Occupancy",
    19: "3 Year Change In Student Bed To Enrollment Ratio",
    20: "TTM Prelease Change", 21: "Three Year Change In Applications",
    22: "POSH Occupancy Last Year", 23: "Growth In FT OoS Undergrads",
    24: "Transactions Last 5", 25: "Transactions Previous 5",
    26: "Construction Last 5", 27: "Construction Previous 5",
    28: "Power 4", 29: "R1", 30: "Rent/Price",
    31: "Current New Property Rent",
}

# Excel variable names (cols M/N) -> short labels used by the tag badges,
# matching the labels the development page uses.
VARIABLE_LABELS = {
    "TTM Prelease": "TTM Prelease",
    "PBSH Occupancy": "PBSH Occ.",
    "3 Year Change In Student Bed To Enrollment Ratio": "3yr Bed/Enroll Δ",
    "TTM Prelease Change": "TTM Prelease Δ",
    "Three Year Change In Applications": "3yr App. Growth",
    "POSH Occupancy Last Year": "POSH Occ. LY",
    "Growth In FT OoS Undergrads": "FT OoS UG Growth",
}


def die(msg):
    sys.exit(f"build_acquisitions_model: ERROR: {msg}")


def is_bad(v):
    """Blank cell or an Excel error string such as #N/A."""
    if v is None:
        return True
    s = str(v).strip()
    return s == "" or s.startswith("#")


def num(v):
    """Cell as float, or None when blank / error / non-numeric."""
    if is_bad(v):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def load_rows(xlsx_path):
    if not xlsx_path.is_file():
        die(f"workbook not found: {xlsx_path}")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    if SHEET not in wb.sheetnames:
        die(f"sheet {SHEET!r} not found; sheets: {wb.sheetnames}")
    ws = wb[SHEET]

    rows_iter = ws.iter_rows(values_only=True)
    header = next(rows_iter, None)
    if header is None:
        die("sheet is empty")
    for idx, expected in EXPECTED_HEADERS.items():
        got = header[idx - 1] if len(header) >= idx else None
        if got != expected:
            die(f"header mismatch in column {idx}: "
                f"expected {expected!r}, got {got!r}")

    kept, dropped = [], 0
    for row in rows_iter:
        row = (tuple(row) + (None,) * 31)[:31]
        market, fwd_rank = row[3], num(row[1])
        if is_bad(market) or fwd_rank is None:
            if any(not is_bad(v) for v in row):
                dropped += 1
            continue
        kept.append(row)
    if not kept:
        die("no valid data rows after filtering")
    kept.sort(key=lambda r: num(r[1]))
    return kept, dropped


# ---------------------------------------------------------------- formatting

def fmt_int(v):
    return "-" if v is None else f"{v:,.0f}"


def fmt_pct0(v):
    return "-" if v is None else f"{v * 100:.0f}%"


def fmt_pct1(v):
    return "-" if v is None else f"{v * 100:.1f}%"


def fmt_score(v):
    return "-" if v is None else f"{v:.2f}"


def fmt_money(v):
    return "-" if v is None else f"${v:,.0f}"


def market_name(v):
    return html.escape(str(v).strip()).replace(" - ", " – ")


def rank_badge(v, kind):
    if v is None:
        return "<td>-</td>"
    return f'<td><span class="rank rank-{kind}">{v:.0f}</span></td>'


def change_badge(v):
    if v is None:
        return "<td>-</td>"
    n = int(round(v))
    if n > 0:
        return f'<td><span class="change change-up">+{n}</span></td>'
    if n < 0:
        return f'<td><span class="change change-down">{n}</span></td>'
    return '<td><span class="change change-flat">0</span></td>'


def variable_tag(v, kind):
    if is_bad(v):
        return "<td>-</td>"
    label = VARIABLE_LABELS.get(str(v).strip(), html.escape(str(v).strip()))
    return f'<td><span class="tag tag-{kind}">{label}</span></td>'


def metric_td(text, cls):
    return f'<td class="{cls}">{text}</td>' if cls else f"<td>{text}</td>"


def score_td(v):
    if v is None:
        return "<td>-</td>"
    cls = "w-zero" if abs(round(v, 2)) < 0.005 else ("w-pos" if v > 0 else "w-neg")
    return f'<td class="{cls}">{fmt_score(v)}</td>'


def flag_td(v):
    yes = num(v) == 1
    return ('<td><span class="flag-yes">✓</span></td>' if yes
            else '<td><span class="flag-no">–</span></td>')


def make_tercile(values):
    """classify(v) -> metric-lo / metric-mid / metric-hi within one column."""
    nums = sorted(v for v in values if v is not None)
    n = len(nums)
    if n == 0:
        return lambda v: None
    lo_cut, hi_cut = nums[n // 3], nums[(2 * n) // 3]

    def classify(v):
        if v is None:
            return None
        if v < lo_cut:
            return "metric-lo"
        if v >= hi_cut:
            return "metric-hi"
        return "metric-mid"

    return classify


# ------------------------------------------------------------- row rendering

# (column index in row tuple, percent formatter) for the 7 metric columns F-L
METRICS = [(5, fmt_pct0), (6, fmt_pct1), (7, fmt_pct1), (8, fmt_pct1),
           (9, fmt_pct0), (10, fmt_pct0), (11, fmt_pct0)]


def render_values_rows(rows):
    classifiers = {i: make_tercile([num(r[i]) for r in rows]) for i, _ in METRICS}
    out = []
    for r in rows:
        tds = [
            rank_badge(num(r[1]), "forward"),
            rank_badge(num(r[0]), "current"),
            change_badge(num(r[2])),
            f'<td class="left">{market_name(r[3])}</td>',
            f"<td>{fmt_int(num(r[4]))}</td>",
        ]
        for i, fmt in METRICS:
            v = num(r[i])
            tds.append(metric_td(fmt(v), classifiers[i](v)))
        tds.append(variable_tag(r[12], "strong"))
        tds.append(variable_tag(r[13], "weak"))
        out.append("    <tr>" + "".join(tds) + "</tr>")
    return "\n".join(out)


def render_weightings_rows(rows):
    out = []
    for r in rows:
        tds = [
            rank_badge(num(r[1]), "forward"),
            f'<td class="left">{market_name(r[3])}</td>',
        ]
        for i in range(16, 23):                    # Q-W: 7 weighted scores
            tds.append(score_td(num(r[i])))
        for i in range(23, 27):                    # X-AA: 4 counts
            tds.append(f"<td>{fmt_int(num(r[i]))}</td>")
        tds.append(flag_td(r[27]))                 # AB: Power 4
        tds.append(flag_td(r[28]))                 # AC: R1
        tds.append(f"<td>{fmt_pct1(num(r[29]))}</td>")    # AD: Rent/Price
        tds.append(f"<td>{fmt_money(num(r[30]))}</td>")   # AE: New Prop Rent
        out.append("    <tr>" + "".join(tds) + "</tr>")
    return "\n".join(out)


# ------------------------------------------------------------ template swap

def replace_tbody(page, panel_id, rows_html):
    anchor = page.find(f'<div id="{panel_id}"')
    if anchor < 0:
        die(f"template anchor not found: {panel_id}")
    start = page.find("<tbody>", anchor)
    end = page.find("</tbody>", start)
    if start < 0 or end < 0:
        die(f"tbody not found inside {panel_id}")
    return page[:start] + "<tbody>\n" + rows_html + "\n  " + page[end:]


def replace_once(page, pattern, repl, what):
    new, n = re.subn(pattern, repl, page, count=1, flags=re.S)
    if n != 1:
        die(f"template anchor not found: {what}")
    return new


def build(xlsx_path):
    if not TEMPLATE.is_file():
        die(f"template not found: {TEMPLATE}")
    page = TEMPLATE.read_text(encoding="utf-8")
    rows, dropped = load_rows(xlsx_path)

    page = replace_once(page, r"<title>.*?</title>",
                        f"<title>{PAGE_TITLE}</title>", "<title>")
    page = replace_once(page, r"<h1>.*?</h1>",
                        f"<h1>{PAGE_H1}</h1>", "<h1>")
    page = replace_tbody(page, "tab-values", render_values_rows(rows))
    page = replace_tbody(page, "tab-weightings", render_weightings_rows(rows))

    n = page.count("Source: Screener &ndash; 2024.xlsx")
    if n != 2:
        die(f"expected 2 footer source lines, found {n}")
    page = page.replace("Source: Screener &ndash; 2024.xlsx",
                        f"Source: {SOURCE_NAME}")
    today = datetime.date.today().isoformat()
    page, n = re.subn(r"Generated \d{4}-\d{2}-\d{2}", f"Generated {today}", page)
    if n != 2:
        die(f"expected 2 'Generated <date>' stamps, found {n}")

    OUTPUT.write_text(page, encoding="utf-8")
    print(f"kept {len(rows)} markets, dropped {dropped} invalid rows")
    print(f"wrote {OUTPUT.name}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--xlsx", type=Path, default=DEFAULT_XLSX,
                    help="path to Acquisition Screener workbook")
    build(ap.parse_args().xlsx)
```

- [ ] **Step 2: Run the builder**

Run: `python build_acquisitions_model.py`
Expected output (79/35 per spec; takes ~1-2 min, the workbook is 58 MB):

```
kept 79 markets, dropped 35 invalid rows
wrote acquisitions-model.html
```

- [ ] **Step 3: Verify the generated page structurally**

Run (Git Bash):

```bash
grep -c '<tr>' acquisitions-model.html                      # expect 161 (79+79 data rows + 2 header + 1 legend-free)
grep -o '<title>[^<]*' acquisitions-model.html              # expect: <title>Forward Looking Model - Acquisition Screener 2024
grep -c 'Source: Acquisition Screener' acquisitions-model.html   # expect 2
grep -o 'rank rank-forward">1<' acquisitions-model.html | head -2  # appears twice (values + weightings row 1)
```

If the `<tr>` count differs, count data rows directly:
`grep -o '<tr><td><span class="rank rank-forward"' acquisitions-model.html | wc -l` → expect **158** (79 per tab).

- [ ] **Step 4: Spot-check three markets against the Excel**

Run: `grep -A0 'University of Connecticut' acquisitions-model.html | head -2`
Expected values row (UConn, fwd rank 1, curr rank 5, change +4): enrollment `25,037`, TTM prelease `61%`, PBSH occ `96.2%`, bed/enroll Δ `5.3%`, prelease Δ `15.4%`, app growth `58%`, POSH occ `100%`, OoS growth `51%`.
Expected weightings row: scores `0.20  0.06  -0.09  0.13  0.07  0.18  0.19`, counts `1 1 2 0`, Power 4 `–`, R1 `✓`, rent/price `12.3%`, rent `$1,766`.
Also confirm row 2 = University of Missouri, row 3 = Rutgers University – New Brunswick (en dash in name).

- [ ] **Step 5: Commit**

```bash
git add build_acquisitions_model.py acquisitions-model.html
git commit -m "Add acquisitions ranking model page + builder script"
```

## Chunk 2: Dashboard wiring

### Task 2: Toggle markup in `index.html`

**Files:**
- Modify: `index.html` (the `#forward-view` section, ~line 611; the `style.css?v=` link, line 8; the `dashboard.js?v=` script, line 683)

- [ ] **Step 1: Replace the `#forward-view` section**

Old:

```html
      <section id="forward-view" class="view">
        <iframe class="forward-frame" src="forward-model.html"
                title="Forward Looking Model - Market Screener" loading="lazy"></iframe>
      </section>
```

New:

```html
      <section id="forward-view" class="view">
        <div class="fwd-toggle" role="tablist" aria-label="Forward model selector">
          <button class="fwd-toggle-btn active" data-model="dev" type="button">Development</button>
          <button class="fwd-toggle-btn" data-model="acq" type="button">Acquisitions</button>
        </div>
        <iframe class="forward-frame" id="forward-frame-dev" src="forward-model.html"
                title="Forward Looking Model - Market Screener" loading="lazy"></iframe>
        <iframe class="forward-frame fwd-hidden" id="forward-frame-acq" data-src="acquisitions-model.html"
                title="Forward Looking Model - Acquisition Screener" loading="lazy"></iframe>
      </section>
```

(The acquisitions iframe has no `src` — the toggle handler sets it from `data-src` on first selection, guaranteeing it loads nothing until chosen.)

- [ ] **Step 2: Bump asset versions**

Line 8: `style.css?v=59` → `style.css?v=60`.
Line 683: `dashboard.js?v=24` → `dashboard.js?v=25`.

### Task 3: Toggle styles in `style.css`

**Files:**
- Modify: `style.css` (append after the `.forward-frame` block, ~line 942)

- [ ] **Step 1: Add the toggle CSS**

```css
/* Forward Model: Development / Acquisitions toggle */
.fwd-toggle {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.fwd-toggle-btn {
  padding: 7px 20px;
  border: 1px solid var(--beige-deep);
  border-radius: 20px;
  background: var(--surface);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--slate-70);
  cursor: pointer;
}
.fwd-toggle-btn:not(.active):hover { background: var(--beige); }
.fwd-toggle-btn.active {
  background: var(--everest);
  border-color: var(--everest);
  color: #fff;
}
.forward-frame.fwd-hidden { display: none; }
/* The toggle bar sits above the frames, so give them back its height */
#forward-view .forward-frame {
  height: calc(100vh / var(--page-zoom, 1) - 178px);
}
```

### Task 4: Toggle handler + brand-injection fix in `dashboard.js`

**Files:**
- Modify: `dashboard.js:1559-1579` (the `brandForwardModel` IIFE)

- [ ] **Step 1: Replace the `brandForwardModel` IIFE and add the toggle handler**

Old (lines 1559–1579): the existing `brandForwardModel` function using `document.querySelector(".forward-frame")`.

New:

```js
/* ----- Forward Model iframe re-skin --------------------------- */
// forward-model.html / acquisitions-model.html are generated drop-ins that
// get replaced wholesale, so the Subtext branding is injected from outside:
// append the override stylesheet into each iframe document as it (re)loads.
// Scoped to #forward-view so the Market State iframe is not touched.
(function brandForwardModel() {
  document.querySelectorAll("#forward-view .forward-frame").forEach((frame) => {
    const inject = () => {
      try {
        const doc = frame.contentDocument;
        if (!doc || !doc.head || doc.getElementById("fwd-brand-css")) return;
        const link = doc.createElement("link");
        link.id = "fwd-brand-css";
        link.rel = "stylesheet";
        link.href = "forward-model-brand.css?v=1";
        doc.head.appendChild(link);
      } catch { /* same-origin, so this shouldn't throw */ }
    };
    frame.addEventListener("load", inject);
    inject();  // covers the already-loaded case
  });
})();

/* ----- Forward Model: Development / Acquisitions toggle -------- */
(function forwardModelToggle() {
  const btns = document.querySelectorAll("#forward-view .fwd-toggle-btn");
  const dev = document.getElementById("forward-frame-dev");
  const acq = document.getElementById("forward-frame-acq");
  if (!btns.length || !dev || !acq) return;
  btns.forEach((btn) => btn.addEventListener("click", () => {
    btns.forEach((b) => b.classList.toggle("active", b === btn));
    const showAcq = btn.dataset.model === "acq";
    if (showAcq && !acq.getAttribute("src")) acq.src = acq.dataset.src;
    dev.classList.toggle("fwd-hidden", showAcq);
    acq.classList.toggle("fwd-hidden", !showAcq);
  }));
})();
```

- [ ] **Step 2: Commit**

```bash
git add index.html style.css dashboard.js
git commit -m "Add Development/Acquisitions toggle to Forward Model tab; fix brand-CSS injection targeting"
```

### Task 5: End-to-end verification (spec §Verification)

- [ ] **Step 1: Serve locally**

Run: `python -m http.server 8765` (from the repo root, in the background).
Open `http://127.0.0.1:8765/`.

- [ ] **Step 2: Walk the checklist**

1. Forward Model tab opens on Development, looking as before **plus** the Subtext brand skin (fonts/colors from `forward-model-brand.css` now actually injected).
2. Click **Acquisitions**: acquisitions page loads lazily, header reads "Forward Looking Model - Acquisition Screener", 79 rows, UConn #1 / Missouri #2 / Rutgers #3.
3. Both sub-tabs (Values / Weightings) work on the acquisitions page; column-header sorting works; the 3yr Bed/Enroll Δ column shows inverted coloring (high positive = red).
4. Toggle back and forth: scroll position and selected sub-tab survive on both sides.
5. Market State tab renders correctly and no longer receives `forward-model-brand.css` (inspect its iframe `<head>`: no `#fwd-brand-css` element).
6. Spot-check two mid-table markets (any two, e.g. ranks ~40 and ~79) against the Excel on both tabs.
7. All other tabs (Industry, Analysis, Sources) unaffected.

- [ ] **Step 3: Hand off to the user for local review**

Leave the server running; the user examines the dashboard in their browser. **No push until user sign-off.**
