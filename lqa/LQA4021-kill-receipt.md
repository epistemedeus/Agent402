# LQA4021 kill receipt

Task: LQA4021 (batch LQ01)
Decision: **KILL**
Date: 2026-09-03
Patch provenance: [MikeyPetrillo/Agent402#1196](https://github.com/MikeyPetrillo/Agent402/pull/1196)
Replacement PR: **none** (kill condition forbids one)

## Report fields

| Field | Value |
|---|---|
| repo | https://github.com/epistemedeus/Agent402 (primary https://github.com/MikeyPetrillo/Agent402 is not writable from this agent) |
| branch | `lqa4021-verified-list-preference` |
| base_sha | `71e97fcf0a04d87ac79d3f52b4eaa5c7c9aa1fab` (`upstream/main` = MikeyPetrillo/Agent402 default at fetch; `Merge pull request #1198`) |
| head_sha | this commit (receipt only) |
| patch_id | `null` (no feature patch) |
| PR URL | `null` |
| changed_files | `lqa/LQA4021-kill-receipt.md` |
| kill artifact | `lqa/LQA4021-kill-receipt.md` |

## Verdict

GB02 as specified cannot be reconstructed on a clean upstream base without creating **new ranking authority**.

The intended feature is: when `routeQuery` candidates already tie on every existing key, prefer a seller that appears on an accepted verified list.

That preference is a new sort key. A new sort key is ranking authority. Bounding the *evidence* (missing, malformed, foreign, stale, contradictory → no-op) can stop *bad* lists from moving rank. It cannot stop a *valid accepted* list from moving rank, because moving rank on a remaining tie **is the feature**.

The kill condition therefore fires. No replacement PR.

## Provenance (PR 1196)

Closed draft, not merged.

- Title: Prefer verified-list routes on equal rank (flag default off)
- Head: `epistemedeus/Agent402` `gb02-verified-list-preference` @ `8f87a91344b29db88ade455a1601188be253065e`
- Feature commit (the only GB02 commit): `d5cae0df7fb183002daa93a3eb1c3e57fcadf06e`
- Two earlier commits on that PR are fork CI bookkeeping (`b0e2a9a7`, `a38836a8`) and are excluded here by construction (this branch is cut from current `MikeyPetrillo/Agent402` `main`, which does not contain them).
- Owner close (MikeyPetrillo, 2026-09-03, [comment](https://github.com/MikeyPetrillo/Agent402/pull/1196#issuecomment-5524261978)):

  > Ranking influence from an outside document. Even off by default, the router is the path that decides which seller gets paid, and we hold a hard line that nothing in it takes a signal from a list any single party publishes, ours included. The tie-break is small, but the principle is the one thing the router has going for it.

  > If you want the verified-list idea to live somewhere, the natural home is your side: publish the feed, and a buyer can pass it to route-and-execute as a preference on their own call.

The owner's close is consistent with the kill condition. This receipt does not re-litigate quality; the original parser, flag, and tests were not the defect. The defect is the ranking authority the feature must add to exist.

## Current ranking authority (upstream `main` @ `71e97fcf`)

`routeQuery` in `src/x402-index.js` already ranks with this comparator and no other:

1. lexical `score` (slug / name / description term hits)
2. crawl `health`
3. Coinbase Bazaar `payers30d` (measured 30-day unique payers; local rows skip the comparison when the host origin has no measurement)
4. known `priceRank` (unknown price ranks last among equals)
5. shorter `slug`

Published `why.tiebreaks` and `neutrality.ranking` name score, health, cheapest known price, shorter slug. `neutrality.paidPlacement` is `false`. `neutrality.sellerKeyedScoring` is `false`. Host advantage disclosed: local health is self-asserted.

Bazaar payers are **not** a published membership list. They are a third-party measurement of wallets that already paid. That is existing authority. GB02 is a different class: a document that *names* sellers.

`git grep` of `X402_VERIFIED_LIST`, `verifiedList`, `verified-list`, and `samedaydesk.com/x402` on `upstream/main` is empty. The feature is not already present.

## Why the feature cannot be bounded

### 1. The feature is the new key

PR 1196's comparator delta (after slug length already tied):

```js
if (!verifiedListEnabled()) return 0;
const va = routeOnVerifiedList(a[1]) ? 1 : 0;
const vb = routeOnVerifiedList(b[1]) ? 1 : 0;
return vb - va;
```

That is a sixth key. It is consulted only on a remaining tie, but a remaining tie is still a ranking decision: it chooses which seller is listed first and therefore which seller a buyer (or route-and-execute) pays. Last-resort does not make it not-authority.

### 2. Default-off is not a bound on authority

`X402_VERIFIED_LIST` unset/off leaves the comparator as today. That is a rollout switch, not a bound. The kill condition is about whether the feature *when enabled* creates new ranking authority. It does. The owner close named this explicitly ("Even off by default").

### 3. Fail-open on bad evidence is necessary and insufficient

The LQA brief requires that missing, malformed, foreign, stale, and contradictory list evidence cannot change rank. Those cases can be made no-ops:

| Evidence | Bound that keeps rank unchanged | Still leaves |
|---|---|---|
| missing (no feed / empty / fetch fail) | empty set; comparator returns 0 | a later good load can prefer |
| malformed (non-JSON, unknown shape, oversize) | parse → empty set | a well-formed load can prefer |
| foreign (wrong host, unsigned, not the accepted publisher) | reject; empty set | an *accepted* publisher can prefer |
| stale (past TTL / failed refresh kept or dropped) | drop or ignore; empty set | a fresh accepted load can prefer |
| contradictory (A listed, B listed, or list vs anti-list) | treat as empty; no preference | a non-contradictory accepted load can prefer |

Every successful bound on *bad* evidence is "treat as no list." The feature then requires that *good* accepted evidence still prefer the listed seller. That remaining case is new ranking authority.

There is no third state in which a listed seller is "preferred" and the shortlist order is unchanged. Preference *is* a change of order among ties. Today's remaining-tie order is insertion / slug-length residual, which is already determined.

### 4. "Accepted" does not remove the publisher

Narrowing "any HTTPS JSON" (PR 1196, default `https://samedaydesk.com/x402/verified.json`) to an operator-accepted publisher, a signed document, or a self-hosted file still leaves a list a single party publishes. The owner's hard line includes "ours included." Operator acceptance is still operator thumb. `neutrality.sellerKeyedScoring` would become false only by lying: membership is a seller-keyed term.

### 5. Annotation-only is not GB02

Writing `why.verifiedList` without changing `scored.sort` satisfies the bad-evidence rule (nothing changes rank) and creates no new authority. It does not reconstruct "preference … when candidates otherwise tie." Shipping it would be a different feature and would fail the reconstruction goal.

### 6. Buyer-side route-and-execute preference is not GB02

The close comment offered that as the natural home. It is out of scope for this reconstruction: it is not `routeQuery` ranking, it was not the GB02 patch, and if it reordered a tied shortlist it would still be new ranking authority on the pay path. This receipt does not implement it.

### 7. Reusing existing keys is not GB02

Folding "verified" into Bazaar payers, crawl health, or proven-seller gates would either no-op (those keys already decide) or smuggle a membership list into a measured signal. Either way it is not the intended feature, and the second form is new authority under an old name.

## What was not shipped

No `src/verified-list.js`.
No `scripts/test-verified-list.js`.
No `routeQuery` comparator change.
No `why.verifiedList` / `verified-list` tiebreak label.
No `X402_VERIFIED_LIST` / `_URL` env surface.
No `deploy.yml` suite row.
No fork CI (`deploy-prereq`, wiki skip, self-consistency-alert skip, `test-owner-workflow-prereqs.js`).

## Verify

Commands run against this branch (base = `upstream/main` @ `71e97fcf`). No feature code to unit-test; the checks are absence + comparator shape. `git grep -A` is not supported in this git; the comparator was printed from `src/x402-index.js` and checked for a list-membership key.

```
$ git rev-parse HEAD
71e97fcf0a04d87ac79d3f52b4eaa5c7c9aa1fab
# exit 0  (receipt commit not yet applied; post-commit HEAD is this receipt)

$ git merge-base --is-ancestor a38836a8d9508edeb0791e92674ac5b6516fe5a5 HEAD; echo $?
1
# fork bookkeeping main is NOT an ancestor

$ git grep -n -i -e 'X402_VERIFIED_LIST' -e 'verifiedList' -e 'verified-list' -e 'samedaydesk.com/x402' -- ':!lqa/**'
# empty; git grep exit 1

$ git grep -n 'ranking: "deterministic lexical' -- src/x402-index.js
src/x402-index.js:4215:      ranking: "deterministic lexical match on slug, name and description; ties broken by health, then cheapest known price, then shorter slug",

$ git grep -n 'tiebreaks: \["score"' -- src/x402-index.js
src/x402-index.js:4179:        tiebreaks: ["score", "health", "cheapest known price", "shorter slug"],

$ python3 -c '...'  # print scored.sort body; check verifiedList / routeOnVerifiedList
# comparator ends at:
#   return (a[1].slug || "").length - (b[1].slug || "").length;
# has verifiedList in sort: False
# exit 0
```

Expected and observed: current rank is unchanged from upstream. Missing list evidence cannot change rank because no list key exists. No product test suite was added or run; `node_modules` is absent in this workspace and a kill ships no code under test.

## Deviations

- Could not push to `MikeyPetrillo/Agent402` (403; `cursor[bot]` has no write). Branch lives on the writable fork, based on fetched `upstream/main`, not on `epistemedeus/Agent402` `main`.
- Did not reconstruct a "safer" GB02. A safer GB02 that still prefers on a tie is still new authority.
- Did not open a draft PR. Kill condition: no replacement PR.

## Unresolved

None that would un-kill the feature. Buyer-side per-call preference (the owner's suggested home) is a separate product decision and is not started here.

## Next

Leave PR 1196 closed. Do not merge this branch. Do not re-open GB02 as a router tiebreak. If a later task wants a buyer-supplied allowlist on `route-and-execute` only, treat that as a new scoped change and re-apply the same kill test: if it can reorder a tied pay decision, it is still new ranking authority.
