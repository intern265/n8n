# Weekly campaign report — node walkthrough

Companion to [`weekly-campaign-report.md`](weekly-campaign-report.md). Explains
each node in plain English, then how to pin the fixtures in
`workflows/fixtures/weekly-report/` and verify the whole workflow before it ever
sends an email.

---

## 1. What each node does

The workflow is a straight line: schedule → read the trackers → ask E-Suite for
revenue → do the maths → render the email → send it → record the summary. Every
node has one job.

### Triggers (left column)

| # | Node | What it does |
|---|---|---|
| 1 | **Weekly Monday 8am** | Fires the workflow every Monday at 08:00 in the workflow's configured timezone. Nothing else — it hands off to Report Config. |
| 2 | **Run Manually / Backfill** | The button in the n8n editor. Runs the same chain, useful for testing, dry runs, or regenerating a past week (pass `{ "asOfDate": "2026-09-07T08:00:00+10:00" }` into the trigger and the whole run treats that as "now"). |
| 3 | **Error Trigger** | Wakes up if anything downstream throws. Not on the main path — it's the safety net. |
| 4 | **Alert on Failure** | Emails `tanay@zerobusy.com` when the Error Trigger fires. The subject says which node broke and links to the failed execution in n8n. |

### Config (the single source of truth)

| # | Node | What it does |
|---|---|---|
| 5 | **Report Config** | Decides *which week* is being reported, *which spreadsheet* to read, *which tab names* to look for, *who* gets the email, and *how* revenue is attributed. Everything downstream reads from here — nothing else has an opinion on any of those. Change something once, in one place. |

The window computation is the load-bearing bit: it works out the Monday-to-Sunday
window that just ended, using calendar arithmetic on local dates (so a
daylight-saving weekend still gives you exactly 7 local days, and the boundary
lands on the right Monday).

### Reading the trackers

| # | Node | What it does |
|---|---|---|
| 6 | **Fetch Reactivation Tracker** | Reads every row of the Reactivation tab. |
| 7 | **Fetch Sales Cycle Tracker** | Reads every row of the Sales Cycle tab. |
| 8 | **Fetch Invoice Tracker** | Reads every row of the Invoice Reminders tab. |
| 9 | **Fetch Fieldfolio Tracker** | Reads every row of the Fieldfolio Draft Orders tab. |
| 10 | **Fetch Report History** | Reads the Report History tab — a running log of past weekly summaries, used to render the "vs last week" deltas. |

All five point at the spreadsheet id in Report Config and use the tab names in
Report Config, so nothing here needs editing if a tab is renamed or the sheet
moves. All five are set to **degrade rather than crash**: if a tab has been
renamed or Sheets is down, that section will show as "not read" in the report's
data-quality banner and the run continues.

### Making sense of the rows

| # | Node | What it does |
|---|---|---|
| 11 | **Normalise Tracker Rows** | Turns four hand-maintained sheets into one predictable shape. Matches column headers loosely (`Account No` = `AccountNo` = `account_no`), parses money (`$1,200.50`, `(300)`) and dates (ISO, day-first `02/09/2026`, Sheets serials). Filters rows to the reporting week. Groups them into buckets per flow (step, tier, status). Builds the E-Suite SQL query — with account codes whitelisted before they reach the `IN()` clause. Also flags any row it couldn't classify so it appears in the "read with care" banner. |

### Getting revenue

| # | Node | What it does |
|---|---|---|
| 12 | **Fetch Revenue (E-Suite)** | Runs the SQL that Normalise built. Configured to `continueRegularOutput`, so a database outage becomes a soft failure the aggregator handles (revenue shown as *unavailable*, not as $0). |

### Doing the maths

| # | Node | What it does |
|---|---|---|
| 13 | **Aggregate & Calculate** | Joins the E-Suite transactions onto the customers who converted. Two rules do the real work: (a) each transaction is credited to **exactly one flow** — the one the customer entered first — so the headline is never double-counted; (b) an order only counts if it lands **within the attribution window** (30 days) of the customer entering the flow. Also computes the "vs last week" deltas from Report History. |

### Building the email

