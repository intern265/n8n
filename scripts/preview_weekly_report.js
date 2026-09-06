// Runs the whole weekly report offline against a fabricated week and writes
// the HTML out, so the layout can be checked before anyone is emailed.
//   node scripts/preview_weekly_report.js [outfile.html]
const fs = require('fs');
const path = require('path');
const { load } = require('./lib/nodes');

const wf = load('j_elliot_weekly_campaign_report.json');
const AS_OF = '2026-09-07T08:00:00+10:00';

const cfg = wf.run('Report Config', [{ asOfDate: AS_OF }])[0];
const branches = (rows) => ({ branches: [rows.map((json) => ({ json }))] });

// ---- a plausible week -------------------------------------------------
const day = (n) => `2026-09-0${n}`;
const pick = (arr, i) => arr[i % arr.length];

const reactivation = [];
for (let i = 0; i < 60; i++) {
  const status = i < 12 ? 'Email 1' : i < 30 ? 'Email 2' : i < 38 ? 'Email 3'
    : i < 43 ? 'Converted' : i < 45 ? 'Unresponsive' : 'Email 1';
  const touched = i < 45; // the rest were last touched weeks ago
  reactivation.push({
    'Account No': `RA${1000 + i}`,
    'Customer Name': `Reactivation Customer ${i + 1}`,
    Status: status,
    'Entered Flow At': touched ? day(1) : '2026-07-01',
    'Last Contacted At': touched ? day(pick([2, 3, 4, 5], i)) : '2026-07-03',
    'Converted At': status === 'Converted' ? day(pick([3, 4, 5], i)) : '',
  });
}

const salesCycle = [];
for (let i = 0; i < 80; i++) {
  const status = i < 58 ? 'In Progress' : i < 70 ? 'Converted' : i < 72 ? 'Unresponsive' : 'In Progress';
  const touched = i < 72;
  salesCycle.push({
    AccountNo: `SC${2000 + i}`,
    Company: `Sales Cycle Customer ${i + 1}`,
    Tier: i < 8 ? 'Tier A' : i < 30 ? 'Tier B' : 'Tier C',
    Status: status,
    'Entered Flow At': touched ? day(1) : '2026-06-15',
    'Last Contacted At': touched ? day(pick([2, 3, 4], i)) : '2026-06-20',
    'Converted At': status === 'Converted' ? day(pick([4, 5], i)) : '',
  });
}

const invoice = [];
for (let i = 0; i < 28; i++) {
  const status = i < 18 ? 'Pending' : i < 23 ? 'Paid' : i < 24 ? 'Escalated' : 'Pending';
  const touched = i < 24;
  invoice.push({
    AccountNo: `IN${3000 + (i % 15)}`,
    'Invoice No': `INV-${5000 + i}`,
    Status: status,
    'Amount Remaining': (200 + i * 37).toFixed(2),
    'Last Contacted At': touched ? day(2) : '2026-08-01',
    'Date Paid': status === 'Paid' ? day(pick([3, 4, 5], i)) : '',
  });
}

const fieldfolio = [];
for (let i = 0; i < 6; i++) {
  const status = i < 4 ? 'Active' : 'Converted';
  fieldfolio.push({
    AccountNo: `FF${4000 + i}`,
    Company: `Fieldfolio Buyer ${i + 1}`,
    Status: status,
    'Entered Flow At': day(2),
    'Last Contacted At': day(3),
    'Converted At': status === 'Converted' ? day(5) : '',
  });
}

const history = [{
  weekStart: '2026-08-24', weekEnd: '2026-08-30',
  contacted: 131, converted: 17, revenue: 9880.0, conversionRate: 12.98,
}];

// ---- run the pipeline -------------------------------------------------
const base = wf.run('Normalise Tracker Rows', [{}], {
  'Report Config': branches([cfg]),
  'Fetch Reactivation Tracker': branches(reactivation),
  'Fetch Sales Cycle Tracker': branches(salesCycle),
  'Fetch Invoice Tracker': branches(invoice),
  'Fetch Fieldfolio Tracker': branches(fieldfolio),
  'Fetch Report History': branches(history),
})[0];

// E-Suite hands back one row per invoice for the accounts that converted.
const transactions = [];
base.convertedRecords.forEach((rec, i) => {
  transactions.push({
    BillAccountNo: rec.accountNo,
    TransDate: `2026-09-0${pick([3, 4, 5], i)}T02:00:00Z`,
    Revenue: Number((320 + (i % 9) * 190).toFixed(2)),
  });
});
// Noise the aggregator is expected to ignore.
transactions.push({ BillAccountNo: 'RA9999', TransDate: '2026-09-04T02:00:00Z', Revenue: 5000 });

const agg = wf.run('Aggregate & Calculate', transactions, {
  'Normalise Tracker Rows': branches([base]),
})[0];
const report = wf.run('Render HTML Report', [agg])[0];

// ---- report ------------------------------------------------------------
console.log(`\n${report.plain}\n`);
console.log('  subject:', report.subject);
console.log('  diagnostics:', JSON.stringify(agg.diagnostics));
if (agg.wow) {
  console.log('  week on week: contacted', agg.wow.contacted.change,
    '| converted', agg.wow.converted.change,
    '| revenue', agg.wow.revenue.change.toFixed(2));
}

const dest = path.resolve(process.argv[2] || path.join(__dirname, '..', 'preview-weekly-report.html'));
fs.writeFileSync(dest, report.html);
console.log(`\n  wrote ${dest} — open it in a browser to check the layout\n`);
