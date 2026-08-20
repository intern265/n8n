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

## The fix

Mailchimp's tags endpoint takes **add and remove in the same shape** — only
`status` differs. The n8n Mailchimp node exposes both:

- `resource: memberTag`, `operation: create` → `status: "active"` (add)
- `resource: memberTag`, `operation: delete` → `status: "inactive"` (remove)

Both accept an **array** of tag names in a single call, and removing a tag the
member doesn't have is a no-op (`204`).

So the tag set is treated as a set of **mutually exclusive groups** and enforced
statelessly. For every group where this run supplies a value, that value is
added and *every sibling value in the group is removed* — regardless of what we
think the member currently has:

```
activity      Active | Inactive
spendTier     Tier A | Tier B | Tier C
geo           Metro  | Regional
state         NSW | VIC | QLD | SA | WA | TAS | ACT | NT
businessType  Gift & Homewares | Furniture | Manchester | Interior Stylist | Other
```

Because removals are batched into one call, "remove the 15 siblings" costs
exactly the same as "remove the 1 sibling we think is stale" — one API call. That
buys three things:

1. **No state needed.** We never have to know what Mailchimp currently holds, so
   the fix cannot be defeated by cache drift, a failed earlier sync, or a manual
   edit in the Mailchimp UI.
2. **Self-healing.** Any member with an existing double tag is normalised the
   next time it syncs for any reason.
3. **Fewer calls, not more.** Today: one call per tag (~6 per member). After:
   one remove call + one add call = **2 per member**.

### Safety rule

Only values listed in `GROUPS` / `RETIRED` are ever removed. Everything else on
the member — `Abandoned Cart`, `Shopify`, `Draft-Fieldfolio`, `Fieldfolio`, `VIP`,
manual campaign tags — is untouched. The removal set is an explicit allow-list,
never "remove anything not in this run's tag list".

## What changed

Only `mailchimp tags update`. `Mailchimp sync`, the Shopify workflow and the
Fieldfolio workflow need **no changes** — the new Code node accepts the existing
per-tag item shape (`{ email, tagName }`) and regroups it by email, as well as the
preferred `{ email, tags: [...] }` shape.

```
When Executed by Another Workflow
  └─ Build Tag Ops (Code)          one item per email: tagsToAdd / tagsToRemove
       └─ Loop Over Items (batch 1)
            ├─ done → Return Tag Sync Summary
            └─ loop → Has Stale Tags?
                        ├─ true  → Remove Stale Tags (memberTag: delete)
                        │            └─ Add Current Tags (memberTag: create)
                        └─ false → Add Current Tags
                                     └─ back to Loop Over Items
```

Remove runs before add, per member, as required.

`Add Current Tags` reads its payload from `$('Loop Over Items').first(1)` rather
than `$json` on purpose: `Remove Stale Tags` is set to `continueRegularOutput`, so
on an API error the item reaching the add node is an error object with no
`tagsToAdd`. Reading from the loop's own output branch makes the add immune to a
failed remove.

## Edge cases

