# Mailchimp tag mutual exclusion (Active/Inactive drift)

## The bug

`mailchimp tags update` only ever **adds** tags. The Mailchimp node's `memberTag`
resource defaults to the `create` operation, which posts
`{ name: <tag>, status: "active" }` to
`POST /lists/{list}/members/{hash}/tags`.

Nothing in the chain ever posts `status: "inactive"`, so when a customer's
segmentation changes the new tag is added on top of the old one:

| Week | E-Suite says | Tags applied | Tags on member |
|---|---|---|---|
| 1 | no orders 12m | `Inactive` | `Inactive` |
| 2 | placed an order | `Active` | `Inactive`, `Active` |

Same failure for every exclusive dimension: `Tier A`/`Tier B`/`Tier C`,
`Metro`/`Regional`, state moves, business-type reclassification. Segments built
on those tags silently over-count, and a member can sit in two contradictory
campaigns at once.

## The fix: fetch, diff, remove, add

Mailchimp's tags endpoint takes add and remove in the same shape — only
`status` differs — and the n8n Mailchimp node exposes both:

- `resource: memberTag`, `operation: create` -> `status: "active"` (add)
- `resource: memberTag`, `operation: delete` -> `status: "inactive"` (remove)
- `resource: member`, `operation: get` -> `GET /lists/{id}/members/{email}`,
  whose response carries the member's `tags` array

So each member is reconciled against its real state rather than against what
we assume it holds:

```
current tags   <- fetched from Mailchimp
desired tags   <- the segmentation payload (master sheet)

tags to remove = current MINUS desired     (managed values only, see scope rule)
tags to add    = desired MINUS current
```

Reading first buys four things a blind remove-then-add cannot give you:

1. **Only real changes are written.** A member already correct costs one read
   and zero writes, instead of two writes every week.
2. **Removal calls name only tags that are actually on the member**, so the
   execution log is a readable record of what changed.
3. **You can see what happened.** Every member produces a row with `before`,
   `removed`, `added`, `untouched` and `after` — which is what you need when the
   answer to "is it working?" has to be more than "probably".
4. **Anomalies surface**: members missing from the audience, and tags that are
   right but stored with different casing.

### Who writes which tags (verified against the workflow JSON + README)

| Tag | Written by | Ever removed? |
|---|---|---|
| `NSW`/`VIC`/... , `Metro`/`Regional`, business type, `Active`/`Inactive`, `Tier A/B/C` | Workflow 1, E-Suite SQL segmentation | Only by this change |
| `Abandoned Cart`, `Shopify` | Workflow 2, Shopify Abandoned Carts (README:99, 244) | **No — nothing removes them** |
| `Draft-Fieldfolio`, `Fieldfolio` | Workflow 3, Fieldfolio Draft Orders (README:115, 246) | **No — nothing removes them** |
| Manual tags (`VIP`, campaign tags) | Applied by hand in the Mailchimp UI | No |

All three source workflows call the same `Mailchimp Sync` sub-workflow
(README:131), which hardcodes no tag names at all — `Prep Mailchimp Payload` and
`Expand Tags` both just read `d.tags` from whatever the caller passed. The tags
then reach `mailchimp tags update` as identical `{ email, tagName }` items with
**no marker saying which source they came from**.

That is exactly why removal has to be bounded by a declared vocabulary rather
than by "what is in the master sheet": at the point of the write, the workflow
cannot tell an abandoned-cart tag from a segmentation tag except by name.

Confirmed by inspection: the only tag operation anywhere in the current system is
`memberTag` with the default `create`. The sole delete is `Mailchimp delete`,
which removes the **whole contact**, not a tag.

### Stale README entries for workflow 4

The README describes `Mailchimp Sync` as it used to be, not as it runs:

| README says | Actually |
|---|---|
| list `0b326f5891` | `0d435a9df3` |
| "Loops in batches of 10" | `batchSize` unset, so splitInBatches v3 defaults to **1** |
| "Routes via Switch node: abandoned → `Create a member tag-abandoned1`, others → `Create a member tag-non-abandoned`" | No Switch node exists. It is `Expand Tags` → `Execute Workflow` → `mailchimp tags update` |

### Scope rule — the part the diff alone does not give you

"Remove everything on the member that is not in the master sheet" would delete
`Abandoned Cart`, `Shopify`, `Draft-Fieldfolio`, `Fieldfolio` and every manual
tag the marketing team applies, because none of those live in the sheet. Three
of the five workflows write tags that are not segmentation tags.

