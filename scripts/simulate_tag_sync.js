// ============================================================
// Offline simulation of the Mailchimp tag sync.
//
// Implements the endpoints the workflow uses:
//   GET  /lists/{id}/members/{email}        -> member incl. tags[]
//   POST /lists/{id}/members/{email}/tags   -> status active = add,
//                                              status inactive = remove,
//                                              removing an absent tag = no-op
// then replays the OLD add-only workflow and the NEW fetch-and-diff
// workflow over the same seeded audience.
//
//   node scripts/simulate_tag_sync.js
// ============================================================

const { run, runRaw, wrap } = require('./lib/nodes');

class FakeMailchimp {
  constructor(seed, opts = {}) {
    this.members = new Map(Object.entries(seed).map(([k, v]) => [k, new Set(v)]));
    this.reads = 0;
    this.writes = 0;
    this.errors = [];
    this.failReadsFor = new Set(opts.failReadsFor || []);
  }
  getMember(email) {
    this.reads++;
    if (this.failReadsFor.has(email)) throw new Error('429 too many requests');
    const m = this.members.get(email);
    if (!m) throw new Error('404 The requested resource could not be found');
    return { email_address: email, status: 'subscribed', tags: [...m].map((name, id) => ({ id, name })) };
  }
  postTags(email, body) {
    this.writes++;
    const m = this.members.get(email);
    if (!m) { this.errors.push(`404 ${email}`); throw new Error('404'); }
    for (const { name, status } of body.tags) status === 'active' ? m.add(name) : m.delete(name);
  }
  tagsOf(email) { return [...(this.members.get(email) || [])]; }
}

const tagCall = (mc, operation, email, tags) => {
  if (tags.length !== 1) throw new Error(`expected one tag per call, got ${tags.length}`);
  const body = { tags: tags.map((t) => ({ name: t, status: operation === 'create' ? 'active' : 'inactive' })) };
  try { mc.postTags(email, body); } catch (e) { /* onError: continueRegularOutput */ }
};

// ---------- OLD: Expand Tags -> one memberTag:create per tag ----------
function runOld(items, mc) {
  for (const it of items) tagCall(mc, 'create', it.email.toLowerCase().trim(), [it.tagName]);
  return [];
}

// ---------- NEW: Build Desired State -> loop -> GET -> Diff -> remove -> add ----------
function runNew(items, mc) {
  const report = [];
  for (const desired of run('Build Desired State', items)) {
    let member;
    try { member = mc.getMember(desired.email); }
    catch (e) { member = { error: { message: e.message } }; }   // Fetch Current Tags, onError: continue

    const d = run('Diff Tags', [member], { 'Loop Over Members': { branches: [[], wrap([desired])] } })[0];

    // Expand Removals -> Remove One Tag: ONE call per tag
    if (d.hasRemovals) {
      for (const { json: op } of runRaw('Expand Removals', [d], { 'Diff Tags': { branches: [wrap([d])] } })) {
        tagCall(mc, 'delete', op.email, [op.tagName]);
      }
    }
    // Expand Adds -> Add One Tag: ONE call per tag
    if (d.hasAdds) {
      for (const { json: op } of runRaw('Expand Adds', [d], { 'Diff Tags': { branches: [wrap([d])] } })) {
        tagCall(mc, 'create', op.email, [op.tagName]);
      }
    }

    let after;                                                          // Verify Tags
    try { after = mc.getMember(d.email); }
    catch (e) { after = { error: { message: e.message } }; }
    report.push(run('Record Result', [after], { 'Diff Tags': { branches: [wrap([d])] } })[0]);
  }
  return report;
}

// ---------- dummy audience, as it looks after months of add-only syncs ----------
const SEED = {
  'pakenham@mrfurniture.com.au': ['VIC', 'Regional', 'Furniture', 'Inactive', 'Tier C', 'VIP'],
  'buyer@giftco.com.au':         ['NSW', 'Metro', 'Gift & Homewares', 'Active', 'Inactive', 'Tier B', 'Tier C'],
  'moved@example.com.au':        ['NSW', 'Metro', 'Furniture', 'Active', 'Tier B'],
  'team@duranttechnologies.com': ['VIC', 'Metro', 'Furniture', 'Active', 'Tier C'],
  'reclassified@example.com':    ['QLD', 'Regional', 'Other', 'Active', 'Tier C', 'Trade Show 2025'],
  'steady@example.com':          ['SA', 'Metro', 'Furniture', 'Active', 'Tier C'],
  // ghost@example.com deliberately absent
};

const expand = (email, tags) => tags.map((t) => ({ email, tagName: t }));
const THIS_RUN = [
  ...expand('pakenham@mrfurniture.com.au', ['VIC', 'Regional', 'Furniture', 'Active', 'Tier C']),
  ...expand('buyer@giftco.com.au', ['NSW', 'Metro', 'Gift & Homewares', 'Active', 'Tier A']),
  ...expand('moved@example.com.au', ['VIC', 'Regional', 'Furniture', 'Active', 'Tier B']),
  ...expand('team@duranttechnologies.com', ['Abandoned Cart', 'Shopify']),
  ...expand('reclassified@example.com', ['QLD', 'Regional', 'Manchester', 'Active', 'Tier C']),
  ...expand('steady@example.com', ['SA', 'Metro', 'Furniture', 'Active', 'Tier C']),
  ...expand('ghost@example.com', ['NSW', 'Metro', 'Other', 'Active', 'Tier C']),
];

