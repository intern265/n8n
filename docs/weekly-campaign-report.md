# J Elliot weekly campaign report

`workflows/j_elliot_weekly_campaign_report.json` — Monday 08:00 Australia/Sydney,
one HTML email covering the week that just ended.

Offline checks: `node scripts/test_weekly_report.js`,
`node scripts/validate_weekly_report.js`.
Preview without emailing anyone: `node scripts/preview_weekly_report.js`.

---

## 1. Review of the proposed architecture

The brief's shape is right — read the trackers, join E-Suite for revenue, render,
email. What follows is what had to change to make it produce numbers that hold up.

### 1.1 Nothing in the design bounded the data to a week

The report is titled "Week of [DATE] — [DATE]", but reading a tracker tab returns
every row ever written to it. `Customers in Flow: 45` would have been the
all-time count, growing every week, and `Converted: 23` would have been every
conversion since the tracker was created.

**Now:** `Report Config` computes an explicit window — Monday 00:00 to Sunday
23:59:59 local — and every row is tested against it. A row counts toward the week
if the flow entered, contacted, converted or resolved it inside the window.
Rows outside it appear only in the "Still open (all weeks)" line at the bottom of
each card, which is the pipeline snapshot the brief's numbers were implicitly
mixing in.

This is the change that decides whether the report is worth sending. It also means
**the trackers must carry dates** — see §4.

### 1.2 The window has to survive daylight saving

"8am AEST" via a bare cron expression runs in whatever timezone the n8n instance
is set to. And a week is not 7 × 86,400,000 milliseconds: the week containing
Sydney's spring-forward is 167 hours, the fall-back week is 169.

**Now:** the workflow carries `settings.timezone`, the validator asserts it matches
`REPORT_TZ` in the code, and the boundaries are computed by calendar arithmetic on
local dates rather than by shifting an instant. Naive instant arithmetic put the
start of the spring-forward week on Sunday 27 September instead of Monday 28th —
the tests cover both transitions.

**Decision needed:** `Australia/Sydney` means 08:00 *local* all year. Literal AEST
all year is `Australia/Brisbane`, which is 07:00 Sydney time over summer. Currently
set to Sydney.

### 1.3 The sample numbers do not reconcile

From the brief: 5 + 12 + 2 = 19 conversions, or 24 if invoice resolutions are
included. The summary says 23. And `147 = 45 + 72 + 24 + 6` adds **invoices** to a
line labelled "Total Customers Contacted".

Two separate problems:

- **Invoices are documents, not people.** One customer with three overdue invoices
  is three rows in the invoice tracker. Adding them to a customer count inflates
  the denominator and deflates the conversion rate.
- **A customer can be in two flows at once.** Someone inactive enough for
  reactivation and mid-cycle enough for a nudge is counted twice in `45 + 72`.

**Now:** the headline counts **unique customers** across flows 1, 2 and 4
(deduplicated on AccountNo); flow 3 is reported on its own terms; the naive
per-flow sum and the overlap are both kept and the overlap is called out in the
email. `Total Converted` is flows 1, 2 and 4 — invoices being paid is debt
recovery, which is consistent with the brief's own revenue line ($3,200 + $8,450 +
$800 = $12,450 already excludes the $2,340 recovered).

### 1.4 The SQL would not have run

```sql
AND t.BillAccountNo IN (/* list of converted AccountNos */)
AND t.TransDate >= '/* EnteredFlowAt date */'
```

- `EnteredFlowAt` is **per customer**, but the query has one date for all of them.
  Whoever entered the flow earliest sets the floor for everyone.
- A week with no conversions produces `IN ()` — a syntax error, so the whole run
  fails on a quiet week.
- The account list is concatenated from spreadsheet cells. A tracker is a text box
  anyone can type into; that string reaches the database verbatim.

**Now:** `Normalise Tracker Rows` builds the query so the account list can be
validated first. Account codes must match `^[A-Za-z0-9._-]{1,32}$` or they are
dropped and reported; an empty week sends a `SELECT TOP 0` no-op; the query
window runs from the earliest entry date to the end of the reporting week and the
**per-customer** cut-off is applied in `Aggregate & Calculate`, where each
customer's own `EnteredFlowAt` is available. There is also a `maxAccounts` ceiling
so a bulk tracker edit cannot fire an unbounded query at E-Suite.

The query is a single round trip regardless of how many customers converted.

### 1.5 Revenue was double-counted and never expired

- A customer who converts in two flows in the same week has the same order summed
  into both flow totals, and then into the headline.
- `TransDate >= EnteredFlowAt` with no upper bound means a customer enrolled six
  months ago has **every order since** credited to that flow, forever. That number
  only ever goes up, which makes it useless for judging a week.