So removal is bounded by a declared vocabulary of mutually exclusive groups:

```
activity      Active | Inactive
spendTier     Tier A | Tier B | Tier C
geo           Metro  | Regional
state         NSW | VIC | QLD | SA | WA | TAS | ACT | NT
businessType  Gift & Homewares | Furniture | Manchester | Interior Stylist | Other
```

A tag is removed only if **both** are true: it is in the managed vocabulary, and
it belongs to a group this run actually supplies a value for. An abandoned-cart
run sending `["Abandoned Cart","Shopify"]` supplies no group values, so its
removal scope is empty and it touches nothing else on the member. Everything
outside the vocabulary is never a removal candidate at all.

## What changed

Only `mailchimp tags update`. `Mailchimp sync`, the Shopify workflow and the
Fieldfolio workflow need **no changes** — `Build Desired State` accepts the
existing per-tag item shape (`{ email, tagName }`) and regroups it by email, as
well as `{ email, tags: [...] }`.

```
When Executed by Another Workflow
  └─ Build Desired State (Code)        one item per email
       └─ Loop Over Members (batch 1)
            ├─ done → Return Tag Sync Summary
            └─ loop → Fetch Current Tags (member: get)
                        └─ Diff Tags (Code)
                             └─ Has Stale Tags?
                                  ├─ true  → Remove Stale Tags (memberTag: delete) ─┐
                                  └─ false ────────────────────────────────────────┤
                                                                    Has New Tags?  ←┘
                                                                      ├─ true  → Add New Tags
                                                                      └─ false → Record Result
                                                                                    └─ back to loop
```

Cost per member: 1 read, plus a write only when there is something to write —
0, 1 or 2. The old workflow spent one write per tag whether or not anything
had changed.

Two implementation details that matter:

- `Add New Tags` reads `$('Diff Tags').first(0)` rather than `$json`. Both
  Mailchimp nodes are `continueRegularOutput`, so after a failed remove the item
  on the wire is an error object with no `tagsToAdd`; reading back from the diff
  node makes the add immune to that.
- `Fetch Current Tags` is `alwaysOutputData` with `fields=email_address,status,tags`,
  so a 404 produces an item (flagged `memberFound: false`) instead of stalling
  the chain, and the response stays small.

## Edge cases

| # | Edge case | Effect | Handling |
|---|---|---|---|
| 1 | **The fetch fails** (429, timeout) | We cannot know the current tags, so removals are skipped and the stale tag survives another week | The node retries with a 5s backoff; if it still fails the member is recorded with `memberFound: false` and an `error`, so it is **visible rather than silent**. Adds still go through (they are idempotent). This is the one failure mode this design has that a blind remove-then-add does not — covered by a test |
| 2 | **Members already double-tagged** | Delta-only sync means an `unchanged` customer is never pushed again, so historical corruption is never repaired | One-off backfill: force `_action = 'changed'` in workflow 1 (or clear `TagsHash` in the sheet) and let the run reconcile everyone |
| 3 | **Automations re-firing during the backfill** | ~3,700 members' worth of tag events could retrigger journeys | Set `isSyncing: true` in `options` on both write nodes **for the backfill only**. Normal runs skip tags already present, so a steady-state member generates no tag events at all |
| 4 | **Manual tags** (`VIP`, `Do Not Email`, event tags) | Destroyed by a naive "remove everything not in the sheet" | Removal is bounded by the managed vocabulary; everything else is reported under `untouched` |
| 5 | **Cross-source collisions** — an E-Suite customer who also abandons a Shopify cart | The E-Suite run could strip `Abandoned Cart`, or the Shopify run could strip `Active` | The scope rule: a run only removes within groups it supplies a value for. Verified by test |
| 6 | **Casing drift** (`vic` vs `VIC`) | Near-duplicate tags in the audience | Matching is case-insensitive, so no churn. The variant is reported in `casingDrift` for a manual cleanup — auto-fixing would mean remove+re-add, which re-fires automations |
| 7 | **Renamed or retired taxonomy values** | A stale tag is no longer a known group value, so it is out of scope for removal | `RETIRED` map per group: values that are removed but never added. Audit Audience → Tags once and populate it |
| 8 | **Business type unknown / `Unclassified`** | Group has no value this run | Group is out of scope — nothing added, nothing removed. A dimension is never stripped without a replacement |
| 9 | **Both values arrive from upstream** (`Active` *and* `Inactive`) | Would recreate the bug at source | Group order is precedence: first wins, the loser is removed, and the row carries `conflicts` so it shows in the summary |
| 10 | **Remove succeeds, add fails** | Member left with no tag for that dimension | Retry with backoff on both nodes; the add reads back from `Diff Tags` so a failed remove cannot cascade. Residual exposure is one weekly cycle |
| 11 | **Member not in the audience** (404) | Tag calls would fail | The fetch flags `memberFound: false`, the row carries the error, and the batch continues |
| 12 | **Two accounts sharing one email** (franchise locations, per the README) | Both map to one member; each run flips the tags and both records stay permanently "changed" | Deduplicate by email *before* the Mailchimp push — best tier, `Active` if any location is active. Not fixed here; needs a change in workflow 1 |
| 13 | **Unsubscribed / cleaned members** | `Update a member` forces `status: subscribed`, which 400s and is a compliance problem | Should be an upsert with `status_if_new`. Not fixed here |
| 14 | **Rate limits** | Mailchimp allows 10 concurrent connections | Calls are sequential; retry with 5s backoff. The read adds one call per member — see the note below on batching if that becomes a problem |
| 15 | **Empty tag names** | Blank tag created in the audience | Empty values dropped; a member with nothing desired is skipped entirely |

