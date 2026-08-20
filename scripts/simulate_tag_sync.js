// ============================================================
// Offline simulation of the Mailchimp tag sync.
//
// Implements the semantics of POST /lists/{id}/members/{hash}/tags
// (status "active" = add, status "inactive" = remove, removing a tag the
// member does not have is a no-op) and replays both the OLD add-only
// workflow and the NEW remove-then-add workflow against the same seeded
// audience, so the two can be compared on identical dummy data.
//
//   node scripts/simulate_tag_sync.js
// ============================================================

const fs = require('fs');
const path = require('path');

const buildTagOpsSrc = fs.readFileSync(path.join(__dirname, 'build_tag_ops.js'), 'utf8');
const buildTagOps = (items) =>
  new Function('$input', buildTagOpsSrc)({ all: () => items.map((json) => ({ json })) });

// ---------- fake Mailchimp audience ----------
class FakeMailchimp {
  constructor(seed) {
    this.members = new Map();
    for (const [email, tags] of Object.entries(seed)) this.members.set(email, new Set(tags));
    this.calls = 0;
    this.errors = [];
  }
  // mirrors the n8n Mailchimp node: body.tags = [{ name, status }]
  postTags(email, body) {
    this.calls++;
    const member = this.members.get(email);
    if (!member) {
      const err = new Error(`404 The requested resource could not be found (${email})`);
      this.errors.push(err.message);
      throw err;
    }
    for (const { name, status } of body.tags) {
      if (status === 'active') member.add(name);
      else member.delete(name); // no-op when absent, like the real API
    }
  }
  tagsOf(email) {
    return [...(this.members.get(email) || [])];
  }
}

const nodeCall = (mc, operation, email, tags) => {
  const body = { tags: tags.map((t) => ({ name: t, status: operation === 'create' ? 'active' : 'inactive' })) };
  try {
    mc.postTags(email, body);
  } catch (e) {
    // both nodes are onError: continueRegularOutput
  }
};

// ---------- workflow replays ----------
// OLD: Expand Tags -> one memberTag:create call per tag
function runOld(items, mc) {
  for (const it of items) {
    const tags = Array.isArray(it.tags) ? it.tags : [it.tagName];
    for (const t of tags) nodeCall(mc, 'create', it.email.toLowerCase().trim(), [t]);
  }
}

// NEW: Build Tag Ops -> loop(1) -> IF hasRemovals -> delete -> create
function runNew(items, mc) {
  for (const { json: op } of buildTagOps(items)) {
    if (op.hasRemovals) nodeCall(mc, 'delete', op.email, op.tagsToRemove); // remove first
    nodeCall(mc, 'create', op.email, op.tagsToAdd); // then add
  }
}

// ---------- dummy data ----------
// Audience as it looks today, after months of add-only syncs.
const SEED = {
  'pakenham@mrfurniture.com.au': ['VIC', 'Regional', 'Furniture', 'Inactive', 'Tier C', 'VIP'],
  'buyer@giftco.com.au':         ['NSW', 'Metro', 'Gift & Homewares', 'Active', 'Inactive', 'Tier B', 'Tier C'],
  'moved@example.com.au':        ['NSW', 'Metro', 'Furniture', 'Active', 'Tier B'],
  'team@duranttechnologies.com': ['VIC', 'Metro', 'Furniture', 'Active', 'Tier C'],
  'reclassified@example.com':    ['QLD', 'Regional', 'Other', 'Active', 'Tier C', 'Trade Show 2025'],
  // ghost@example.com is deliberately absent from the audience
};

// What this week's run sends (legacy per-tag shape, exactly what Mailchimp sync emits today)
const expand = (email, tags) => tags.map((t) => ({ email, tagName: t }));

const THIS_RUN = [
  // placed an order -> Inactive must go
  ...expand('pakenham@mrfurniture.com.au', ['VIC', 'Regional', 'Furniture', 'Active', 'Tier C']),
  // already double-tagged; also moved up a tier
  ...expand('buyer@giftco.com.au', ['NSW', 'Metro', 'Gift & Homewares', 'Active', 'Tier A']),
  // interstate move NSW/Metro -> VIC/Regional
  ...expand('moved@example.com.au', ['VIC', 'Regional', 'Furniture', 'Active', 'Tier B']),
  // Shopify abandoned cart run for an existing E-Suite customer
  ...expand('team@duranttechnologies.com', ['Abandoned Cart', 'Shopify']),
  // business type reclassified Other -> Manchester
  ...expand('reclassified@example.com', ['QLD', 'Regional', 'Manchester', 'Active', 'Tier C']),
  // member that does not exist in Mailchimp
  ...expand('ghost@example.com', ['NSW', 'Metro', 'Other', 'Active', 'Tier C']),
];