| # | Node | What it does |
|---|---|---|
| 14 | **Render HTML Report** | Assembles the HTML email — headline, per-flow cards, top revenue accounts, method footer, "read with care" banner if needed. Also produces the plain-text fallback, the email subject line, and the row that gets appended to history. Email-safe HTML: tables for layout, inline styles, no external CSS. |
| 15 | **Report to HTML File** | Converts the HTML into a binary file attachment. Same content, different container — attach the file, open it in a browser, Print → Save as PDF. |
| 16 | **Render PDF (optional)** | **Disabled by default.** For teams running Gotenberg / Browserless / PDFShift — enable it and it converts the HTML to a real PDF before the Gmail node. Disabled nodes pass data straight through, so it costs nothing until it's switched on. |

### Sending

| # | Node | What it does |
|---|---|---|
| 17 | **Email Weekly Report** | Gmail node. Sends the HTML inline with the file (HTML or PDF) attached. Reads subject and body **by node name** from Render HTML Report, so enabling the PDF node in the middle doesn't break the send. |

### Recording

| # | Node | What it does |
|---|---|---|
| 18 | **Build History Row** | Trivial — just pulls out the pre-built history row so it becomes the item the Sheets node writes. |
| 19 | **Append Report History** | Appends this week's summary as a new row on the Report History tab. Runs **after** the email is sent, so a Sheets failure costs next week's comparison, not this week's report. |

### Documentation (yellow sticky notes)

Four sticky notes at the top of the canvas explain setup, why the reads aren't
parallelised, how revenue attribution works, and how the delivery path is
structured. They render only in the n8n editor.

---

## 2. Why the architecture is correct

**One place per decision.** The spreadsheet id, tab names, timezone, recipients,
revenue rules and reporting window are all decided in Report Config. Downstream
nodes read them by name. This is why a renamed tab is a one-line change and why
there's no way for two nodes to disagree about "which week" they're reporting on.

**A straight line, no fan-out.** n8n's v1 execution order runs branches
sequentially anyway, so a "parallel" fetch buys no wall-clock time — and five
branches into one Code node would need a Merge or run that node five times. The
chain is deterministic, easy to follow, cheap to test.

**Degrade, don't die.** Every source (`onError: continueRegularOutput`,
`alwaysOutputData: true`) can fail without killing the run. Unread sources
surface in the report's own "read with care" banner. This is the difference
between "an email with a bug" (which someone will notice) and "no email"
(which someone might not).

**Distinguish "no revenue" from "revenue unknown."** A database outage reports
revenue as *unavailable* — never as $0. Zero looks like a bad week; unavailable
looks like a broken query. Only one of those prompts the right action.

**Bounded, validated queries.** The SQL is built in the Code node so the account
list can be whitelist-validated (`^[A-Za-z0-9._-]{1,32}$`) before it reaches
`IN()`. A quiet week sends a well-formed `SELECT TOP 0` no-op instead of the
`IN ()` syntax error a naive template would produce. There's also a `maxAccounts`
ceiling so a bulk tracker edit can't fire an unbounded query at E-Suite.

**No double-counting.** A customer worked by two flows is one person in the
headline. An order for that customer is credited to the flow they entered first —
never to two flows at once. The naive sums are still available for reference and
the overlap is reported in the email.

**Bounded attribution.** Without a time cap, "revenue from this flow" is
"revenue from anyone who ever converted through this flow" — a number that only
goes up. Capping at `attributionDays` from entering the flow gives a figure that
actually moves week to week.

**Email survives changes.** The Gmail node reads its subject and body from
Render HTML Report **by node name**, so inserting or enabling the PDF node
between them doesn't break the send. The workflow ships `active: false`, so
importing it can't email anyone by surprise.

**History is written last.** The record of a week is appended after the email is
delivered. A Sheets outage at that point costs next week's "vs last week" chip,
not this week's report going out.

---

## 3. Verifying the workflow with pin data

Fixtures live in `workflows/fixtures/weekly-report/` and are shaped exactly like
what each Sheets node would return. Pinning them lets you run the whole workflow
without touching Google Sheets or E-Suite, and compare the rendered email against
a known expected output.

### 3.1 The fixtures

