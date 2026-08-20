// Structural checks on workflows/mailchimp_tags_update.json — the things the
// logic simulation cannot cover: node wiring, branch indices, node operations
// and expression references.
//
//   node scripts/validate_workflow.js

const fs = require('fs');
const path = require('path');
const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'mailchimp_tags_update.json'), 'utf8'));

const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const conns = wf.connections;
const out = (from, i) => (conns[from]?.main?.[i] || []).map((c) => c.node);

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

console.log('\nWIRING');
// every connection endpoint must exist
const dangling = [];
for (const [from, spec] of Object.entries(conns)) {
  if (!byName[from]) dangling.push(from);
  for (const branch of spec.main || []) for (const c of branch) if (!byName[c.node]) dangling.push(c.node);
}
check('no dangling connections', dangling.length === 0, dangling.join(', '));

check('trigger feeds Build Tag Ops', out('When Executed by Another Workflow', 0).includes('Build Tag Ops'));
check('Build Tag Ops feeds the loop', out('Build Tag Ops', 0).includes('Loop Over Items'));
// splitInBatches v3: output 0 = done, output 1 = loop
check('loop "done" branch (0) -> summary', out('Loop Over Items', 0).includes('Return Tag Sync Summary'));
check('loop "loop" branch (1) -> IF', out('Loop Over Items', 1).includes('Has Stale Tags?'));
check('IF true (0) -> Remove Stale Tags', out('Has Stale Tags?', 0).includes('Remove Stale Tags'));
check('IF false (1) -> Add Current Tags', out('Has Stale Tags?', 1).includes('Add Current Tags'));
check('REMOVE RUNS BEFORE ADD', out('Remove Stale Tags', 0).includes('Add Current Tags'));
check('remove never returns straight to the loop', !out('Remove Stale Tags', 0).includes('Loop Over Items'));
check('add closes the loop', out('Add Current Tags', 0).includes('Loop Over Items'));
check('error trigger wired to Gmail', out('Error Trigger', 0).includes('Send a message'));

console.log('\nNODE CONFIG');
const rm = byName['Remove Stale Tags'];
const add = byName['Add Current Tags'];
check('remove node uses memberTag:delete (status inactive)',
  rm.parameters.resource === 'memberTag' && rm.parameters.operation === 'delete');
check('add node uses memberTag:create (node default = status active)',
  add.parameters.resource === 'memberTag' && !add.parameters.operation);
check('both target the same audience',
  rm.parameters.list === add.parameters.list, rm.parameters.list);
check('both carry the Mailchimp credential',
  !!rm.credentials?.mailchimpApi && !!add.credentials?.mailchimpApi);
check('both retry on failure', rm.retryOnFail === true && add.retryOnFail === true);
check('both continue on error so one bad member cannot kill the batch',
  rm.onError === 'continueRegularOutput' && add.onError === 'continueRegularOutput');
check('loop batch size is 1', byName['Loop Over Items'].parameters.batchSize === 1);
check('IF tests hasRemovals is true',
  byName['Has Stale Tags?'].parameters.conditions.conditions[0].leftValue === '={{ $json.hasRemovals }}' &&
  byName['Has Stale Tags?'].parameters.conditions.conditions[0].operator.operation === 'true');

console.log('\nEXPRESSIONS');
check('remove reads tagsToRemove from the current item',
  rm.parameters.tags === '={{ $json.tagsToRemove }}' && rm.parameters.email === '={{ $json.email }}');
// the add node must not read $json: after a failed remove that item is an error object
check('add does NOT read $json (immune to a failed remove)',
  !add.parameters.tags.includes('$json.') && !add.parameters.email.includes('$json.'));
check('add reads branch 1 (the loop output) of Loop Over Items',
  add.parameters.tags === "={{ $('Loop Over Items').first(1).json.tagsToAdd }}" &&
  add.parameters.email === "={{ $('Loop Over Items').first(1).json.email }}");

const refs = new Set();
for (const n of wf.nodes) {
  const s = JSON.stringify(n.parameters);
  for (const m of s.matchAll(/\$\('([^']+)'\)/g)) refs.add(m[1]);
}
check('every $(\'node\') reference resolves', [...refs].every((r) => byName[r]), [...refs].join(', '));

console.log(`\n  ${failed ? failed + ' check(s) FAILED' : 'all checks passed'}\n`);
process.exit(failed ? 1 : 0);
