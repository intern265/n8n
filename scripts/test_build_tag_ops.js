const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'build_tag_ops.js'), 'utf8');

function run(items) {
  const $input = { all: () => items.map(json => ({ json })) };
  return new Function('$input', src)($input);
}
const show = (label, out) => {
  console.log('\n### ' + label);
  for (const o of out) console.log(JSON.stringify(o.json, null, 1));
  if (!out.length) console.log('(no items)');
};

// 1. legacy per-tag items, customer flipping Inactive -> Active
show('legacy shape, E-Suite member now Active', run(
  ['VIC','Regional','Independent','Furniture','Active','Tier C'].map(t => ({ email:'pakenham@mrfurniture.com.au', tagName:t }))
));

// 2. preferred array shape
show('array shape, Tier A metro NSW active', run([
  { email:'BUYER@Example.com ', tags:['NSW','Metro','Gift & Homewares','Active','Tier A'] }
]));

// 3. Shopify abandoned cart contact - nothing exclusive
show('abandoned cart contact', run([
  { email:'team@duranttechnologies.com', tags:['Abandoned Cart','Shopify'] }
]));

// 4. upstream conflict: both Active and Inactive arrive
show('conflicting activity tags', run([
  { email:'dupe@example.com', tags:['Active','Inactive','Tier B','VIC','Metro'] }
]));

// 5. casing / whitespace drift + junk
show('messy input', run([
  { email:'messy@example.com', tags:['  tier  b ','vic','METRO','', null, 'furniture'] }
]));

// 6. invalid / missing email
show('bad emails dropped', run([
  { email:'MISSING', tags:['Active'] }, { email:'', tags:['Active'] }, { tags:['Active'] }
]));

// 7. sanity: never remove something we are adding
const all = run([{ email:'x@y.com', tags:['NSW','Metro','Furniture','Active','Tier A','VIP','Abandoned Cart'] }]);
const o = all[0].json;
const overlap = o.tagsToAdd.filter(t => o.tagsToRemove.includes(t));
console.log('\n### invariants');
console.log('add/remove overlap :', overlap.length === 0 ? 'none (ok)' : overlap);
console.log('unmanaged kept     :', o.tagsToAdd.includes('VIP') && o.tagsToAdd.includes('Abandoned Cart'));
console.log('unmanaged removed  :', o.tagsToRemove.some(t => ['VIP','Abandoned Cart','Shopify','Fieldfolio'].includes(t)));
console.log('remove call count  :', o.tagsToRemove.length, '-> 1 API call');
