# Runtime Verification — Mandatory Gates

Agents must produce executable evidence before marking work done or opening a PR. "PASS (code-inspection)" is not a terminal state.

## When these rules apply

Apply the rules below when your change touches **any** of:
- `packages/db/schema` (Drizzle schema file)
- A migration `.sql` file in `packages/db/drizzle/`
- A route or service file that performs DB writes (INSERT / UPDATE / DELETE / upsert)
- A frontend surface visible to users (page, component, layout)

---

## Backend / DB changes → integration test required

**Rule:** Any change to schema, a migration, or a DB-writing route/service **must add or extend** an integration test in `apps/dev/src/__tests__/integration/` that exercises the change against real Postgres.

The integration harness (`global-setup.ts`) drops/recreates the public schema and replays every migration in order on each run — it is the only harness that can catch the DB-semantics failure classes documented in `.claude/rules/known-pitfalls.md`:
- Unique-constraint semantics
- FK cascade / ON DELETE behaviour
- `ON CONFLICT` correctness
- Correlated subquery rendering (unqualified column references)
- `pg_notify` payload-size rollbacks

### What the integration test must verify

Cover at minimum:
- **Happy path** — the operation succeeds and returns the correct result
- **The specific DB semantic your change depends on** — if you added a unique index, assert a duplicate insert fails; if you changed an FK's cascade rule, assert the cascade fires correctly; if you added an `ON CONFLICT`, assert the conflict branch executes

### How to run in-session (local dev only)

```bash
pnpm test:integration -- --run
```

This requires `DATABASE_URL` to be set to the running compose Postgres (available when the stack is up via `pnpm dev`). The CI gate runs the same tests automatically — the in-session run is optional fast feedback.

**CI is the hard gate.** The `integration-tests` job in CI runs these tests against `postgres:16-alpine` on every PR. A PR where the integration test suite fails cannot be considered done.

### Do NOT use mocked DB tests as a substitute

Mock DB tests (the ones in `apps/dev/src/__tests__/setup.ts` using `mockResults`) cannot catch the bug classes above. They are for route-level validation testing (auth, 404, input errors). Write integration tests for correctness of DB semantics.

---

## Frontend changes → E2E spec required

**Rule:** Any change to a user-visible frontend surface must add or extend a Playwright spec in `apps/e2e/src/tests/` that asserts the surface works correctly at the three ship-gate viewports (375px / 768px / 1024px).

Use the existing helpers:
- `SHIP_GATE_VIEWPORTS` from `helpers/viewports.ts` for the viewport loop
- `auth.fixture` for seeded actor + workspace context
- `TestAPI` from `helpers/api.helper.ts` for data seeding

### What the E2E spec must assert (not just "page loads")

- **Interaction:** the feature works when interacted with (click, drag, fill, submit). If it's drag/drop: assert the new order persists after a page reload.
- **Visibility at touch viewports:** controls must be reachable on touch (no opacity:0 or hover-only reveals). Use `toBeVisible()` which checks opacity + visibility.
- **Light and dark mode:** if the surface uses colour tokens (especially `bg-accent` or any custom colour), add `page.emulateMedia({ colorScheme: 'light' })` and `page.emulateMedia({ colorScheme: 'dark' })` assertions for key elements.

### Where specs go

New specs: `apps/e2e/src/tests/<feature>.spec.ts`

**Do NOT use the Playwright Healer or `--agents` flag** on the spec before committing. Only raw `playwright test` output counts as evidence. Auto-healed tests mask real failures.

**CI is the hard gate.** The `verify-e2e` CI job runs all specs via the full web+api stack on every PR. The in-session web server is not required; CI executes the specs as the impartial verifier.

---

## Evidence to attach to the PR

Include in the PR description or a PR comment:
- **Backend:** paste the `pnpm test:integration` output showing the new test name(s) and pass status
- **Frontend:** paste the Playwright run summary, or attach a screenshot of the surface at 375px and 1024px

CI uploads the full Playwright report (`playwright-report/`) + `trace.zip` automatically as artifacts on the `verify-e2e` job.