| # | Edge case | Effect | Handling |
|---|---|---|---|
| 1 | **Members already double-tagged** | Delta-only sync means an `unchanged` customer never gets pushed again, so historical corruption is never repaired | One-off backfill: force `_action = 'changed'` for all rows in workflow 1 (or clear `TagsHash` in the sheet) and let the run normalise everyone |
| 2 | **Automations re-firing during backfill** | ~3,700 members × tag events can retrigger journeys | Set `isSyncing: true` in the `options` of both Mailchimp nodes **for the backfill run only**, then revert. Normal runs never remove-and-re-add the same tag, so no spurious events |
| 3 | **Manual tags in Mailchimp** (`VIP`, `Do Not Email`, event tags) | Would be destroyed by a naive "remove everything not in this run" | Removal is an explicit allow-list of group values only — verified by test |
| 4 | **Cross-source collisions** — an E-Suite customer who also abandons a Shopify cart | E-Suite run could strip `Abandoned Cart`, or the Shopify run could strip `Active` | Those tags are in no group, so neither run touches them. Note: `Abandoned Cart` is deliberately *not* part of the `activity` group |
| 5 | **Casing / whitespace drift** (`tier a`, `Tier  A`) | Duplicate near-identical tags in the audience | Input is trimmed, whitespace-collapsed and mapped back to canonical casing before comparison |
| 6 | **Renamed or retired taxonomy values** (e.g. business type renamed) | Stale tag lingers because it is no longer a known sibling | `RETIRED` map per group: values that are removed but never added. Audit Audience → Tags once and populate it |
| 7 | **Business type unknown / `Unclassified`** | Group has no value this run | The group is skipped entirely — nothing added, nothing removed. We never strip a dimension we can't replace |
| 8 | **Both values arrive from upstream** (`Active` *and* `Inactive` in one payload) | Would re-create the bug at source | Group order is precedence — first wins, loser is removed, and the item carries `conflicts` so it shows up in the run summary |
| 9 | **Remove succeeds, add fails** | Member left with no tag for that dimension — worse than a double tag | `retryOnFail` + 5s backoff on both nodes; add reads from the loop branch so a failed remove can't cascade. Residual risk is one weekly cycle, cleared on the next run |
| 10 | **Member doesn't exist / archived** (404) | Tag call fails silently | Both nodes are `continueRegularOutput` so one bad member can't kill the batch — but see the follow-up below, failures are currently invisible |
| 11 | **Two accounts sharing one email** (franchise locations, per the README) | Both records map to one Mailchimp member; each run flips the tags, and both stay permanently "changed" | Deduplicate by email *before* the Mailchimp push — merge to the best tier and `Active` if any location is active. Not fixed here; needs a change in workflow 1 |
| 12 | **Unsubscribed / cleaned members** | `Update a member` sets `status: subscribed`, which 400s for an unsubscribed contact and is a compliance problem | Should use an upsert with `status_if_new` instead of forcing `subscribed`. Not fixed here |
| 13 | **Rate limits** | Mailchimp allows 10 concurrent connections | Calls are sequential inside the loop, with retry + 5s backoff. The backfill (~7,400 calls) is worth chunking or moving to `POST /batches` |
| 14 | **Empty tag names** | Blank tag created in the audience | Empty/null values are dropped; an item with nothing to add is skipped rather than issuing a remove-only call |

## Known follow-ups (not in this change)

1. **Failures are recorded as successes.** Both Mailchimp nodes continue on
   error, and workflow 1 stamps `LastSynced` + the new `TagsHash` regardless. A
   member whose tag call 404'd looks synced forever and is never retried. Route
   the error output to a collector and only write `TagsHash` back for members
   that actually succeeded.
2. **Dedupe by email** before the Mailchimp push (edge case 11).
3. **Tag audit workflow** — walk the audience and report any member carrying two
   values from the same group. Good weekly canary that this stays fixed.

## Testing

Three layers, in the order you should run them.

### 1. Offline — no Mailchimp involved

```
node scripts/test_build_tag_ops.js     # tag logic against 7 input scenarios
node scripts/validate_workflow.js      # wiring, branch indices, node ops, expressions
node scripts/simulate_tag_sync.js      # replays old vs new against a fake audience
```

`simulate_tag_sync.js` implements the real endpoint semantics (`status: active`
adds, `status: inactive` removes, removing an absent tag is a no-op), seeds a
dummy audience in the corrupted state, and runs **both** the old add-only
workflow and the patched one over identical input. The old version must fail —
a test that passes on the broken code proves nothing.

Current result: old workflow leaves 4 of 5 members with conflicting tags; patched
workflow leaves 0, preserves `VIP` / `Trade Show 2025` / `Abandoned Cart`, and
drops the call count from 27 to 11. 12/12 assertions pass.

### 2. In n8n, without touching Mailchimp

Import the workflow, then **disable both Mailchimp nodes** and execute with the
pinned data. Inspect the `Build Tag Ops` output: one item per email carrying
`tagsToAdd`, `tagsToRemove`, `hasRemovals` and `conflicts`. Nothing is written to
Mailchimp, so this is a zero-risk first look.

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
4. Check the two node executions: the remove call should carry ~15 tag names with
   `status: inactive`, the add call ~5 with `status: active`.
5. In Mailchimp, confirm the member now has exactly one activity, tier, geo, state
   and business-type tag — and that `VIP` is still there.
6. Run the parent `Mailchimp sync` with pinned data for the same member to confirm
   the sub-workflow call still returns cleanly.

Only then let the weekly schedule run.

## Verification checklist for the backfill

When you force the one-off backfill (edge case 1), set `isSyncing: true` on both
Mailchimp nodes first, run against a small slice before all ~3,700, and revert the
flag afterwards.
