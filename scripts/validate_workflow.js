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
check('stale true (0) -> Remove Stale Tags', out('Has Stale Tags?', 0).includes('Remove Stale Tags'));
check('stale false (1) skips straight to Has New Tags?', out('Has Stale Tags?', 1).includes('Has New Tags?'));
check('REMOVE RUNS BEFORE ADD', out('Remove Stale Tags', 0).includes('Has New Tags?'));
check('new true (0) -> Add New Tags', out('Has New Tags?', 0).includes('Add New Tags'));
check('new false (1) still verifies', out('Has New Tags?', 1).includes('Verify Tags'));
check('Add New Tags -> Verify Tags', out('Add New Tags', 0).includes('Verify Tags'));
check('VERIFY RUNS AFTER THE WRITES', out('Verify Tags', 0).includes('Record Result'));
check('Record Result closes the loop', out('Record Result', 0).includes('Loop Over Members'));
check('error trigger -> Gmail', out('Error Trigger', 0).includes('Send a message'));

console.log('\nNODE CONFIG');
const fetch = byName['Fetch Current Tags'];
const rm = byName['Remove Stale Tags'];
const add = byName['Add New Tags'];
const verify = byName['Verify Tags'];
check('fetch node reads the member (GET /members/{email})',
  fetch.parameters.resource === 'member' && fetch.parameters.operation === 'get');
check('fetch asks for the tags field', String(fetch.parameters.options.fields).includes('tags'));
check('fetch always outputs data so a 404 cannot stall the chain', fetch.alwaysOutputData === true);
check('remove uses memberTag:delete (status inactive)',
  rm.parameters.resource === 'memberTag' && rm.parameters.operation === 'delete');
check('add uses memberTag:create (node default = status active)',
  add.parameters.resource === 'memberTag' && !add.parameters.operation);
check('ALL FOUR NODES TARGET THE SAME AUDIENCE',
  new Set([fetch, rm, add, verify].map((n) => n.parameters.list)).size === 1,
  [...new Set([fetch, rm, add, verify].map((n) => n.parameters.list))].join(' vs '));
check('verify node is off by default (no extra API calls)', verify.disabled === true);
check('ALL FOUR NODES USE THE SAME CREDENTIAL',
  new Set([fetch, rm, add, verify].map((n) => n.credentials.mailchimpApi.name)).size === 1,
  [...new Set([fetch, rm, add, verify].map((n) => n.credentials.mailchimpApi.name))].join(' vs '));
check('all four carry the Mailchimp credential',
  [fetch, rm, add, verify].every((n) => !!(n.credentials || {}).mailchimpApi));
check('all four retry on failure', [fetch, rm, add, verify].every((n) => n.retryOnFail === true));
check('no node carries pinned data (stale test data reads as real state)',
  !Object.keys(wf.pinData || {}).some((k) => k !== 'When Executed by Another Workflow'),
  Object.keys(wf.pinData || {}).join(', '));
check('all four continue on error', [fetch, rm, add, verify].every((n) => n.onError === 'continueRegularOutput'));
check('verify re-reads the member', verify.parameters.resource === 'member' && verify.parameters.operation === 'get');
check('Record Result asserts against the re-read',
  byName['Record Result'].parameters.jsCode.includes('stillPresent'));
check('loop batch size is 1', byName['Loop Over Members'].parameters.batchSize === 1);

console.log('\nEXPRESSIONS');
check('remove reads the diff item directly',
  rm.parameters.tags === '={{ $json.tagsToRemove }}' && rm.parameters.email === '={{ $json.email }}');
// after a failed remove the item on the wire is an error object with no tags
check('add does NOT read $json (immune to a failed remove)',
  !add.parameters.tags.includes('$json.') && !add.parameters.email.includes('$json.'));
// A multi-value field bound to an array expression must be stored as a BARE
// string. If the n8n UI rewraps it as ["={{ ... }}"], the node sends
// { name: ["Tier B","Inactive"] } and Mailchimp answers 400 Bad Request.
check('remove tags param is a bare expression, not a wrapped list entry',
  typeof rm.parameters.tags === 'string', JSON.stringify(rm.parameters.tags));
check('add tags param is a bare expression, not a wrapped list entry',
  typeof add.parameters.tags === 'string', JSON.stringify(add.parameters.tags));
check('add reads back from Diff Tags',
  add.parameters.tags === "={{ $('Diff Tags').first(0).json.tagsToAdd }}");
check('second IF also reads back from Diff Tags',
  byName['Has New Tags?'].parameters.conditions.conditions[0].leftValue === "={{ $('Diff Tags').first(0).json.hasAdds }}");
check('diff reads the desired state from the loop branch (1)',
  byName['Diff Tags'].parameters.jsCode.includes("$('Loop Over Members').first(1)"));

const refs = new Set();
for (const n of wf.nodes) for (const m of JSON.stringify(n.parameters).matchAll(/\$\('([^']+)'\)/g)) refs.add(m[1]);
check("every $('node') reference resolves", [...refs].every((r) => byName[r]), [...refs].join(', '));

console.log(`\n  ${failed ? failed + ' check(s) FAILED' : 'all checks passed'}\n`);
process.exit(failed ? 1 : 0);
