// Structural checks on workflows/j_elliot_weekly_campaign_report.json — the
// things the logic tests cannot cover: wiring, node types and operations,
// credentials, error handling, expressions.
//   node scripts/validate_weekly_report.js
const { load } = require('./lib/nodes');

const { workflow: wf } = load('j_elliot_weekly_campaign_report.json');
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const out = (from, i = 0) => ((wf.connections[from] || {}).main || [])[i]?.map((c) => c.node) || [];

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? ' — ' + detail : ''}`);
};

const READS = [
  'Fetch Reactivation Tracker', 'Fetch Sales Cycle Tracker', 'Fetch Invoice Tracker',
  'Fetch Fieldfolio Tracker', 'Fetch Report History',
];
const CHAIN = [
  'Report Config', ...READS, 'Normalise Tracker Rows', 'Fetch Revenue (E-Suite)',
  'Aggregate & Calculate', 'Render HTML Report', 'Report to HTML File',
  'Render PDF (optional)', 'Email Weekly Report', 'Build History Row',
  'Append Report History',
];

console.log('\nWIRING');
const dangling = [];
for (const [from, spec] of Object.entries(wf.connections)) {
  if (!byName[from]) dangling.push(from);
  for (const branch of spec.main || []) for (const c of branch) if (!byName[c.node]) dangling.push(c.node);
}
check('no dangling connections', dangling.length === 0, dangling.join(', '));
for (const [a, b] of CHAIN.map((n, i) => [n, CHAIN[i + 1]]).slice(0, -1)) {
  check(`${a} -> ${b}`, out(a).includes(b), out(a).join(', ') || 'nothing');
}
check('the schedule feeds the chain', out('Weekly Monday 8am').includes('Report Config'));
check('a manual trigger runs the same chain (backfills, testing)',
  out('Run Manually / Backfill').includes('Report Config'));
check('error trigger -> alert email', out('Error Trigger').includes('Alert on Failure'));
check('the chain is linear — no node fans out to two successors',
  CHAIN.every((n) => out(n).length <= 1),
  CHAIN.filter((n) => out(n).length > 1).join(', '));
check('the report is emailed BEFORE the history is written',
  CHAIN.indexOf('Email Weekly Report') < CHAIN.indexOf('Append Report History'));

console.log('\nSCHEDULE');
const sched = byName['Weekly Monday 8am'];
const interval = sched.parameters.rule.interval[0];
check('runs weekly', interval.field === 'weeks');
check('on Monday', JSON.stringify(interval.triggerAtDay) === '[1]');
check('at 08:00', interval.triggerAtHour === 8 && interval.triggerAtMinute === 0);
check('THE WORKFLOW CARRIES AN EXPLICIT TIMEZONE (a bare cron runs in the instance timezone)',
  Boolean(wf.settings.timezone), JSON.stringify(wf.settings.timezone));
const cfgCode = byName['Report Config'].parameters.jsCode;
const cfgTz = (cfgCode.match(/REPORT_TZ = '([^']+)'/) || [])[1];
check('...and the code node agrees with the workflow setting',
  cfgTz === wf.settings.timezone, `${cfgTz} vs ${wf.settings.timezone}`);

console.log('\nDATA SOURCES');
const SPREADSHEET = '163l3DNFeW5e_O_qXcRLAgh1vDOzV9hpa87gSK6O1XQk';
check('the spreadsheet id is set once, in Report Config',
  cfgCode.includes(SPREADSHEET));
const sheets = [...READS, 'Append Report History'].map((n) => byName[n]);
check('every Sheets node is a Google Sheets node',
  sheets.every((n) => n.type === 'n8n-nodes-base.googleSheets'));
check('EVERY SHEETS NODE READS THE SPREADSHEET ID FROM CONFIG (no second copy to drift)',
  sheets.every((n) => String(n.parameters.documentId.value).includes("$('Report Config')")),
  sheets.filter((n) => !String(n.parameters.documentId.value).includes("$('Report Config')")).map((n) => n.name).join(', '));
check('...and the tab name from config too',
  sheets.every((n) => String(n.parameters.sheetName.value).includes("$('Report Config').first().json.tabs.")));
check('the four tracker reads are reads, not writes',
  READS.every((n) => !byName[n].parameters.operation || byName[n].parameters.operation === 'read'));
check('the history node appends', byName['Append Report History'].parameters.operation === 'append');
check('every tab named in the code has a node reading it',
  ['reactivation', 'salesCycle', 'invoice', 'fieldfolio', 'history']
    .every((k) => sheets.some((n) => String(n.parameters.sheetName.value).endsWith(`tabs.${k} }}`))));

console.log('\nFAILURE BEHAVIOUR');
const softFail = [...READS, 'Fetch Revenue (E-Suite)'];
check('A BROKEN SOURCE DEGRADES THE REPORT INSTEAD OF KILLING THE RUN',
  softFail.every((n) => byName[n].onError === 'continueRegularOutput'),
  softFail.filter((n) => byName[n].onError !== 'continueRegularOutput').join(', '));
check('...and always emits an item, so an empty tab cannot stall the chain',
  softFail.every((n) => byName[n].alwaysOutputData === true));
check('every network node retries',
  [...softFail, 'Email Weekly Report', 'Append Report History']
    .every((n) => byName[n].retryOnFail === true));
check('the history append cannot break a report that already went out',
  byName['Append Report History'].onError === 'continueRegularOutput');
check('the aggregator distinguishes "no revenue" from "revenue unknown"',
  byName['Aggregate & Calculate'].parameters.jsCode.includes('revenueAvailable'));
check('no node carries pinned data (stale fixtures read as real numbers)',
  Object.keys(wf.pinData || {}).length === 0, Object.keys(wf.pinData || {}).join(', '));

console.log('\nREVENUE PATH');
const sql = byName['Fetch Revenue (E-Suite)'];
const normCode = byName['Normalise Tracker Rows'].parameters.jsCode;
check('the SQL node executes a query', sql.parameters.operation === 'executeQuery');
check('THE QUERY IS BUILT IN CODE, WHERE THE ACCOUNT LIST CAN BE VALIDATED FIRST',
  sql.parameters.query === '={{ $json.revenueQuery }}', sql.parameters.query);
check('account numbers are whitelisted before they reach the IN() clause',
  normCode.includes('accountPattern') && normCode.includes('rejectedAccounts'));
check('a week with no conversions still sends a valid query',
  normCode.includes('SELECT TOP 0'));
check('there is a ceiling on how many accounts one run will query',
  normCode.includes('maxAccounts'));
check('the aggregator caps attribution by time',
  byName['Aggregate & Calculate'].parameters.jsCode.includes('attributionMs'));
check('...and credits each transaction to exactly one flow',
  byName['Aggregate & Calculate'].parameters.jsCode.includes('claim.set'));

console.log('\nDELIVERY');
const mail = byName['Email Weekly Report'];
check('the email is HTML', mail.parameters.emailType === 'html');
check('THE EMAIL READS SUBJECT AND BODY BY NODE NAME, so enabling the PDF node cannot break it',
  String(mail.parameters.subject).includes("$('Render HTML Report')")
  && String(mail.parameters.message).includes("$('Render HTML Report')"));
check('the report is attached as well as inlined',
  JSON.stringify(mail.parameters.options.attachmentsUi || {}).includes('"property":"data"'));
check('the attachment is built from the html property',
  byName['Report to HTML File'].parameters.sourceProperty === 'html');
check('...as text/html, so it opens in a browser',
  byName['Report to HTML File'].parameters.options.mimeType === 'text/html');
check('the PDF node ships disabled (n8n has no native HTML-to-PDF)',
  byName['Render PDF (optional)'].disabled === true);
check('...and passes data straight through while disabled',
  out('Render PDF (optional)').includes('Email Weekly Report'));

console.log('\nCREDENTIALS');
const creds = wf.nodes.filter((n) => n.credentials);
check('every node that talks to a service has a credential attached',
  [...sheets.map((n) => n.name), 'Fetch Revenue (E-Suite)', 'Email Weekly Report', 'Alert on Failure']
    .every((n) => byName[n].credentials));
check('all Sheets nodes share one credential',
  new Set(sheets.map((n) => n.credentials.googleSheetsOAuth2Api.name)).size === 1);
check('both Gmail nodes share one credential',
  new Set(['Email Weekly Report', 'Alert on Failure']
    .map((n) => byName[n].credentials.gmailOAuth2.name)).size === 1);
const placeholders = creds
  .flatMap((n) => Object.values(n.credentials).map((c) => ({ node: n.name, id: c.id })))
  .filter((c) => String(c.id).startsWith('REPLACE_'));
check(`placeholder credentials are obvious, not plausible-looking ids (${placeholders.length} to set)`,
  placeholders.every((c) => /^REPLACE_[A-Z_]+$/.test(c.id)),
  placeholders.map((c) => `${c.node}=${c.id}`).join(', '));
check('...and the setup note tells the operator to replace them',
  wf.nodes.some((n) => n.type === 'n8n-nodes-base.stickyNote'
    && /Credentials/.test(n.parameters.content)));

console.log('\nEXPRESSIONS');
const refs = new Set();
for (const n of wf.nodes) {
  for (const m of JSON.stringify(n.parameters).matchAll(/\$\('([^']+)'\)/g)) refs.add(m[1]);
}
check("every $('node') reference resolves to a real node",
  [...refs].every((r) => byName[r]), [...refs].filter((r) => !byName[r]).join(', '));
check('the workflow ships inactive, so importing it cannot email anyone by surprise',
  wf.active === false);

console.log(`\n  ${failed ? failed + ' check(s) FAILED' : 'all checks passed'}\n`);
process.exit(failed ? 1 : 0);
