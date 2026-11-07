# Accedra platform integration

Build a fresh adapter from upstream main. Leave the old local prototype and unrelated work untouched.

## Approach

Use CCMAX's existing account, proxy, OAuth, telemetry and daily-settlement flows. Add Accedra as private provider `accedra`, public Platform X (✨ Anti-Ban). A dedicated Accedra provider has a 0.25× payout multiplier, a server-only scoped API key, and destinations assigned by Accedra. Exclude CCMAX destinations to prevent routing accounts back into CCMAX.

Direct server-to-server onboarding calls reuse CCMAX's callback UI. If Accedra requires several authorizations, finish the consumed attempt and create a distinct pending attempt with the next URL and encrypted secret until every required authorization completes (one code claim per attempt). Do not iframe or scrape an upstream dashboard. Validate exact account/email and OAuth state before claiming ownership. Do not infer completion from merely seeing an active account.

API base is fixed to https://accedra.xyz. API keys use the existing encrypted credentials column, never public responses. Accedra currently permits renaming/deleting provider accounts, but does not expose provider account enable/disable or proxy rotation. Do not advertise or emulate these unsupported operations.

Accedra supplies completed Beijing-day statements of actual credited own-account earnings, aggregated without the history endpoint's 500-row limit. Statement date is the credit posting date, not the original usage date. For a 0.25× contract, credited USD / 0.25 is CCMAX's settlement base; applying the configured 0.25× root quote recovers the exact upstream payable. Validate the statement date, timezone, completeness, rate, account uniqueness and total. Estimates, lifetime totals, commissions and quota percentages never become daily income. Mixed rate days require manual reconciliation.

## Alternatives

The old local adapter is stale and would overwrite newer upstream changes. Embedding an upstream portal would duplicate UI and hide required callbacks. Reimplementing the existing CCMAX accounting system would risk inconsistent rates. Reuse the current interfaces and add only the missing read-only statement API in Accedra.

## Validation

Adapter tests cover credential isolation, response validation, exact identities, OAuth continuation, callback rejection, idempotent creation, unsupported operations and exact-decimal statements. Worker/API tests exercise real PGlite ownership and job transitions. Schema migration tests cover existing installations. Run the complete local suite, typecheck and production build, then review before opening a PR. No CCMAX deployment or real payouts.

## Approved live-display follow-up

The user requested the existing provisional earnings flow in addition to final daily statements, plus the exact public alias Platform X (✨ Anti-Ban). Fetch a complete current Beijing posting-day snapshot at roughly one-minute intervals for Accedra alone. Validate timestamps, totals, identities and the 0.25 multiplier; map exact credited earnings to the same truncated normalized base used by final statements. Reuse CCMAX's cumulative provisional upsert and agent allocation; never add wallet money or infer dollars from quotas. Show actual billed usage and counts of credited internal requests where fully attributable, preserving null for unknown coverage. Daily reconciliation remains the only finalization path. Add scope/precision/ownership/cutoff backend tests and full sync-to-agent-to-day-end tests.