**Now, two rules:**

1. **One transaction, one flow.** Each account is claimed by exactly one flow —
   the one it entered first — and the headline is the sum of the assignments, not
   the sum of the flows.
2. **An attribution window.** `attributionDays` (default 30) after entering the
   flow. Outside it, an order is not flow revenue.

Both are configurable in `Report Config` and both are covered by tests. The email
footer states the window so the number is auditable, and the diagnostics line
reports how many transactions were attributed out of how many came back.

### 1.6 "Parallel fetch" would have made things worse, not faster

n8n's v1 execution order runs branches one at a time, so a parallel fan-out buys
no wall-clock time. It does cost correctness: five branches converging on one Code
node either need a Merge node, or run that node five times.

**Now:** the reads are chained, and the aggregator pulls each by node name. One
execution, deterministic ordering, no Merge.

### 1.7 A broken source would have looked like a bad week

If someone renames a tab, the read fails and the report emails zeros. Zeros are
indistinguishable from a genuinely quiet week — which is exactly the week someone
would act on.

**Now:** every read is `alwaysOutputData` + `continueRegularOutput`, and unread
sources, unrecognised statuses, missing tiers, rejected account codes and dropped
conversions all surface in a **"Read these numbers with care"** banner at the top
of the email. A database outage reports revenue as *unavailable*, never as $0.
Row counts per source are printed in the footer.

### 1.8 n8n has no HTML-to-PDF node

There is no native node, and there is no PDF format that survives an 8am phone
screen better than HTML does.

**Now:** the report is sent as **inline HTML** with the same HTML **attached as a
file** — open the attachment in a browser and Print → Save as PDF. A disabled
`Render PDF (optional)` HTTP node sits in the chain for anyone running Gotenberg,
Browserless or PDFShift; disabled nodes pass data through, so it costs nothing
until it is switched on. The Gmail node reads its subject and body from
`Render HTML Report` **by node name**, so enabling the PDF node cannot break it.

### 1.9 The big three mean nothing on their own

"How many did we contact, how many converted, how much money" is the right
instinct, but 147 / 23 / $12,450 is not actionable without last week's numbers.

**Now:** every run appends its summary to a `Report History` tab in the same
spreadsheet, and the next run renders week-on-week deltas under each of the three
hero numbers. The append happens **after** the email, so a Sheets failure costs
next week's comparison, not this week's report.

### 1.10 Smaller things

- Conversion rates guard against a zero denominator (`—`, not `NaN%` or a crash).
- Trackers are hand-edited, so column headers are matched case-, space- and
  punctuation-insensitively against a synonym list rather than by exact name.
- Money parses `$1,200.50` and accounting negatives `(300)`.
- Dates parse ISO, Australian day-first (`02/09/2026`) and Sheets serial numbers.
- Customer names are HTML-escaped — a business called `Tom & Jerry <Pty> Ltd` is
  not markup.
- The workflow ships `active: false`, so importing it cannot email anyone by
  surprise.
- A manual trigger runs the same chain, and passing
  `{"asOfDate": "2026-09-07T08:00:00+10:00"}` reports the week before that instant,
  for backfills and for reproducing a run someone is querying. Backfilled runs are
  labelled as such in the email.

---

## 2. How the numbers are defined

| Figure | Definition |
|---|---|
| **Week** | Monday 00:00 → Sunday 23:59:59, `REPORT_TZ`. |
| **In the week** | The flow entered, contacted, converted or resolved the row inside the window. |
| **Customers contacted** | Unique AccountNos across flows 1, 2 and 4. Invoices excluded. |
| **Converted** | Flows 1, 2 and 4, dated inside the window. A row marked converted with no conversion date is credited to the week it was touched. |
| **Revenue** | E-Suite `SIN` transactions for converted accounts, on or after `EnteredFlowAt` and within `attributionDays` of it, capped at the end of the week. One order → one flow. |
| **Amount recovered** | Flow 3 only. Recovered debt, deliberately **not** counted as revenue. |
| **Conversion rate** | Converted ÷ unique customers contacted. Flow 3 reports a *resolution* rate. |
| **Still open** | Rows in a non-terminal status, **all weeks**, not just this one. Pipeline context, not a weekly figure. |

---

## 3. Setup

1. **Credentials.** Seven nodes ship with `REPLACE_…` placeholder ids —
   deliberately obvious rather than plausible-looking:
   - the five `Fetch …` Sheets nodes and `Append Report History` →
     Google Sheets OAuth2 (read on the trackers, write on `Report History`)
   - `Fetch Revenue (E-Suite)` → the E-Suite SQL credential
   - the two Gmail nodes already point at `j-elliot-draft-orders`