| File | Pin on node | Contents |
|---|---|---|
| `reactivation.json` | Fetch Reactivation Tracker | 45 rows: 12 at Step 1, 18 at Step 2, 8 at Step 3, 5 Converted, 2 Unresponsive |
| `sales-cycle.json` | Fetch Sales Cycle Tracker | 72 rows: 8 Tier A / 22 Tier B / 42 Tier C · 58 In Progress, 12 Converted, 2 Unresponsive |
| `invoice-reminders.json` | Fetch Invoice Tracker | 24 invoices: 18 Pending, 5 Paid ($2,340 recovered), 1 Escalated |
| `fieldfolio-draft-orders.json` | Fetch Fieldfolio Tracker | 6 rows: 4 Active, 2 Converted |
| `report-history.json` | Fetch Report History | One row for the prior week (2026-08-24), so "vs last week" chips render |
| `esuite-revenue.json` | Fetch Revenue (E-Suite) | 19 rows, one per converted account, totalling exactly $12,450 |

### 3.2 How to pin them in n8n

1. Import `workflows/j_elliot_weekly_campaign_report.json`.
2. **Manually execute** the workflow once (via *Run Manually / Backfill*).
   With `{ "asOfDate": "2026-09-07T08:00:00+10:00" }` passed into the trigger's
   *Execute Workflow with Input Data*, the reporting week is Mon 31 Aug → Sun
   6 Sep 2026 — matching the fixtures.
3. On each of the six data-source nodes, right-click → **Pin Data** → paste
   the contents of the matching fixture file → Save.
4. Execute again. Every node downstream of a pinned node now runs against the
   fixture data, so nothing hits Sheets or E-Suite.

To go back to real data, right-click each pinned node → **Unpin**.

### 3.3 Expected output (compare against your run)

If everything is wired correctly, the run against the fixtures produces:

**Headline**

| Field | Value |
|---|---|
| Week | 31 Aug 2026 – 6 Sep 2026 |
| Customers contacted (unique) | **123** |
| Converted | **19** |
| Revenue | **$12,450.00** |
| Overall conversion rate | 15.4% |
| Invoice debt recovered | $2,340.00 |
| Amount outstanding | $4,120.00 |

**Per flow**

| Flow | In flow | Breakdown | Revenue |
|---|---|---|---|
| 1 Inactive Reactivation | 45 | 12 / 18 / 8 · 5 converted · 2 unresponsive | $3,200.00 |
| 2 Sales Cycle Nudge | 72 | Tiers 8 / 22 / 42 · 58 in progress · 12 converted · 2 unresponsive | $8,450.00 |
| 3 Invoice Reminders | 24 | 18 pending · 5 resolved · 1 escalated | $2,340 recovered · $4,120 outstanding |
| 4 Fieldfolio Draft Orders | 6 | 4 active · 2 converted | $800.00 |

**Email subject**

```
J Elliot weekly campaign report — 31 Aug 2026 to 6 Sept 2026 · 19 converted, $12,450.00
```

The data-quality banner should NOT appear (all fixtures classify cleanly).

### 3.4 Faults the fixtures let you rehearse

Small tweaks to the pinned data prove the resilience is real, not decorative:

| Change | What should happen |
|---|---|
| Delete the Reactivation pin's contents (empty array) | Report still sends. Flow 1 shows zeroes. Banner: "Reactivation: tab read successfully but returned no rows". |
| Pin `[{"error":{"message":"Unable to find sheet"}}]` on Fetch Sales Cycle Tracker | Report still sends. Flow 2 shows zeroes. Banner names the failure. |
| Pin `[{"error":{"message":"ECONNREFUSED"}}]` on Fetch Revenue (E-Suite) | Report still sends. Every "Revenue" field shows **unavailable**, never $0. Banner explains why. |
| Change one invoice's `Status` to `wtf` | Row falls into Pending (safest bucket) and the banner reports "1 row with an unrecognised status". |
| Change one reactivation row's `AccountNo` to `E1'); DROP TABLE T_trans;--` | Row is dropped from the revenue query (never concatenated into SQL) and reported in the banner. Everything else runs. |

### 3.5 Offline check without n8n

If you want to run the whole pipeline outside n8n:

```
node scripts/preview_weekly_report.js
```

This runs the actual Code-node sources from the workflow JSON against a
fabricated week and writes the HTML to `preview-weekly-report.html`. Open it
in a browser — that is exactly the email your inbox will render.

The full test suite is `bash scripts/test_all.sh` — 82 assertions over the
window logic (including both daylight-saving transitions), header/status
normalisation, the deduplicated headline, SQL generation, revenue attribution
under nine edge cases, week-on-week deltas, and the rendered email.
