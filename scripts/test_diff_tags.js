// Unit tests for the two Code nodes that decide the tag operations.
//   node scripts/test_diff_tags.js
const { run, wrap } = require('./lib/nodes');

let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// helper: run Build Desired State then Diff Tags for one member
const diff = (incoming, currentTags, opts = {}) => {
  const desired = run('Build Desired State', incoming)[0];
  const member = opts.notFound
    ? { error: { message: '404 The requested resource could not be found' } }
    : { email_address: desired.email, status: 'subscribed', tags: currentTags.map((name, id) => ({ id, name })) };
  return run('Diff Tags', [member], {
    'Loop Over Members': { branches: [[], wrap([desired])] },
  })[0];
};

const expand = (email, tags) => tags.map((t) => ({ email, tagName: t }));
const same = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

console.log('\nDIFF TAGS');

let d = diff(
  expand('a@b.com', ['VIC', 'Regional', 'Furniture', 'Active', 'Tier C']),
  ['VIC', 'Regional', 'Furniture', 'Inactive', 'Tier C', 'VIP'],
);
check('removes only the genuinely stale tag', same(d.tagsToRemove, ['Inactive']), JSON.stringify(d.tagsToRemove));
check('adds only what is missing', same(d.tagsToAdd, ['Active']), JSON.stringify(d.tagsToAdd));
check('unmanaged tag reported as untouched', d.untouched.includes('VIP'));
check('expected end state is correct',
  same(d.expectedAfter, ['VIC', 'Regional', 'Furniture', 'Active', 'Tier C', 'VIP']));

d = diff(expand('a@b.com', ['NSW', 'Metro', 'Gift & Homewares', 'Active', 'Tier A']),
  ['NSW', 'Metro', 'Gift & Homewares', 'Active', 'Inactive', 'Tier B', 'Tier C']);
check('repairs a member already carrying both values',
  same(d.tagsToRemove, ['Inactive', 'Tier B', 'Tier C']) && same(d.tagsToAdd, ['Tier A']));

d = diff(expand('a@b.com', ['VIC', 'Regional', 'Furniture', 'Active', 'Tier B']),
  ['NSW', 'Metro', 'Furniture', 'Active', 'Tier B']);
check('interstate move removes old state and geo',
  same(d.tagsToRemove, ['NSW', 'Metro']) && same(d.tagsToAdd, ['VIC', 'Regional']));

d = diff(expand('a@b.com', ['Abandoned Cart', 'Shopify']),
  ['VIC', 'Metro', 'Furniture', 'Active', 'Tier C']);
check('abandoned-cart run has no opinion, so removes nothing',
  d.tagsToRemove.length === 0 && d.groupsInScope.length === 0);
check('...and still adds its own tags', same(d.tagsToAdd, ['Abandoned Cart', 'Shopify']));

d = diff(expand('a@b.com', ['VIC', 'Regional', 'Furniture', 'Active', 'Tier C']),
  ['VIC', 'Regional', 'Furniture', 'Active', 'Tier C']);
check('nothing to do when already correct -> zero write calls',
  !d.hasRemovals && !d.hasAdds);

d = diff(expand('a@b.com', ['VIC', 'Metro', 'Active', 'Tier A']), ['vic', 'metro', 'Active', 'Tier A']);
check('casing drift is reported, not churned',
  d.tagsToAdd.length === 0 && d.tagsToRemove.length === 0 && same(d.casingDrift, ['vic', 'metro']));

d = diff(expand('a@b.com', ['Active', 'Inactive', 'VIC', 'Metro', 'Tier B']), ['Inactive', 'VIC', 'Metro', 'Tier B']);
check('conflicting input resolved by precedence',
  d.conflicts.length === 1 && d.conflicts[0].kept === 'Active' &&
  same(d.tagsToAdd, ['Active']) && same(d.tagsToRemove, ['Inactive']));

d = diff(expand('ghost@b.com', ['VIC', 'Metro', 'Active', 'Tier C']), [], { notFound: true });
check('missing member: flagged, no removals attempted',
  d.memberFound === false && d.fetchError && d.tagsToRemove.length === 0);

console.log('\nBUILD DESIRED STATE');
const b = run('Build Desired State', [
  ...expand('One@Example.com ', ['VIC', 'Active']),
  { email: 'two@example.com', tags: ['NSW', 'Inactive'] },
  { email: 'MISSING', tagName: 'Active' },
  { email: '', tagName: 'Active' },
]);
check('groups per email, lowercases, accepts both shapes',
  b.length === 2 && b[0].email === 'one@example.com' && same(b[1].desiredTags, ['NSW', 'Inactive']));
check('invalid emails dropped', !b.some((x) => x.email === 'MISSING' || x.email === ''));

console.log(`\n  ${failed ? failed + ' FAILED' : 'all checks passed'}\n`);
process.exit(failed ? 1 : 0);