### On the extra API call

One read per member is the price of knowing the real state. At steady state
(100-400 changed members) that is 100-400 reads and *fewer* writes than today,
so the total drops. For the ~3,700-member backfill it is worth fetching the
audience in bulk instead — `GET /lists/{id}/members?fields=members.email_address,members.tags&count=1000`
is 4 calls for the whole list — and diffing against that map. That only works if
`Mailchimp sync` is changed to hand this workflow all members at once; today it
calls it once per member, so the per-member read is the right fit.

## Testing

Three layers, in the order you should run them.

### 1. Offline — no Mailchimp involved

```
node scripts/test_diff_tags.js         # the two Code nodes, 14 scenarios
node scripts/validate_workflow.js      # wiring, branch indices, node ops, expressions
node scripts/simulate_tag_sync.js      # replays old vs new against a fake audience
```

`simulate_tag_sync.js` implements both endpoints (the member GET, and the tags
POST where `status: active` adds and `status: inactive` removes, with removal of
an absent tag a no-op), seeds a dummy audience in the corrupted state, and runs
**both** the old add-only workflow and the patched one over identical input. The
old version must fail — a test that passes on the broken code proves nothing.

Current result: the old workflow leaves 4 of 6 members conflicted; the patched one
leaves 0, preserves `VIP` / `Trade Show 2025` / `Abandoned Cart`, and goes from 32
writes to 10 writes + 7 reads. It also replays a degraded run where the fetch fails,
to prove that case is reported rather than silently skipped. 16/16 assertions pass.

### 2. In n8n, without touching Mailchimp

Import the workflow, then **disable both Mailchimp nodes** and execute with the
pinned data. Leave `Fetch Current Tags` enabled and disable only the two write nodes — then the
`Diff Tags` output shows the real `currentTags`, `tagsToRemove`, `tagsToAdd` and
`expectedAfter` for each member without changing anything. That is the safest and
most informative dry run available.

Note: the `tags` field on both Mailchimp nodes is bound to an expression that
returns an **array** (`={{ $json.tagsToRemove }}`). n8n resolves this correctly at
runtime, but the editor renders multi-value fields as a list — do not "tidy" that
field in the UI, or the binding is lost.

### 3. Against one real test member

1. Pick a disposable contact (`productteam@cdsi.com.au` is already a test
   account in the pinned data).
2. In Mailchimp, deliberately break it: add **both** `Active` and `Inactive`, and
   both `Tier B` and `Tier C`. Add a `VIP` tag as a canary.
3. Re-enable the Mailchimp nodes, pin that one member's tags, execute.
4. Check the node executions: `Diff Tags` should show `currentTags` matching what
   you set up, `tagsToRemove` naming only the tags you deliberately broke, and
   `tagsToAdd` naming only what is genuinely missing.
5. In Mailchimp, confirm the member now has exactly one activity, tier, geo, state
   and business-type tag — and that `VIP` is still there.
6. Run the parent `Mailchimp sync` with pinned data for the same member to confirm
   the sub-workflow call still returns cleanly.

Only then let the weekly schedule run.

## Verification checklist for the backfill

When you force the one-off backfill (edge case 1), set `isSyncing: true` on both
Mailchimp nodes first, run against a small slice before all ~3,700, and revert the
flag afterwards.
