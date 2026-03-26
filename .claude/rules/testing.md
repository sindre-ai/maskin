# Testing Conventions

## Test Frameworks
- **Unit + integration tests**: Vitest (all packages)
- **E2E tests**: Playwright (apps/e2e)
- **Frontend tests**: Vitest + React Testing Library + jsdom (apps/web)

## File Naming & Location

| Test type | Location pattern |
|-----------|-----------------|
| Backend unit (routes) | `apps/dev/src/__tests__/routes/{route}.test.ts` |
| Backend unit (services) | `apps/dev/src/__tests__/services/{service}.test.ts` |
| Backend unit (middleware) | `apps/dev/src/__tests__/middleware/{mw}.test.ts` |
| Backend unit (lib) | `apps/dev/src/__tests__/lib/{module}.test.ts` |
| Backend unit (other) | `apps/dev/src/__tests__/{module}.test.ts` |
| Backend integration | `apps/dev/src/__tests__/integration/{feature}.test.ts` |
| Package tests | `packages/{name}/src/__tests__/{module}.test.ts` |
| Frontend lib/utilities | `apps/web/src/__tests__/lib/{module}.test.ts` |
| Frontend hooks | `apps/web/src/__tests__/hooks/{hook}.test.ts` |
| Frontend components | `apps/web/src/__tests__/components/{feature}/{component}.test.tsx` |
| E2E | `apps/e2e/src/tests/{feature}.spec.ts` |

## Backend Unit Tests

Use the test infrastructure in `apps/dev/src/__tests__/`:

- **`setup.ts`** — `createTestApp()`, `createSessionTestApp()`, `createSkillsTestApp()` for route tests with mock DB and bypassed auth
- **`factories.ts`** — Row builders (`buildObject()`, `buildActor()`, `buildWorkspace()`, etc.) and request body builders (`buildCreateObjectBody()`, etc.) — never hardcode test data inline
- **`helpers.ts`** — `jsonRequest(method, path, body)`, `jsonGet(path)`, `jsonDelete(path)`

### What to test for every route
1. **Happy path** — correct response body and status code
2. **404** — resource not found returns 404
3. **400** — invalid request body returns validation error
4. **Auth/workspace** — non-member gets 403 or empty result

### Mock DB patterns
```ts
// Static result — every call returns the same data
mockResults.select = [row1, row2]

// Queued results — each call shifts the next value
mockResults.selectQueue = [
  [memberRow],     // first db.select()
  [workspaceRow],  // second db.select()
]

// Default — any unconfigured operation returns []
```

### Example structure
```ts
import { createTestApp } from '../setup'
import { buildObject, buildWorkspaceMember } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'

describe('GET /api/objects', () => {
  it('returns objects for workspace', async () => {
    const { app, mockResults } = createTestApp(routes, '/api')
    const member = buildWorkspaceMember({ actorId: 'test-actor-id' })
    const obj = buildObject()
    mockResults.selectQueue = [[member], [obj]]

    const res = await app.request(jsonGet('/api/objects', { 'X-Workspace-Id': obj.workspaceId }))
    expect(res.status).toBe(200)
  })
})
```

## Backend Integration Tests

- Use real PostgreSQL via `global-setup.ts` — runs migrations, creates test actor
- Use factory inserters: `insertActor(db)`, `insertWorkspace(db, actorId)`, `insertObject(db, wsId, actorId)`
- Each test must be independent — `beforeEach` creates a fresh workspace
- No shared mutable state between tests
- Config: `apps/dev/vitest.integration.config.ts` (30s timeout, forks pool)
- Run: `cd apps/dev && pnpm test:integration`

## Frontend Tests

### Priority order (test pyramid)
1. **Lib utilities** — pure functions first (`auth.ts`, `query-keys.ts`, `cn.ts`)
2. **Hooks** — data fetching and mutation logic (`use-objects.ts`, `use-workspaces.ts`)
3. **Components** — UI rendering and interaction (shared components first, then feature components)

### Hook testing pattern
```ts
import { renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'

// Mock the API module
vi.mock('@/lib/api', () => ({
  api: {
    objects: { list: vi.fn() },
  },
}))

import { api } from '@/lib/api'
import { useObjects } from '@/hooks/use-objects'
import { TestWrapper } from '../setup'  // QueryClientProvider wrapper

describe('useObjects', () => {
  it('fetches objects for workspace', async () => {
    vi.mocked(api.objects.list).mockResolvedValue([{ id: '1', title: 'Test' }])
    const { result } = renderHook(() => useObjects('workspace-1'), { wrapper: TestWrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toHaveLength(1)
  })
})
```

### Component testing pattern
```tsx
import { render, screen } from '@testing-library/react'
import { StatusBadge } from '@/components/shared/status-badge'

describe('StatusBadge', () => {
  it('renders status text', () => {
    render(<StatusBadge status="active" type="bet" />)
    expect(screen.getByText('active')).toBeInTheDocument()
  })
})
```

### Rules
- Query by role or text content, not test IDs
- Use `createTestQueryClient()` from test setup (retry: false, gcTime: 0)
- Mock `@/lib/api` at module level with `vi.mock`
- Wrap components needing queries in `TestWrapper`

## E2E Tests

- Use `TestAPI` helper from `apps/e2e/src/helpers/api.helper.ts` for data setup
- Use `createTestActor()` for actor creation
- Each test is self-contained — creates its own data via API
- Sequential execution, single Chromium worker
- Run: `pnpm test:e2e` (requires running dev server)

## General Rules

- `describe` block names the module or function under test
- Use `it('returns X when Y')` phrasing — describe the expected behavior
- No `test.skip` or `test.todo` in committed code without a linked issue
- Tests must not depend on execution order
- One assertion concept per test (multiple `expect` calls are fine if testing the same behavior)
- Use factories for test data — never hardcode UUIDs, emails, or names inline

## Run Commands

| Scope | Command |
|-------|---------|
| All unit tests | `pnpm test -- --run` |
| Backend unit tests | `cd apps/dev && pnpm vitest run` |
| Single backend test | `cd apps/dev && pnpm vitest run src/__tests__/routes/objects.test.ts` |
| Integration tests | `pnpm test:integration -- --run` (requires DATABASE_URL) |
| Frontend tests | `cd apps/web && pnpm vitest run` |
| E2E tests | `pnpm test:e2e` (requires running dev server) |