2. **Tab names.** Open `Report Config` and check `TABS` against the tabs in
   `163l3DNFeW5e_O_qXcRLAgh1vDOzV9hpa87gSK6O1XQk`. This is the one thing that
   cannot be verified offline. Everything reads from here — the spreadsheet id and
   every tab name are set once.
3. **Create the `Report History` tab** with a header row matching the keys in
   `historyRow` (`weekStart`, `weekEnd`, `contacted`, `converted`, `revenue`, …).
   Until it exists the report still sends; it just has nothing to compare against.
4. **Error workflow.** Settings → Error Workflow → this workflow, or the
   `Error Trigger` never fires and a failed Monday is silent.
5. **Recipients.** `RECIPIENTS` in `Report Config`.
6. **Dry run.** Execute manually, read the email, *then* activate.

### E-Suite database type

`Fetch Revenue (E-Suite)` is a `microsoftSql` node — `T_trans` / `CompanyNo` /
`TransTotalIncGST` reads as SQL Server, and the empty-week no-op uses
`SELECT TOP 0`. **Confirm this.** If E-Suite is Postgres or MySQL, swap the node
type and change `SELECT TOP 0 …` to `… LIMIT 0` in `Normalise Tracker Rows`;
nothing else in the query is dialect-specific.

---

## 4. What the trackers need to contain

Headers are matched loosely, so `Account No`, `AccountNo` and `account_no` all
work. Per flow:

| Flow | Needs | Optional |
|---|---|---|
| All | `AccountNo`, `Status` | `Customer`/`Company`, `Email` |
| All | **`EnteredFlowAt`**, **`LastContactedAt`**, **`ConvertedAt`** | — |
| 1 Reactivation | `Step` (or a status of `Email 1`/`Step 2`/…) | — |
| 2 Sales Cycle | `Tier` (`A`/`B`/`C`, or `Tier A`) | — |
| 3 Invoice | `InvoiceNo`, `AmountRemaining`, `ResolvedAt`/`DatePaid` | `AmountRecovered` |
| 4 Fieldfolio | — | — |

**The date columns are the load-bearing part.** Without `EnteredFlowAt` no revenue
can be attributed; without `LastContactedAt` / `ConvertedAt` the week cannot be
bounded and the report silently becomes an all-time total. Anything the report
cannot read is listed in the data-quality banner rather than quietly dropped.

Recognised statuses (matched case-insensitively, substrings allowed):

| Flow | Buckets |
|---|---|
| 1 | `Email 1/2/3`, `Step 1/2/3`, `Converted`, `Unresponsive`/`No Response`/`Lapsed` |
| 2 | `In Progress`/`Nudged`/`Open`, `Converted`/`Won`, `Unresponsive`/`Lost` |
| 3 | `Pending`/`Overdue`/`Unpaid`, `Resolved`/`Paid`, `Escalated`/`Collections` |
| 4 | `Active`/`Sent`, `Converted`/`Recovered` |

Unrecognised statuses fall into the flow's open bucket and are counted in the
banner — the report never drops a row silently. Add synonyms in
`STATUS_MAPS` in `Normalise Tracker Rows`.

---

## 5. Open questions

1. **AEST or 8am local?** `Australia/Sydney` (8am local all year) vs
   `Australia/Brisbane` (8am AEST all year). Currently Sydney.
2. **Credit notes.** `TransType = 'SIN'` counts invoices only. A customer who
   converts and then returns half the order shows full revenue. What is the credit
   `TransType` in E-Suite, and should it net off?
3. **Is 30 days the right attribution window?** It is one line in `Report Config`.
4. **Should invoice resolutions count as conversions?** Currently no — consistent
   with the brief's own revenue arithmetic, but it is a one-line change.
5. **Confirm E-Suite is SQL Server** (§3).

---

## 6. What the tests cover

`scripts/test_weekly_report.js` runs the real Code-node sources from the workflow
JSON against fixtures — 82 assertions over the reporting window (including both
daylight-saving transitions and the year boundary), header and status
normalisation, the deduplicated headline, SQL generation including a rejected
injection attempt and the empty-week no-op, attribution (before entry, past the
window, two flows one order, database down), week-on-week deltas (including a week when the database was down), and the
rendered email.

`scripts/validate_weekly_report.js` checks what fixtures cannot: wiring, the
linear chain, schedule and timezone agreement, that every Sheets node reads its
target from config, that reads are reads and the history node appends, that every
source degrades instead of failing, that the query is built in code rather than in
the node, that the email survives the PDF node being enabled, and that every
`$('node')` reference resolves.

`scripts/preview_weekly_report.js` runs the whole pipeline against a fabricated
week and writes the HTML out, so the layout can be checked before anyone is
emailed.
