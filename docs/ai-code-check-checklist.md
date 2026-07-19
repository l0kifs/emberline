# AI Code-Check Checklist

A checklist for an AI agent reviewing/testing **new code**, built to catch the obvious mistakes and edge cases that generic "review this code" passes miss (duplicate registration accepted, empty password accepted, etc.).

Grounded in: ISTQB test design techniques as taught in the EPAM STA course (equivalence partitioning, boundary value analysis, decision tables, state transitions, error guessing), agile/scrum practices (Definition of Done, acceptance criteria, Given/When/Then, agile testing quadrants), Google's code review guide, OWASP input validation, and AI-code-specific review guidance. Sources at the bottom.

---

## How to use this (procedure for the agent)

Do NOT review the code in one general pass. Run these steps in order, as separate focused passes — research shows a dedicated edge-case pass catches what the general pass missed:

1. **Inventory the change.** List every: input field/parameter, operation (create/read/update/delete/call), business rule, and stateful flow the new code introduces or touches.
2. **For every input** → run the **Input Matrix** (§2) and **Boundary Analysis** (§3).
3. **For every operation** → run the **Unhappy Paths** checklist (§4).
4. **For every business rule with 2+ conditions** → build a **decision table** (§5).
5. **For every stateful flow** → run **state transition checks** (§6).
6. **If the change touches auth/registration/API** → run the matching **domain checklist** (§7).
7. **Review the tests themselves** (§8) and **AI-specific failure modes** (§9).
8. **Report** against the Definition of Done gate (§10). One finding = one report item: what, where, under what conditions, expected vs actual.

### Operating rules (EPAM checklist methodology)

- **One checklist item = one check.** Never verify two things in one item.
- **Never combine negative tests.** Two invalid conditions in one test mask each other — one invalid condition per negative test. (Positive conditions MAY be combined into one test.)
- **Check against the requirements / acceptance criteria**, positive AND negative scenarios. Error states are their own criteria, not footnotes on the happy path. If a requirement is ambiguous (words like "fast", "normal", "user-friendly", "etc."), flag it as a finding — don't guess.
- **Verify constraints at the layer that enforces them.** A uniqueness check in application code is not enough — is there a DB unique constraint? Client-side validation is UX only — is the same validation on the server?
- Beyond stated acceptance criteria, always also check: negative verifications, functional behavior of every control, integration with the rest of the system, and one end-to-end scenario.

---

## 2. Input Matrix — run for EVERY input field/parameter

This mechanically generates the "obvious" bugs. For each input, check how the code handles:

**Emptiness / absence**
- [ ] Empty string (`""`) — the classic "empty password accepted" bug
- [ ] Whitespace-only input (`"   "`)
- [ ] `null` vs **missing entirely** vs empty string — these are three different cases and may each behave differently (APIs especially)
- [ ] Required field absent → field-specific error; optional field absent → no error, sensible default

**Length (equivalence classes: below-min / valid / above-max)**
- [ ] At minimum length, and one below minimum
- [ ] At maximum length, and one above maximum
- [ ] Far above maximum (does the DB column length match the validated limit?)

**Type & format**
- [ ] Wrong type (text in a numeric field, `"abc"` where an int is expected) → validation error, not a 500/crash
- [ ] Negative numbers and zero where only positives make sense (amounts, quantities, ages)
- [ ] Invalid dates: wrong format, February 30th, past date where future is required (and vice versa), start date after end date

**Content**
- [ ] Duplicate value where uniqueness is expected (email, username, slug) — **including different case**: `User@x.com` vs `user@x.com`
- [ ] Leading/trailing spaces — trimmed? Do they defeat uniqueness or matching?
- [ ] Apostrophe in text (`O'Brian`, `D'Mello`) — must be accepted; rejection is a SQL-escaping tell
- [ ] Unicode: non-Latin scripts, emoji, mixed encodings — accepted, stored, and displayed correctly
- [ ] Injection strings: SQL (`' OR 1=1--`), HTML/script tags (XSS) — rejected or escaped, never executed; a 500 error on weird input is itself a bug
- [ ] Fixed option sets (dropdown/radio/enum): value outside the allowlist submitted directly to the backend → rejected (frontend restrictions can be bypassed)

**Email fields specifically**
- [ ] Missing `@`, multiple `@`, missing domain/TLD, > 254 chars total → rejected
- [ ] Comparison for uniqueness is case-insensitive; `+tag` sub-addresses not stripped

---

## 3. Boundary Value Analysis (BVA)

Bugs cluster at the edges of ranges, not the middle. For every ordered/numeric constraint (length limits, amounts, counts, dates, pagination limits):

1. Identify the equivalence classes (e.g., "length 2–35" → invalid `0–1`, valid `2–35`, invalid `36+`).
2. Test **each boundary and its neighbors**:
   - **2-value (standard):** min−1, min, max, max+1 → for 2–35: test `1, 2, 35, 36`
   - **3-value (high-risk code — money, security, data loss):** add min+1 and max−1 → test `1, 2, 3, 34, 35, 36`
3. Watch for **off-by-one in code**: `<` vs `<=`, loop bounds, slice indices, page-size math.

---

## 4. Unhappy Paths — run for EVERY operation

For each create/update/delete/call, ask what happens when:

- [ ] **The target already exists** (create duplicate → the "same email registers twice" bug)
- [ ] **The target doesn't exist** (update/delete/read a missing or already-deleted ID → clean 404/error, not a crash)
- [ ] **The operation runs twice** (double-click, retried request, replayed webhook) — is it idempotent? Duplicate side effects (double charge, double email)?
- [ ] **It fails halfway** — multi-step writes wrapped in a transaction, or recoverable? Partial state left behind?
- [ ] **It races with itself** — two concurrent requests for the same resource (two simultaneous registrations with the same email beat an app-level check; only a DB constraint wins). Check-then-act (TOCTOU) patterns; non-atomic read-modify-write.
- [ ] **The caller isn't allowed** — authorization checked on THIS resource (can user A read/modify user B's data by changing an ID?)
- [ ] **The result set is empty** — empty list renders/returns fine (200 + `[]`, not 404 or crash)
- [ ] **A dependency fails** — external API/DB call has a timeout, its failure is handled, error surfaced meaningfully (no swallowed exceptions, no HTML error pages from a JSON API)
- [ ] **Volume is unexpected** — N+1 queries (query inside a loop), unbounded result sets, missing pagination

---

## 5. Business Rules → Decision Table

When behavior depends on a **combination** of 2+ conditions (discount rules, access rules, validation rules):

1. List every condition (T/F each).
2. Enumerate all combinations — n conditions → 2ⁿ rules (3 conditions = 8 rules).
3. **One check per rule**, verifying the exact resulting action/message.
4. If combinations explode (4+ independent parameters), use **pairwise coverage** (all pairs of values, e.g. via PICT) instead of all combinations — but manually add known high-risk/frequent combos, and honor impossible-pair constraints.

This is the technique that surfaces "the code handles A and B, but nobody decided what A+B together should do."

## 6. Stateful Flows → State Transition Checks

For anything with a lifecycle (order status, session, booking, retry counter):

1. Pick **one object**, list all its states (it must always be in exactly one).
2. Map every event/transition between states.
3. Check **valid transitions** produce the right state + action.
4. Check **invalid transitions are rejected** (cancel an already-shipped order; pay a cancelled invoice; 4th login attempt after lockout).
5. Check behavior that depends on **history** (e.g., "3 failed attempts → blocked" — does the counter reset correctly on success?).

---

## 7. Domain Checklists

### Registration / signup
- [ ] Already-registered email → registration fails with a clear error, **and a DB unique constraint backs it** (not just an app-level lookup)
- [ ] Case variants of an existing email/username can't create a duplicate account
- [ ] Empty password rejected; below-min-length rejected; common passwords (`password`, `123456`) and trivial ones (`aaaaaaaa`) rejected per policy
- [ ] Each mandatory field blank **individually** → field-specific error (not one generic error, not a pass)
- [ ] Password hashed (never plaintext in DB or logs), masked in UI, never echoed back in responses
- [ ] Email verification (if present) actually gates the account; token is random, single-use, time-limited
- [ ] Injection strings in every field; CSRF protection on the form

### Login / session
- [ ] Wrong password, blank username, blank password, blank both → all fail
- [ ] Error message doesn't reveal whether the username or the password was wrong
- [ ] After logout, the browser Back button / old URL doesn't re-enter the session; authenticated URL pasted into another browser doesn't grant access
- [ ] Session timeout works; concurrent-session behavior is defined and enforced
- [ ] Lockout/rate-limit on repeated failures

### API endpoints
- [ ] Expired/revoked token → 401; insufficient permission → 403 (not 404, not 200); machine-readable error body
- [ ] Invalid query params (`?page=-1`, `?limit=abc`, limit over max) → 400, not 500; missing params → documented defaults
- [ ] Empty result → 200 + empty array, not 404
- [ ] Pagination: deterministic ordering (tie-breaker!), no repeated/skipped items when rows change between pages
- [ ] Errors always return the documented error envelope (JSON, never an HTML error page); consistent across all non-2xx
- [ ] Retried POST with same idempotency key → same result, no duplicate resource
- [ ] Rate limiting returns 429 (with Retry-After), not 5xx

---

## 8. Test Quality — review the tests themselves

- [ ] **Anti-tautology: would each test FAIL if the feature were broken?** Flag mocks that return hardcoded values matching the assertion — they test nothing.
- [ ] Every acceptance criterion of the story has at least one test (traceability: requirement → test)
- [ ] Negative tests exist, not just happy path — at minimum: empty input, boundary violations, duplicate, unauthorized
- [ ] One functional check per test case (create/edit/delete = three tests, not one)
- [ ] Tests are deterministic/repeatable (no reliance on execution order, current date, or leftover data)
- [ ] Boundary tests use the actual boundary values (min−1/min/max/max+1), not arbitrary "safe" values from the middle of the range

## 9. AI-Generated-Code Failure Modes

- [ ] Every import resolves; every called method/API actually exists in the used library version (no hallucinated APIs)
- [ ] Business logic verified against the **spec**, not visual plausibility — especially boundary conditions, operation ordering, permissions, and monetary calculations
- [ ] Code follows THIS codebase's conventions, not patterns cargo-culted from elsewhere
- [ ] No speculative abstraction (don't abstract before three concrete uses)
- [ ] No stale/deprecated patterns, especially in security-sensitive code (old hashing, deprecated auth flows)
- [ ] No secrets in code or logs

## 10. Definition of Done gate (report format)

The change is "done" only when:

- [ ] All acceptance criteria verified — positive AND negative scenarios
- [ ] Input Matrix run on every new/changed input; Unhappy Paths run on every operation
- [ ] No critical/blocker findings open
- [ ] Tests added/updated, all passing, and they'd fail if the feature broke
- [ ] Every finding reported as: **What? Where? Under what conditions?** + steps to reproduce + expected vs actual. One bug per finding — if you see two failures, write two findings.

---
