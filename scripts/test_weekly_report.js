// Offline tests for workflows/j_elliot_weekly_campaign_report.json.
// Runs the real Code-node sources against fixtures, so what is asserted here
// is exactly what ships in the workflow.
//   node scripts/test_weekly_report.js
const { load } = require('./lib/nodes');

const wf = load('j_elliot_weekly_campaign_report.json');

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  // detail is only useful when something broke
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? ' — ' + detail : ''}`);
};
const eq = (name, actual, expected) =>
  check(name, actual === expected, actual === expected ? '' : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

// A Monday-8am run reporting the week of Mon 31 Aug – Sun 6 Sep 2026.
const AS_OF = '2026-09-07T08:00:00+10:00';
const config = (asOf = AS_OF) => wf.run('Report Config', [{ asOfDate: asOf }])[0];

const branches = (rows) => ({ branches: [rows.map((json) => ({ json }))] });

function normalise(tabs, cfg = config(), history = []) {
  return wf.run('Normalise Tracker Rows', [{}], {
    'Report Config': branches([cfg]),
    'Fetch Reactivation Tracker': branches(tabs.reactivation || []),
    'Fetch Sales Cycle Tracker': branches(tabs.salesCycle || []),
    'Fetch Invoice Tracker': branches(tabs.invoice || []),
    'Fetch Fieldfolio Tracker': branches(tabs.fieldfolio || []),
    'Fetch Report History': branches(history),
  })[0];
}

const aggregate = (base, txRows = []) =>
  wf.run('Aggregate & Calculate', txRows, { 'Normalise Tracker Rows': branches([base]) })[0];

const render = (agg) => wf.run('Render HTML Report', [agg])[0];

// ---------------------------------------------------------------- window
console.log('\nREPORTING WINDOW');
{
  const c = config();
  eq('a Monday run reports the week that just ended (start)', c.window.startDate, '2026-08-31');
  eq('...through the Sunday before the run', c.window.endDate, '2026-09-06');
  eq('the end is exclusive midnight, so Sunday 23:59 is included',
    c.window.endExclusiveIso, '2026-09-06T14:00:00.000Z');
  eq('the prior week is offered for the week-on-week comparison',
    c.window.prevStartDate, '2026-08-24');

  const wed = config('2026-09-09T15:00:00+10:00');
  eq('a catch-up run mid-week still reports a whole week, not a partial one',
    `${wed.window.startDate}..${wed.window.endDate}`, '2026-08-31..2026-09-06');

  const hours = (c2) => (new Date(c2.window.endExclusiveIso) - new Date(c2.window.startIso)) / 3600000;
  eq('spring forward: the week is still 7 local days (167 real hours)',
    hours(config('2026-10-05T08:00:00+11:00')), 167);
  eq('fall back: still 7 local days (169 real hours)',
    hours(config('2026-04-06T08:00:00+10:00')), 169);
  eq('the spring-forward week starts on the right Monday',
    config('2026-10-05T08:00:00+11:00').window.startDate, '2026-09-28');
  eq('a week spanning new year rolls the year over',
    config('2027-01-04T08:00:00+11:00').window.startDate, '2026-12-28');

  check('a backfill run is flagged so nobody mistakes it for the scheduled one',
    config().isBackfill === true);
  let threw = null;
  try { config('not-a-date'); } catch (e) { threw = e.message; }
  check('an unparseable asOfDate fails loudly rather than silently reporting now',
    threw !== null && /asOfDate/.test(threw), String(threw));
}

// ------------------------------------------------------------- normalise
console.log('\nTRACKER NORMALISATION');
{
  // Deliberately messy headers: different spacing, casing and wording per tab.
  const base = normalise({
    reactivation: [
      { 'Account No': 'A100', 'Customer Name': 'Alpha Gifts', 'Status': 'Email 2', 'Entered Flow At': '2026-08-25', 'Last Contacted': '02/09/2026' },
      { 'AccountNo': 'A101', 'Company': 'Beta Homewares', 'Flow Status': 'Converted', 'Date Entered': '2026-08-20', 'Converted At': '2026-09-03' },
      { 'AccountNo': 'A102', 'Company': 'Gamma Co', 'Status': 'No Response', 'Entered Flow': '2026-08-01', 'Last Email Sent At': '2026-09-01' },
      { 'AccountNo': 'A103', 'Company': 'Old News', 'Status': 'Email 1', 'Entered Flow': '2026-06-01', 'Last Email Sent At': '2026-06-02' },
    ],
  });
  const f1 = base.flows.flow1;
  eq('only rows the flow touched in the window are counted', f1.inFlow, 3);
  eq('a step-2 row lands in step 2', f1.step2, 1);
  eq('"Converted" is a conversion', f1.converted, 1);
  eq('"No Response" reads as unresponsive, not as a step', f1.unresponsive, 1);
  eq('a row last touched in June is out of the week', f1.step1, 0);
  // A101 converted and A102 gave up, so only A100 and A103 are still open.
  eq('...but still counts toward the open pipeline', f1.openPipeline, 2);
  eq('day-first dates (02/09/2026) are read as 2 September', f1.step2, 1);
  eq('nothing was left unclassified', f1.unclassified, 0);

  const tiers = normalise({
    salesCycle: [
      { AccountNo: 'B1', Tier: 'Tier A', Status: 'In Progress', 'Last Contacted At': '2026-09-01' },
      { AccountNo: 'B2', Tier: 'b', Status: 'Converted', 'Entered Flow At': '2026-08-28', 'Converted At': '2026-09-02' },
      { AccountNo: 'B3', Tier: 'C', Status: 'Lost', 'Last Contacted At': '2026-09-04' },
      { AccountNo: 'B4', Tier: '', Status: 'Nudged', 'Last Contacted At': '2026-09-05' },
    ],
  });
  const f2 = tiers.flows.flow2;
  eq('tier A parsed from "Tier A"', f2.tierA, 1);
  eq('tier B parsed from a bare lowercase "b"', f2.tierB, 1);
  eq('tier C parsed from a bare "C"', f2.tierC, 1);
  eq('a blank tier is reported rather than guessed', f2.tierUnknown, 1);
  eq('"Lost" is unresponsive', f2.unresponsive, 1);
  eq('"Nudged" is in progress', f2.inProgress, 2);
  check('the missing tier is called out in the data-quality notes',
    tiers.issues.some((i) => /no readable tier/.test(i)));

  const inv = normalise({
    invoice: [
      { AccountNo: 'C1', 'Invoice No': 'INV-1', Status: 'Pending', 'Amount Remaining': '$1,200.50', 'Last Contacted At': '2026-09-02' },
      { AccountNo: 'C1', 'Invoice No': 'INV-2', Status: 'Paid', 'Amount Remaining': '840', 'Date Paid': '2026-09-04' },
      { AccountNo: 'C2', 'Invoice No': 'INV-3', Status: 'Escalated', 'Amount Remaining': '(300)', 'Last Contacted At': '2026-09-05' },
    ],
  });
  const f3 = inv.flows.flow3;
  eq('"$1,200.50" parses as money', f3.outstanding, 900.5);
  eq('an accounting negative "(300)" is negative', f3.escalated, 1);
  eq('"Paid" resolves the invoice', f3.resolved, 1);
  eq('the paid balance is what was recovered', f3.recovered, 840);
  eq('two invoices for one account are two invoices', f3.inFlow, 3);
  eq('...but one account', f3.accounts, 2);

  const missing = wf.run('Normalise Tracker Rows', [{}], {
    'Report Config': branches([config()]),
    'Fetch Reactivation Tracker': branches([{ error: { message: 'Unable to find sheet Reactivation' } }]),
    'Fetch Sales Cycle Tracker': branches([]),
    'Fetch Invoice Tracker': branches([]),
    'Fetch Fieldfolio Tracker': branches([]),
    'Fetch Report History': branches([]),
  })[0];
  check('a tab that failed to read is reported, not reported as zero',
    missing.issues.some((i) => /Unable to find sheet/.test(i)), JSON.stringify(missing.issues));
  check('an empty tab is reported too',
    missing.issues.some((i) => /returned no rows/.test(i)));
}

// ------------------------------------------------------------- headline
console.log('\nTHE BIG THREE');
{
  const base = normalise({
    // D1 is worked by BOTH the reactivation and sales-cycle flows this week.
    reactivation: [
      { AccountNo: 'D1', Status: 'Email 1', 'Entered Flow At': '2026-09-01', 'Last Contacted At': '2026-09-01' },
      { AccountNo: 'D2', Status: 'Converted', 'Entered Flow At': '2026-08-31', 'Converted At': '2026-09-03' },
    ],
    salesCycle: [
      { AccountNo: 'D1', Tier: 'A', Status: 'In Progress', 'Last Contacted At': '2026-09-02' },
      { AccountNo: 'D3', Tier: 'B', Status: 'Converted', 'Entered Flow At': '2026-09-01', 'Converted At': '2026-09-04' },
    ],
    invoice: [
      { AccountNo: 'D9', 'Invoice No': 'INV-9', Status: 'Paid', 'Amount Remaining': '500', 'Date Paid': '2026-09-02' },
    ],
    fieldfolio: [
      { AccountNo: 'D4', Status: 'Converted', 'Entered Flow At': '2026-09-02', 'Converted At': '2026-09-05' },
    ],
  });
  const agg = aggregate(base);
  const s = agg.summary;
  eq('a customer in two flows is one customer in the headline', s.contacted, 4);
  eq('...and the naive per-flow sum is kept for reference', s.contactedAcrossFlows, 5);
  eq('...with the overlap made explicit', s.overlap, 1);
  check('the overlap is called out rather than left to be spotted',
    agg.issues.some((i) => /more than one flow/.test(i)));
  eq('an invoice being paid is not a customer conversion', s.converted, 3);
  eq('an invoice is not a contacted customer', s.contacted, 4);
  eq('recovered debt is reported, separately from revenue', s.amountRecovered, 500);
  eq('conversion rate is converted / unique contacted', Number(s.conversionRate.toFixed(1)), 75);
  eq('flow 3 gets a resolution rate, not a conversion rate',
    agg.flows.flow3.conversionRate, 100);
  check('flow 3 carries no revenue figure at all', agg.flows.flow3.revenue === null);
}

// --------------------------------------------------------------- the SQL
console.log('\nREVENUE QUERY');
{
  const none = normalise({ reactivation: [{ AccountNo: 'E1', Status: 'Email 1', 'Last Contacted At': '2026-09-02' }] });
  check('a week with no conversions sends a well-formed no-op, never "IN ()"',
    !/IN \(\)/.test(none.revenueQuery) && /TOP 0/.test(none.revenueQuery), none.revenueQuery);
  eq('...and queries no accounts', none.revenueAccountCount, 0);

  const some = normalise({
    reactivation: [{ AccountNo: 'E1', Status: 'Converted', 'Entered Flow At': '2026-08-25', 'Converted At': '2026-09-02' }],
    salesCycle: [{ AccountNo: 'E2', Tier: 'A', Status: 'Converted', 'Entered Flow At': '2026-09-01', 'Converted At': '2026-09-03' }],
  });
  check('converted accounts appear in the IN() list',
    /IN \('E1', 'E2'\)/.test(some.revenueQuery), some.revenueQuery);
  check('the company and transaction type come from config',
    /CompanyNo = 36112/.test(some.revenueQuery) && /TransType = 'SIN'/.test(some.revenueQuery));
  check('the query starts no earlier than the earliest entry into a flow',
    /TransDate >= '2026-08-24 14:00:00'/.test(some.revenueQuery), some.revenueQuery);
  check('...and stops at the end of the reporting week',
    /TransDate <  '2026-09-06 14:00:00'/.test(some.revenueQuery));

  const nasty = normalise({
    reactivation: [
      { AccountNo: "E3'); DROP TABLE T_trans;--", Status: 'Converted', 'Entered Flow At': '2026-09-01', 'Converted At': '2026-09-02' },
      { AccountNo: 'E4', Status: 'Converted', 'Entered Flow At': '2026-09-01', 'Converted At': '2026-09-02' },
    ],
  });
  check('an account number that is not an account code never reaches the query',
    !/DROP TABLE/.test(nasty.revenueQuery), nasty.revenueQuery);
  check('...and the dropped row is reported so the revenue gap is visible',
    nasty.issues.some((i) => /not a valid account code/.test(i)));
  eq('the legitimate account still goes through', nasty.revenueAccountCount, 1);
}

// ---------------------------------------------------------- attribution
console.log('\nREVENUE ATTRIBUTION');
{
  const base = normalise({
    reactivation: [{ AccountNo: 'F1', Customer: 'Foxtrot Ltd', Status: 'Converted', 'Entered Flow At': '2026-09-01', 'Converted At': '2026-09-03' }],
  });
  const agg = aggregate(base, [
    { BillAccountNo: 'F1', TransDate: '2026-08-15T00:00:00Z', Revenue: 999 },  // before entering
    { BillAccountNo: 'F1', TransDate: '2026-09-02T00:00:00Z', Revenue: 500 },  // inside
    { BillAccountNo: 'F1', TransDate: '2026-09-04T00:00:00Z', Revenue: 250 },  // inside
    { BillAccountNo: 'F9', TransDate: '2026-09-04T00:00:00Z', Revenue: 777 },  // not a converted account
  ]);
  eq('orders before the customer entered the flow are not flow revenue',
    agg.flows.flow1.revenue, 750);
  eq('an order for an account nobody claimed is ignored',
    agg.diagnostics.transactionsWithoutAClaim, 1);
  eq('the attributed/returned split is reported for auditing',
    `${agg.diagnostics.transactionsAttributed}/${agg.diagnostics.transactionsReturned}`, '2/4');

  // Entered the flow long before the reporting week: the attribution window
  // is what stops every order since being credited to the flow.
  const stale = normalise({
    reactivation: [{ AccountNo: 'F2', Status: 'Converted', 'Entered Flow At': '2026-01-01', 'Converted At': '2026-09-03' }],
  });
  const staleAgg = aggregate(stale, [{ BillAccountNo: 'F2', TransDate: '2026-09-02T00:00:00Z', Revenue: 5000 }]);
  eq('an order 8 months after entering the flow is outside the attribution window',
    staleAgg.flows.flow1.revenue, 0);
  check('...and that is explained rather than left as a mysterious $0',
    staleAgg.issues.some((i) => /attribution window/.test(i)));

  // The same customer converts in two flows in the same week.
  const dual = normalise({
    reactivation: [{ AccountNo: 'G1', Status: 'Converted', 'Entered Flow At': '2026-08-30', 'Converted At': '2026-09-02' }],
    salesCycle: [{ AccountNo: 'G1', Tier: 'A', Status: 'Converted', 'Entered Flow At': '2026-09-01', 'Converted At': '2026-09-03' }],
  });
  const dualAgg = aggregate(dual, [{ BillAccountNo: 'G1', TransDate: '2026-09-02T00:00:00Z', Revenue: 1000 }]);
  eq('one order is credited to one flow only — the one entered first',
    dualAgg.flows.flow1.revenue, 1000);
  eq('...not to the second flow as well', dualAgg.flows.flow2.revenue, 0);
  eq('...so the headline is the order once, not twice', dualAgg.summary.revenue, 1000);

  const down = aggregate(base, [{ error: { message: 'ECONNREFUSED e-suite:1433' } }]);
  check('a database outage reports revenue as unavailable, not as zero',
    down.summary.revenueAvailable === false);
  check('...and says so in the report', down.issues.some((i) => /not zero/.test(i)));
}

// --------------------------------------------------------- week on week
console.log('\nWEEK ON WEEK');
{
  const base = normalise({
    reactivation: [{ AccountNo: 'H1', Status: 'Converted', 'Entered Flow At': '2026-09-01', 'Converted At': '2026-09-02' }],
  }, config(), [
    { weekStart: '2026-08-17', contacted: 90, converted: 9, revenue: 4000, conversionRate: 10 },
    { weekStart: '2026-08-24', contacted: 100, converted: 10, revenue: 5000, conversionRate: 10 },
  ]);
  const agg = aggregate(base, [{ BillAccountNo: 'H1', TransDate: '2026-09-02T00:00:00Z', Revenue: 6000 }]);
  eq('the comparison uses the most recent prior week', agg.wow.weekStart, '2026-08-24');
  eq('contacted is compared against it', agg.wow.contacted.change, 1 - 100);
  eq('revenue is compared against it', agg.wow.revenue.change, 1000);
  eq('...as a percentage too', agg.wow.revenue.pct, 20);

  // Last week E-Suite was down, so its history row says revenue: 0.
  const afterOutage = normalise({
    reactivation: [{ AccountNo: 'H2', Status: 'Converted', 'Entered Flow At': '2026-09-01', 'Converted At': '2026-09-02' }],
  }, config(), [
    { weekStart: '2026-08-24', contacted: 100, converted: 10, revenue: 0, conversionRate: 10, revenueAvailable: 'no' },
  ]);
  const outageAgg = aggregate(afterOutage, [{ BillAccountNo: 'H2', TransDate: '2026-09-02T00:00:00Z', Revenue: 6000 }]);
  check('a week when the database was down is not compared as if revenue really was $0',
    outageAgg.wow.revenue === null);
  check('...but its customer counts are still worth comparing against',
    outageAgg.wow.contacted.change === 1 - 100);

  const first = aggregate(normalise({ reactivation: [] }), []);
  check('the very first run has nothing to compare against and says nothing',
    first.wow === null);
}

// ------------------------------------------------------------------ html
console.log('\nRENDERED EMAIL');
{
  const base = normalise({
    reactivation: [{ AccountNo: 'I1', Customer: 'Tom & Jerry <Pty> Ltd', Status: 'Converted', 'Entered Flow At': '2026-09-01', 'Converted At': '2026-09-02' }],
    invoice: [{ AccountNo: 'I2', 'Invoice No': 'INV-7', Status: 'Paid', 'Amount Remaining': '340', 'Date Paid': '2026-09-03' }],
  });
  const out = render(aggregate(base, [{ BillAccountNo: 'I1', TransDate: '2026-09-02T00:00:00Z', Revenue: 1234.5 }]));

  check('the subject names the week and leads with the outcome',
    /31 Sep|31 Aug/.test(out.subject) && /1 converted/.test(out.subject), out.subject);
  check('the big three are on the page',
    /Customers contacted/.test(out.html) && /Converted/.test(out.html) && /Revenue/.test(out.html));
  check('money is formatted as AUD', /\$1,234\.50/.test(out.html));
  check('a customer name with HTML in it is escaped, not injected',
    out.html.includes('Tom &amp; Jerry &lt;Pty&gt; Ltd') && !out.html.includes('<Pty>'));
  check('the method is documented in the email itself',
    /How these numbers are built/.test(out.html));
  check('recovered debt is labelled as not revenue',
    /not counted as revenue/.test(out.html));
  check('every flow gets a section', [1, 2, 3, 4].every((n) => out.html.includes(`Flow ${n}`)));
  check('the attachment is named for the week',
    out.fileName === 'j-elliot-weekly-report-2026-08-31.html', out.fileName);
  check('a plain-text fallback is produced for clients that refuse HTML',
    /J ELLIOT WEEKLY CAMPAIGN REPORT/.test(out.plain));
  check('the history row carries the week key next week compares against',
    out.historyRow.weekStart === '2026-08-31' && out.historyRow.revenue === 1234.5);
  check('the html is a complete document, so the attachment opens standalone',
    /^<!doctype html>/.test(out.html) && /<\/html>$/.test(out.html));

  const down = render(aggregate(base, [{ error: { message: 'db down' } }]));
  check('when revenue is unavailable the email says so instead of showing $0.00',
    /unavailable/.test(down.html) && !/\$0\.00<\/div>/.test(down.html));
}

console.log(`\n  ${failed ? failed + ' assertion(s) FAILED' : 'all assertions passed'}\n`);
process.exit(failed ? 1 : 0);
