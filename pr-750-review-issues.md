# PR #750 Review Issues

**PR:** Capture name/org/role on signup and emit ship-metric events
**Branch:** `task/71591c73-signup-form` → `bet/signup-capture-default-agents`

---

## Issue 1 — `ASSIGN_PATH` is dead code

**File:** `apps/web/src/__tests__/routes/signup.test.tsx`

The constant `ASSIGN_PATH = '/'` is declared at the top of the test file but never referenced anywhere in the test suite:

```ts
const ASSIGN_PATH = '/'
```

The `beforeEach` block mocks `window.location.assign` with a `vi.fn()`, which suggests the original intention was to assert that the signup flow redirects the user to `/` after a successful submission. That assertion was never written. As-is, the constant is misleading: a reader will spend time hunting for where it is used and find nothing.

**Options:**
- **Add the missing assertion** — after a successful submit, assert `expect(window.location.assign).toHaveBeenCalledWith(ASSIGN_PATH)`. This would also close a real coverage gap: the redirect behaviour is currently untested.
- **Remove the constant** — if the redirect is handled by TanStack Router internals that are already mocked and don't need an explicit assertion here, delete `ASSIGN_PATH` and the `vi.fn()` on `assign` to avoid confusion.

The first option is preferable because it turns a dead constant into a real assertion covering a user-visible behaviour.

---

## Issue 2 — `user_id: null` sent to PostHog on unexpected server response

**File:** `apps/web/src/routes/signup.tsx`

After a successful `signup()` call, the code emits the `signup_form_submitted` event:

```ts
const actorId = result?.id
// ...
trackEvent('signup_form_submitted', {
  user_id: actorId ?? null,
  completed: true,
})
```

`result?.id` will be `undefined` — and therefore `actorId ?? null` will produce `null` — if the signup API response does not include an `id` field. In that situation the event is emitted with `user_id: null`.

This is a problem for PostHog analytics. A `user_id: null` row will:
- Land in whatever person-profile PostHog infers for `null` if identify is called later.
- Be indistinguishable from a genuine anonymous event, making the `user_id` field unreliable as a join key when querying `signup_form_submitted`.
- Potentially pollute funnel analyses that filter on `user_id` being non-null.

This scenario (`signup` returns a response that passes without an `id`) should be treated as an unexpected error, not a silent graceful degradation.

**Recommended fix:**

```ts
const actorId = result?.id
if (!actorId) {
  console.error('[maskin] signup succeeded but returned no actor id; skipping submitted event')
  return
}
trackEvent('signup_form_submitted', {
  user_id: actorId,
  completed: true,
})
```

Alternatively, if the PostHog event is considered the more important signal and should always fire, at minimum add a comment explaining that `null` is an intentional sentinel and document what downstream queries should do with it.

---

## Issue 3 — Whitespace-only inputs not covered by validation tests

**Files:** `apps/web/src/__tests__/routes/signup.test.tsx`, `apps/web/src/routes/signup.tsx`

The new validation tests check that submitting without organization or role blocks form submission:

```ts
it('shows "Organization is required" when submitting without organization', ...)
it('shows "Role is required" when submitting without role', ...)
```

But neither test covers the whitespace-only case — a user entering `'   '` (spaces only) in the organization or role field. The `handleSubmit` function trims before checking:

```ts
const trimmedOrg = organization.trim()
if (!trimmedOrg) {
  setError('Organization is required')
  return
}
```

So `'   '` would correctly be caught and show the error message. The Zod schema in `signupCaptureInputSchema` also trims and enforces `min(1)`. Both layers handle whitespace correctly — but there is no test that proves it.

This gap matters because whitespace-only input is a common real-world mistake, especially in mobile keyboards that auto-insert a leading space. A test that passes `'   '` and asserts the error message appears gives confidence that the trim logic is wired up correctly end-to-end (form state → handleSubmit → error display).

**Recommended additions:**

```ts
it('shows "Organization is required" for whitespace-only organization', async () => {
  const user = userEvent.setup()
  render(<SignupPage />)
  await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
  await user.type(screen.getByPlaceholderText('Company or team'), '   ')
  await user.click(screen.getByRole('button', { name: 'Create account' }))
  expect(screen.getByText('Organization is required')).toBeInTheDocument()
  expect(mockSignup).not.toHaveBeenCalled()
})

it('shows "Role is required" for whitespace-only role', async () => {
  const user = userEvent.setup()
  render(<SignupPage />)
  await user.type(screen.getByPlaceholderText('Your name'), 'Test User')
  await user.type(screen.getByPlaceholderText('Company or team'), 'Test Co')
  await user.type(screen.getByPlaceholderText('What you do'), '   ')
  await user.click(screen.getByRole('button', { name: 'Create account' }))
  expect(screen.getByText('Role is required')).toBeInTheDocument()
  expect(mockSignup).not.toHaveBeenCalled()
})
```

---

## Issue 4 — Double validation between `handleSubmit` guards and Zod parse in builder

**Files:** `apps/web/src/routes/signup.tsx`, `packages/shared/src/schemas/signup-capture.ts`

There are two layers of validation for `name`, `organization`, and `role`, and they are inconsistent in what they do when they fire.

**Layer 1 — manual guards in `handleSubmit`:**

```ts
const trimmedName = name.trim()
const trimmedOrg = organization.trim()
const trimmedRole = role.trim()
if (!trimmedName) { setError('Name is required'); return }
if (!trimmedOrg)  { setError('Organization is required'); return }
if (!trimmedRole) { setError('Role is required'); return }
```

**Layer 2 — Zod parse inside `buildSignupCaptureKnowledge`:**

```ts
export function buildSignupCaptureKnowledge(input: SignupCaptureInput): SignupCaptureKnowledge {
  const { name, organization, role } = signupCaptureInputSchema.parse(input)
  // ...
}
```

`signupCaptureInputSchema` enforces `trim().min(1).max(200)`. If layer 1 passes (values are non-empty after trimming), layer 2 will always also pass for the `min(1)` constraint — so the Zod parse inside the builder is never the thing that catches a bad value coming from the form. The only scenario where the Zod parse would throw that layer 1 wouldn't catch is a value longer than 200 characters, which layer 1 has no guard for.

This creates two problems:

1. **Incomplete client-side validation** — the form will happily send a 500-character organization name to the API. The Zod parse in the builder will throw, but that throw is caught by the outer `try/catch` and logged silently — the user gets no feedback. There is no `max` guard in `handleSubmit`.

2. **Silent swallowing of the builder's validation error** — if the Zod parse in the builder throws for any reason (e.g., a future schema change tightens constraints), the `catch` block in `handleSubmit` logs `[maskin] failed to write signup capture knowledge` and continues. The user is never told, and the event fires as if everything succeeded.

**Recommended fix:**

Add `max(200)` guards to `handleSubmit` alongside the existing `min(1)` guards, so the form gives explicit user-facing feedback for over-length inputs:

```ts
if (trimmedOrg.length > 200) {
  setError('Organization must be 200 characters or fewer')
  return
}
```

Or, alternatively, enforce the max at the input level with `maxLength={200}` on the `<Input>` elements, which prevents the user from typing beyond the limit without requiring an explicit error message.

Either approach makes the two validation layers consistent and ensures that every validation failure produces user-visible feedback rather than a silent log line.
