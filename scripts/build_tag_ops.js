// NOTE: extracted copy of the 'Build Tag Ops' Code node in
// workflows/mailchimp_tags_update.json (the workflow JSON is the source of
// truth). Kept here so the logic can be exercised by test_build_tag_ops.js.

// ============================================================
// BUILD TAG OPS — mutually exclusive tag enforcement
// ------------------------------------------------------------
// Accepts either input shape (mixed is fine):
//   { email, tags: ["VIC","Metro","Active", ...] }   <- preferred
//   { email, tagName: "Active" }                     <- legacy, one item per tag
//
// Emits ONE item per email:
//   { email, tagsToAdd, tagsToRemove, hasRemovals, conflicts }
//
// RULE: only values listed in GROUPS / RETIRED are ever removed.
// Any other tag on the member (Abandoned Cart, Shopify, Fieldfolio,
// VIP, manual campaign tags...) is never touched.
// ============================================================

// Mutually exclusive groups. Order = precedence when a record somehow
// arrives with two values from the same group (first one wins).
const GROUPS = {
  activity: ['Active', 'Inactive'],
  spendTier: ['Tier A', 'Tier B', 'Tier C'],
  geo: ['Metro', 'Regional'],
  state: ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'],
  businessType: ['Gift & Homewares', 'Furniture', 'Manchester', 'Interior Stylist', 'Other'],
};

// Old / renamed / misspelt values that may still be sitting on members in
// Mailchimp. Add anything you find under Audience > Tags that is a stale
// variant of a group value (e.g. 'Tier-A', 'Gift and Homewares'). These are
// removed but never added.
const RETIRED = {
  activity: [],
  spendTier: [],
  geo: [],
  state: [],
  businessType: [],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// canonical lookup so 'tier a' / 'Tier  A' both resolve to 'Tier A'
const canonical = new Map();
for (const [group, values] of Object.entries(GROUPS)) {
  for (const v of values) canonical.set(v.toLowerCase(), v);
  for (const v of RETIRED[group] || []) canonical.set(v.toLowerCase(), v);
}

const clean = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
const normalize = (t) => {
  const c = clean(t);
  return canonical.get(c.toLowerCase()) || c;
};

// ---- 1. collapse incoming items into one tag set per email ----
const byEmail = new Map();

for (const item of $input.all()) {
  const d = item.json || {};
  const email = String(d.email == null ? '' : d.email).toLowerCase().trim();
  if (!email || !EMAIL_RE.test(email)) continue;

  const raw = Array.isArray(d.tags) ? d.tags : (d.tagName ? [d.tagName] : []);
  if (!byEmail.has(email)) byEmail.set(email, new Set());
  const set = byEmail.get(email);
  for (const t of raw) {
    const n = normalize(t);
    if (n) set.add(n);
  }
}

// ---- 2. per email, work out adds and removes ----
const out = [];

for (const [email, tagSet] of byEmail) {
  const conflicts = [];
  const remove = new Set();
  const losers = new Set();

  for (const [group, values] of Object.entries(GROUPS)) {
    const present = values.filter((v) => tagSet.has(v));
    if (present.length === 0) continue; // this run says nothing about this group -> leave it alone

    const winner = present[0];
    if (present.length > 1) {
      conflicts.push({ group, received: present, kept: winner });
      for (const v of present.slice(1)) losers.add(v);
    }

    for (const v of values.concat(RETIRED[group] || [])) {
      if (v !== winner) remove.add(v);
    }
  }

  const tagsToAdd = [...tagSet].filter((t) => !losers.has(t));
  const tagsToRemove = [...remove].filter((t) => !tagsToAdd.includes(t));

  // never fire a remove-only call: without a replacement tag we would be
  // stripping segmentation off a member for no reason
  if (tagsToAdd.length === 0) continue;

  out.push({
    json: {
      email,
      tagsToAdd,
      tagsToRemove,
      hasRemovals: tagsToRemove.length > 0,
      conflicts,
    },
  });
}

return out;
