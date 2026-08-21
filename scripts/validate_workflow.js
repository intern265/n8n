// Structural checks on workflows/mailchimp_tags_update.json — the things the
// logic tests cannot cover: wiring, branch indices, node operations, expressions.
//   node scripts/validate_workflow.js
const { workflow: wf } = require('./lib/nodes');

const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const out = (from, i) => ((wf.connections[from] || {}).main || [])[i]?.map((c) => c.node) || [];

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('\nWIRING');
const dangling = [];
for (const [from, spec] of Object.entries(wf.connections)) {
  if (!byName[from]) dangling.push(from);
  for (const branch of spec.main || []) for (const c of branch) if (!byName[c.node]) dangling.push(c.node);
}
check('no dangling connections', dangling.length === 0, dangling.join(', '));
check('trigger -> Build Desired State', out('When Executed by Another Workflow', 0).includes('Build Desired State'));
check('Build Desired State -> loop', out('Build Desired State', 0).includes('Loop Over Members'));
// splitInBatches v3: branch 0 = done, branch 1 = loop
check('loop done (0) -> summary', out('Loop Over Members', 0).includes('Return Tag Sync Summary'));
check('loop body (1) -> Fetch Current Tags', out('Loop Over Members', 1).includes('Fetch Current Tags'));
check('FETCH RUNS BEFORE THE DIFF', out('Fetch Current Tags', 0).includes('Diff Tags'));
check('Diff Tags -> Has Stale Tags?', out('Diff Tags', 0).includes('Has Stale Tags?'));
check('stale true (0) -> Expand Removals', out('Has Stale Tags?', 0).includes('Expand Removals'));
check('stale false (1) skips to Has New Tags?', out('Has Stale Tags?', 1).includes('Has New Tags?'));
check('Expand Removals -> Remove One Tag', out('Expand Removals', 0).includes('Remove One Tag'));
check('ALL REMOVALS COMPLETE BEFORE ANY ADD', out('Remove One Tag', 0).includes('Has New Tags?'));
check('new true (0) -> Expand Adds', out('Has New Tags?', 0).includes('Expand Adds'));
check('new false (1) skips the add', out('Has New Tags?', 1).includes('Verify Tags'));
check('Expand Adds -> Add One Tag', out('Expand Adds', 0).includes('Add One Tag'));
check('Add One Tag -> Verify Tags', out('Add One Tag', 0).includes('Verify Tags'));
check('Verify Tags -> Record Result', out('Verify Tags', 0).includes('Record Result'));
check('Record Result closes the loop', out('Record Result', 0).includes('Loop Over Members'));
check('error trigger -> Gmail', out('Error Trigger', 0).includes('Send a message'));
check('no nested splitInBatches', wf.nodes.filter((n) => n.type.endsWith('splitInBatches')).length === 1);

console.log('\nONE CALL PER TAG');
const rm = byName['Remove One Tag'];
const add = byName['Add One Tag'];
for (const n of [rm, add]) {
  check(`${n.name}: tags is a single-entry list, not an array expression`,
    Array.isArray(n.parameters.tags) && n.parameters.tags.length === 1,
    JSON.stringify(n.parameters.tags));
  check(`${n.name}: that entry is a plain per-item tag name`,
    n.parameters.tags[0] === '={{ $json.tagName }}');
  check(`${n.name}: email comes from the same item`, n.parameters.email === '={{ $json.email }}');
}
for (const name of ['Expand Removals', 'Expand Adds']) {
  check(`${name} reads from Diff Tags, not its own input`,
    byName[name].parameters.jsCode.includes("$('Diff Tags').first(0)"));
  check(`${name} emits one item per tag`,
    /\.map\(\(tagName\) => \(\{/.test(byName[name].parameters.jsCode));
}

console.log('\nNODE CONFIG');
const fetch = byName['Fetch Current Tags'];
const verify = byName['Verify Tags'];
const all = [fetch, rm, add, verify];
check('fetch reads the member (GET /members/{email})',
  fetch.parameters.resource === 'member' && fetch.parameters.operation === 'get');
check('fetch asks for tags and list_id', String(fetch.parameters.options.fields).includes('tags'));
check('fetch always outputs data so a 404 cannot stall the chain', fetch.alwaysOutputData !== false);
check('remove uses memberTag:delete (status inactive)',
  rm.parameters.resource === 'memberTag' && rm.parameters.operation === 'delete');
check('add uses memberTag:create (node default = status active)',
  add.parameters.resource === 'memberTag' && !add.parameters.operation);
check('ALL FOUR NODES TARGET THE SAME AUDIENCE',
  new Set(all.map((n) => n.parameters.list)).size === 1,
  [...new Set(all.map((n) => n.parameters.list))].join(' vs '));
check('ALL FOUR NODES USE THE SAME CREDENTIAL',
  new Set(all.map((n) => n.credentials.mailchimpApi.name)).size === 1,
  [...new Set(all.map((n) => n.credentials.mailchimpApi.name))].join(' vs '));
check('all four retry on failure', all.every((n) => n.retryOnFail === true));
check('all four continue on error', all.every((n) => n.onError === 'continueRegularOutput'));
check('verify node is off by default (no extra API calls)', verify.disabled === true);
check('loop batch size is 1', byName['Loop Over Members'].parameters.batchSize === 1);
check('no node carries pinned data (stale test data reads as real state)',
  !Object.keys(wf.pinData || {}).some((k) => k !== 'When Executed by Another Workflow'),
  Object.keys(wf.pinData || {}).join(', '));

console.log('\nEXPRESSIONS');
check('the audience guard names the live node names',
  ['Fetch Current Tags', 'Remove One Tag', 'Add One Tag']
    .every((n) => byName['Diff Tags'].parameters.jsCode.includes(`'${n}'`)));
check('diff reads the desired state from the loop branch (1)',
  byName['Diff Tags'].parameters.jsCode.includes("$('Loop Over Members').first(1)"));
const refs = new Set();
for (const n of wf.nodes) for (const m of JSON.stringify(n.parameters).matchAll(/\$\('([^']+)'\)/g)) refs.add(m[1]);
check("every $('node') reference resolves", [...refs].every((r) => byName[r]), [...refs].join(', '));

console.log(`\n  ${failed ? failed + ' check(s) FAILED' : 'all checks passed'}\n`);
process.exit(failed ? 1 : 0);