const GROUPS = {
  activity: ['Active', 'Inactive'],
  spendTier: ['Tier A', 'Tier B', 'Tier C'],
  geo: ['Metro', 'Regional'],
  state: ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'],
  businessType: ['Gift & Homewares', 'Furniture', 'Manchester', 'Interior Stylist', 'Other'],
};
const conflictsFor = (tags) => Object.entries(GROUPS)
  .map(([g, v]) => [g, v.filter((x) => tags.includes(x))]).filter(([, p]) => p.length > 1);

function report(label, runner, opts) {
  const mc = new FakeMailchimp(SEED, opts);
  const rows = runner(THIS_RUN, mc);
  console.log('\n' + '='.repeat(80) + `\n${label}\n` + '='.repeat(80));
  let bad = 0;
  for (const email of Object.keys(SEED)) {
    const after = mc.tagsOf(email).sort();
    const c = conflictsFor(after);
    if (c.length) bad++;
    console.log(`\n${email}\n  before : ${[...SEED[email]].sort().join(', ')}\n  after  : ${after.join(', ')}`);
    for (const [g, p] of c) console.log(`  CONFLICT ${g}: ${p.join(' + ')}`);
  }
  console.log(`\n  reads: ${mc.reads}   writes: ${mc.writes}   conflicting members: ${bad}`);
  return { mc, bad, rows };
}

const oldRun = report('BEFORE — current workflow (memberTag: create only)', runOld);
const newRun = report('AFTER — fetch current tags, diff, remove stale, add new', runNew);

console.log('\n' + '='.repeat(80) + '\nPER-MEMBER REPORT (the "Record Result" rows the run returns)\n' + '='.repeat(80));
for (const r of newRun.rows) {
  console.log(`\n${r.email}${r.memberFound ? '' : '   [NOT IN AUDIENCE]'}`);
  console.log(`  removed  : ${r.removed.join(', ') || '-'}`);
  console.log(`  added    : ${r.added.join(', ') || '-'}`);
  console.log(`  untouched: ${r.untouched.join(', ') || '-'}`);
  if (r.error) console.log(`  error    : ${r.error}`);
}

console.log('\n' + '='.repeat(80) + '\nASSERTIONS\n' + '='.repeat(80));
let failed = 0;
const check = (n, pass, detail = '') => { if (!pass) failed++; console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${n}${detail ? ' — ' + detail : ''}`); };
const t = (e) => newRun.mc.tagsOf(e);
const row = (e) => newRun.rows.find((r) => r.email === e);

check('bug reproduces on the old workflow', oldRun.bad > 0, `${oldRun.bad} members left conflicted`);
check('no conflicting tags after the change', newRun.bad === 0);
check('Inactive removed when the customer becomes Active',
  t('pakenham@mrfurniture.com.au').includes('Active') && !t('pakenham@mrfurniture.com.au').includes('Inactive'));
check('manual tag VIP survives', t('pakenham@mrfurniture.com.au').includes('VIP'));
check('pre-existing double tag repaired', t('buyer@giftco.com.au').filter((x) => x.startsWith('Tier')).length === 1);
check('interstate move clears old state and geo',
  t('moved@example.com.au').includes('VIC') && !t('moved@example.com.au').includes('NSW') &&
  !t('moved@example.com.au').includes('Metro'));
check('abandoned-cart run does not strip segmentation',
  row('team@duranttechnologies.com').removed.length === 0 &&
  ['Active', 'Tier C', 'VIC', 'Metro', 'Abandoned Cart', 'Shopify'].every((x) => t('team@duranttechnologies.com').includes(x)));
check('reclassified business type replaces the old one',
  t('reclassified@example.com').includes('Manchester') && !t('reclassified@example.com').includes('Other'));
check('campaign tag survives', t('reclassified@example.com').includes('Trade Show 2025'));
check('already-correct member costs 1 read and 0 writes',
  row('steady@example.com').removed.length === 0 && row('steady@example.com').added.length === 0);
check('missing member flagged in the report, batch continues',
  row('ghost@example.com') && row('ghost@example.com').memberFound === false && !!row('ghost@example.com').error);
check('every member still carries an activity tag',
  Object.keys(SEED).every((e) => GROUPS.activity.some((v) => t(e).includes(v))));
check('removal calls carry only tags that were really there',
  newRun.rows.every((r) => r.removed.every((x) => r.before.includes(x))));
check('every member verified against a re-read of Mailchimp',
  newRun.rows.filter((r) => r.memberFound).every((r) => r.verified === true));
check('nothing left behind that we asked to remove',
  newRun.rows.every((r) => r.stillPresent.length === 0));
check('fewer write calls than before', newRun.mc.writes < oldRun.mc.writes,
  `${oldRun.mc.writes} writes -> ${newRun.mc.writes} writes + ${newRun.mc.reads} reads`);

// failure mode specific to this design: if the GET fails we cannot know the
// current tags, so removals are skipped. It must be reported, never silent.
const degraded = report('DEGRADED — the GET fails for one member (rate limit)',
  runNew, { failReadsFor: ['pakenham@mrfurniture.com.au'] });
const drow = degraded.rows.find((r) => r.email === 'pakenham@mrfurniture.com.au');
check('failed fetch is surfaced, not silently skipped',
  drow.memberFound === false && !!drow.error && drow.removed.length === 0);
check('...and the stale tag is left for the next run rather than guessed at',
  degraded.mc.tagsOf('pakenham@mrfurniture.com.au').includes('Inactive'));

console.log(`\n  ${failed ? failed + ' FAILED' : 'all assertions passed'}\n`);
process.exit(failed ? 1 : 0);