const GROUPS = {
  activity: ['Active', 'Inactive'],
  spendTier: ['Tier A', 'Tier B', 'Tier C'],
  geo: ['Metro', 'Regional'],
  state: ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'],
  businessType: ['Gift & Homewares', 'Furniture', 'Manchester', 'Interior Stylist', 'Other'],
};

const conflictsFor = (tags) =>
  Object.entries(GROUPS)
    .map(([g, values]) => [g, values.filter((v) => tags.includes(v))])
    .filter(([, present]) => present.length > 1);

// ---------- run both ----------
function report(label, runner) {
  const mc = new FakeMailchimp(JSON.parse(JSON.stringify(
    Object.fromEntries(Object.entries(SEED).map(([k, v]) => [k, [...v]])))));
  runner(THIS_RUN, mc);

  console.log('\n' + '='.repeat(78));
  console.log(label);
  console.log('='.repeat(78));

  let bad = 0;
  for (const email of Object.keys(SEED)) {
    const after = mc.tagsOf(email).sort();
    const conflicts = conflictsFor(after);
    if (conflicts.length) bad++;
    console.log(`\n${email}`);
    console.log(`  before : ${SEED[email].slice().sort().join(', ')}`);
    console.log(`  after  : ${after.join(', ')}`);
    if (conflicts.length) {
      for (const [g, present] of conflicts) console.log(`  CONFLICT ${g}: ${present.join(' + ')}`);
    }
  }
  console.log(`\n  API calls: ${mc.calls}   members with conflicting tags: ${bad}` +
              `   404s handled: ${mc.errors.length}`);
  return { mc, bad };
}

const oldRun = report('BEFORE — current workflow (memberTag: create only)', runOld);
const newRun = report('AFTER — patched workflow (remove stale, then add)', runNew);

// ---------- assertions ----------
console.log('\n' + '='.repeat(78));
console.log('ASSERTIONS');
console.log('='.repeat(78));

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push(pass);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

check('bug reproduces on the old workflow', oldRun.bad > 0, `${oldRun.bad} members left with conflicting tags`);
check('no conflicting tags after the patch', newRun.bad === 0);

const t = (e) => newRun.mc.tagsOf(e);
check('Inactive removed when customer becomes Active',
  t('pakenham@mrfurniture.com.au').includes('Active') && !t('pakenham@mrfurniture.com.au').includes('Inactive'));
check('manual tag VIP survives', t('pakenham@mrfurniture.com.au').includes('VIP'));
check('pre-existing double tag is repaired',
  t('buyer@giftco.com.au').filter((x) => x.startsWith('Tier')).length === 1 &&
  t('buyer@giftco.com.au').includes('Tier A'));
check('interstate move clears the old state',
  t('moved@example.com.au').includes('VIC') && !t('moved@example.com.au').includes('NSW') &&
  t('moved@example.com.au').includes('Regional') && !t('moved@example.com.au').includes('Metro'));
check('abandoned-cart run does not strip segmentation',
  ['VIC', 'Metro', 'Furniture', 'Active', 'Tier C', 'Abandoned Cart', 'Shopify']
    .every((x) => t('team@duranttechnologies.com').includes(x)));
check('reclassified business type replaces the old one',
  t('reclassified@example.com').includes('Manchester') && !t('reclassified@example.com').includes('Other'));
check('unrelated campaign tag survives', t('reclassified@example.com').includes('Trade Show 2025'));
check('missing member 404s without breaking the batch', newRun.mc.errors.length > 0);
check('every member still carries an activity tag',
  Object.keys(SEED).every((e) => GROUPS.activity.some((v) => t(e).includes(v))));
check('fewer API calls than before', newRun.mc.calls < oldRun.mc.calls,
  `${oldRun.mc.calls} -> ${newRun.mc.calls}`);

const failed = checks.filter((c) => !c).length;
console.log(`\n  ${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
