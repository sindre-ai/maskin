# Frontend — apps/web

## Product Philosophy
This is a **steering interface for humans overseeing autonomous agents**, not a task management app where humans do the work. Humans care about **bets** (strategic decisions) and only drill into details when needed. Agents handle insights and tasks autonomously.

### Design Principles
1. **Bet-centric** — Bets are the default view. Insights and tasks are secondary, accessible on demand.
2. **Event-driven visibility** — Show things when they matter. Don't show everything all the time.
3. **Instant feedback** — Every action is optimistic. SSE drives real-time updates. No loading spinners for mutations.
4. **Linear/Apple aesthetic** — Clean, minimal, monospace accents, tight spacing, keyboard-driven.
5. **Light/dark mode** — Defaults to light. User can choose system/light/dark in settings. Both modes are first-class.
6. **Glassmorphism** — Overlays and command palette use glass/blur effects (frosted-glass-on-white in light, dark translucent in dark). Sidebar is solid.
7. **Document-first detail** — Each object opens as a Notion-like document: title, dynamic metadata badges, markdown content, linked objects.
8. **Composable-ready** — Architecture the component system so blocks/views can be added incrementally.

## Retired UI surfaces
- **Pulse notifications** — the `PulseCard` / `PulseFilters` / `DecisionPoint` UI on the `/$workspaceId` landing page was retired in PR #428 in favor of the Slack-style unread thread stream (`UnreadThreadCard`). The backend is **still live**: the `notifications` table, `/api/notifications` routes, `useNotifications` / `useRespondNotification` / `useUpdateNotification` hooks, and `PulseCard` component remain so agents can keep emitting notifications and external surfaces (e.g. MCP) can still consume them. Do not re-introduce a Pulse panel on a primary route without a product decision — and if you do, reuse the existing components rather than rebuilding them.

## Tech Stack
- React 19 + TypeScript (strict)
- TanStack Router (file-based routing, auto-generated `routeTree.gen.ts`)
- TanStack Query (server state, caching, optimistic updates)
- TanStack Virtual (virtualized lists)
- Tailwind CSS 4 (Vite plugin, NOT PostCSS)
- shadcn/ui components (Radix UI primitives + Tailwind, light/dark theme) in `src/components/ui/`
- Lucide React for icons
- Biome for linting/formatting (same as backend — tabs, single quotes, no semicolons)
- Vite dev server on port 5173, proxies `/api` to backend on port 3000

## API & Backend Contract
- **API client**: `src/lib/api.ts` — typed `api` object with methods for every resource. All API calls go through here.
- **Zod schemas (source of truth)**: `packages/shared/src/schemas/` — these define the shape of every API request/response:
  - `packages/shared/src/schemas/objects.ts` — createObjectSchema, updateObjectSchema
  - `packages/shared/src/schemas/actors.ts` — createActorSchema
  - `packages/shared/src/schemas/workspaces.ts` — createWorkspaceSchema, updateWorkspaceSchema
  - `packages/shared/src/schemas/relationships.ts` — createRelationshipSchema
  - `packages/shared/src/schemas/triggers.ts` — createTriggerSchema, updateTriggerSchema
  - `packages/shared/src/schemas/events.ts` — event schemas
- **Backend route handlers**: `apps/dev/src/routes/` — if you need to understand what the API actually does, read these
- **TypeScript types**: `src/types/api.ts` + interfaces at bottom of `src/lib/api.ts` — derived from backend response shapes

## Auth Pattern
- API key stored in localStorage (`maskin-api-key`)
- Actor info stored in localStorage (`maskin-actor`)
- `src/lib/auth.ts` — getApiKey(), setApiKey(), isAuthenticated(), getStoredActor(), clearAuth()
- Auth guard: `src/routes/_authed.tsx` — redirects to `/login` if no API key
- Bearer token sent on every request via `api.ts` request wrapper
- Signup creates a new actor + returns API key; login is not yet implemented (API key only)

## Routing
- File-based routing in `src/routes/`
- `__root.tsx` — root layout
- `_authed.tsx` — auth guard layout (all workspace routes nested under this)
- `_authed/$workspaceId.tsx` — workspace layout with sidebar, provides WorkspaceContext
- Route tree is auto-generated — do NOT edit `routeTree.gen.ts` manually
- Workspace ID is a URL param (`$workspaceId`), accessed via `useWorkspace()` hook or route params

## State Management
- **Server state**: TanStack Query exclusively — no Redux, no Zustand
- **Query keys**: centralized in `src/lib/query-keys.ts` — always use these, never inline query keys
- **Hooks per resource**: `src/hooks/use-objects.ts`, `use-workspaces.ts`, `use-actors.ts`, etc. — each hook wraps TanStack Query with the correct query key + API call
- **Mutations**: defined in the same hook files, handle cache invalidation via queryKeys
- **Optimistic updates**: used for `useUpdateObject` — cancel query, set optimistic data, rollback on error
- **Workspace context**: `src/lib/workspace-context.ts` — React Context providing current workspace + ID

## Real-time (SSE)
- `src/lib/sse.ts` — SSE connection using `@microsoft/fetch-event-source`
- `src/lib/sse-invalidation.ts` — maps SSE events to TanStack Query cache invalidations by entity type
- `src/hooks/use-sse.ts` — hook that connects SSE and triggers invalidation
- Pattern: SSE events arrive → `invalidateFromSSE()` invalidates the right query keys → components re-render with fresh data

## Design System & Styling

### Theming Architecture
- **Theme provider**: `src/lib/theme.tsx` — `ThemeProvider` + `useTheme()` hook
- **Modes**: `system` | `light` | `dark` — stored in localStorage (`maskin-theme`), default is `light`
- **CSS architecture**: `@theme inline` maps Tailwind tokens to CSS variables; `:root` defines light values, `.dark` overrides for dark mode
- **FOUC prevention**: inline script in `index.html` applies `.dark` class before first paint

### Color Tokens (defined in `src/app.css`)
- Backgrounds: `bg`, `bg-surface`, `bg-hover`, `bg-glass`, `bg-glass-heavy`
- Borders: `border`, `border-hover`, `border-focus`
- Text: `text` (primary), `text-secondary`, `text-muted`
- Accent: `accent` (indigo), `accent-hover`
- Status: `success`, `warning`, `error`
- Status badges: `status-{name}-bg` / `status-{name}-text` for each workflow status
- Type badges: `type-{insight|bet|task}-bg` / `type-{insight|bet|task}-text`
- Shadows: `shadow-sm`, `shadow-md`, `shadow-lg` — adapt per mode (more visible in light, subtle in dark)
- **Color token pairing rule**: `bg-X` must pair with `text-X-foreground` — e.g. `bg-accent` + `text-accent-foreground`, `bg-primary` + `text-primary-foreground`. Mismatching (e.g. `bg-accent` + `text-primary-foreground`) causes contrast issues.

### Visual Style
- Light/dark mode with full token parity — both are first-class citizens
- Light mode: clean white (Linear-inspired), pastel status badges, visible shadows
- Dark mode: zinc/neutral base, indigo accent, deep status badge colors, subtle shadows
- Glassmorphism: `glass` and `glass-heavy` utility classes (frosted-white in light, dark translucent in dark)
- Minimal, Linear-inspired aesthetic — clean lines, subtle borders, generous spacing
- Fonts: Schibsted Grotesk (sans), JetBrains Mono (mono) — see `src/styles/typography.md` for the full spec
- Border radius: 6px (Linear-style) — `--radius: 0.375rem`
- Subtle transitions: `transition-colors duration-150` on all elements (base layer)

### Component Conventions
- **Full rules**: see `.claude/rules/frontend.md` — component reuse hierarchy, DRY, and consistency rules
- **Reuse first** — always use existing components before creating new ones. Creating a new component should be extremely rare. See `.claude/rules/frontend.md` for the full reuse hierarchy.
- **shadcn/ui built on Radix UI** — all UI primitives use Radix UI under the hood. Use them plain with default variants and sizes. Never use raw HTML form elements (`<select>`, `<dialog>`, `<input type="checkbox">`), always use the Radix-based equivalent from `src/components/ui/`.
- **UI primitives** in `src/components/ui/` — shadcn/ui components (light/dark theme via CSS variables)
  - Add new components via `npx shadcn@latest add <component>` — do NOT hand-write UI primitives
  - Customized with the project's color tokens (bg, bg-surface, border, text, accent, etc.)
  - Keep primitives simple — no business logic, just styling + HTML attributes
  - Don't wrap these in custom abstractions — use `<Button>`, `<Card>`, `<Dialog>` directly
- **Shared components** in `src/components/shared/` — list the directory to see what's available
- **Feature components** in `src/components/{feature}/` — check existing feature directories before creating new ones
- Use `cn()` from `src/lib/cn.ts` (clsx + tailwind-merge) for conditional class merging
- Icons from `lucide-react`, typically `size={15}` in nav, `size={16}` in content
- **No raw HTML form elements** — never use `<select>`, always use Radix `Select` from `@/components/ui/select`. DropdownMenu is only for action menus (not form value selection).
- **No custom size overrides on SelectTrigger** — use the default h-8 bordered trigger everywhere. Layout classes like `flex-1` or `w-fit` are fine, but don't override height/border/text-size.

### Layout
- Fixed sidebar (w-56) with solid background (`bg-bg-surface`) and right border, left side
- Sidebar is collapsible — shows icons only when collapsed (TODO: implement collapse toggle)
- Content area scrolls independently
- Page headers via `src/components/layout/page-header.tsx`
- Command palette (cmdk) available globally

### Responsive (mobile + iPad)
The app is targeted at three reference viewports: **375px** (iPhone portrait), **768px** (iPad portrait), **1024px** (iPad landscape). Every surface must work at all three.

**Breakpoints — Tailwind defaults only.**
| Token | Min width | Use for |
|-------|-----------|---------|
| (none) | 0 | Single-column mobile (≤640px) — the default |
| `sm:` | 640px | Large phones |
| `md:` | 768px | iPad portrait — desktop layout starts here |
| `lg:` | 1024px | iPad landscape, small laptops |
| `xl:` | 1280px | Standard desktop |

Do not introduce custom breakpoints. The `useIsMobile()` hook in `src/hooks/use-mobile.tsx` (boundary: 768px = Tailwind `md`) is the single source of truth when JS needs to know the viewport class — never read `window.innerWidth` directly.

**The single-column rule.** Below `md` (≤767px) every surface collapses to one column. Multi-column grids opt *in* to additional columns with `md:` / `lg:` — never opt out of mobile collapse. Pattern: `grid gap-4 md:grid-cols-2` ✅, `grid grid-cols-3` ❌. The bet's chosen direction is full feature parity in a single column on mobile — no bespoke mobile variants.

**Never overflow the viewport horizontally.** Content that scrolls horizontally must do so *inside its own contained box* (e.g. a table with `overflow-auto` on its wrapper, a tab strip with `overflow-x-auto`). The page itself must never produce a horizontal scrollbar. Specifically:
- Avoid `min-w-[...px]` on direct children of the page body. If a table needs a minimum width, wrap it in `overflow-x-auto` so the overflow is contained.
- `w-[Npx]` and `min-w-[Npx]` literals are smells — prefer `w-full sm:w-[Npx]` so mobile gets fluid width.
- Use `min-w-0` on flex children that hold ellipsis-truncated text (already the pattern in `object-document.tsx`).

**Dialogs, sheets, popovers.** On mobile, large dialogs feel wrong and popovers miss the thumb zone. Conventions (implemented progressively across the bet):
- A `Dialog` whose content would clip on mobile becomes a `Sheet` (bottom on mobile, content-sized up to 85dvh, rounded top corners) via `ResponsiveDialog` from `@/components/ui/responsive-dialog`. Small confirm dialogs stay as `Dialog`.
- A `Popover` used as a *form control* (date picker, multi-select) becomes a bottom `Sheet` on mobile. A `Popover` used as a hover/info card stays a `Popover`.
- A `DropdownMenu` is fine on mobile — it auto-positions and doesn't claim too much space.
- Any dialog/sheet with horizontally-scrolling content inside (like the import preview table) must wrap that content in `overflow-x-auto`, not extend the dialog body itself.

**Sidebars are drawers on mobile.** The app sidebar (left) and the Sindre panel (right) both use the shadcn `Sidebar` primitive, which auto-becomes a Radix `Sheet` below 768px. Don't add a second mobile-only sidebar implementation — extend the primitive.

**Headers, breadcrumbs, dense rows.** Breadcrumbs and other long-text rows are hidden below `md:` (see `header.tsx`); replace with a single-level page label if mobile needs context. Action button clusters in the header use the same `h-7 w-7` ghost-icon sizing — touch targets land at 28px which is borderline; pair them with `aria-label` and don't shrink further.

**Tables.** Tables live inside `overflow-auto` wrappers (see `data-table.tsx`, `related-objects-table.tsx`). Column widths use truncate + `max-w-[150px] sm:max-w-[300px]` so cells get more space on larger screens. Don't add `table-fixed` without explicit need.

**Viewport meta** is set in `apps/web/index.html` (`width=device-width, initial-scale=1.0`). Do not change it without a product reason.

### Responsive (mobile + iPad)
The app is targeted at three reference viewports: **375px** (iPhone portrait), **768px** (iPad portrait), **1024px** (iPad landscape). Every surface must work at all three.

**Breakpoints — Tailwind defaults only.**
| Token | Min width | Use for |
|-------|-----------|---------|
| (none) | 0 | Single-column mobile (≤640px) — the default |
| `sm:` | 640px | Large phones |
| `md:` | 768px | iPad portrait — desktop layout starts here |
| `lg:` | 1024px | iPad landscape, small laptops |
| `xl:` | 1280px | Standard desktop |

Do not introduce custom breakpoints. The `useIsMobile()` hook in `src/hooks/use-mobile.tsx` (boundary: 768px = Tailwind `md`) is the single source of truth when JS needs to know the viewport class — never read `window.innerWidth` directly.

**The single-column rule.** Below `md` (≤767px) every surface collapses to one column. Multi-column grids opt *in* to additional columns with `md:` / `lg:` — never opt out of mobile collapse. Pattern: `grid gap-4 md:grid-cols-2` ✅, `grid grid-cols-3` ❌. The bet's chosen direction is full feature parity in a single column on mobile — no bespoke mobile variants.

**Never overflow the viewport horizontally.** Content that scrolls horizontally must do so *inside its own contained box* (e.g. a table with `overflow-auto` on its wrapper, a tab strip with `overflow-x-auto`). The page itself must never produce a horizontal scrollbar. Specifically:
- Avoid `min-w-[...px]` on direct children of the page body. If a table needs a minimum width, wrap it in `overflow-x-auto` so the overflow is contained.
- `w-[Npx]` and `min-w-[Npx]` literals are smells — prefer `w-full sm:w-[Npx]` so mobile gets fluid width.
- Use `min-w-0` on flex children that hold ellipsis-truncated text (already the pattern in `object-document.tsx`).

**Dialogs, sheets, popovers.** On mobile, large dialogs feel wrong and popovers miss the thumb zone. Conventions (implemented progressively across the bet):
- A `Dialog` whose content is taller than ~75vh on mobile becomes a `Sheet` (full-screen on mobile). Small confirm dialogs stay as `Dialog`.
- A `Popover` used as a *form control* (date picker, multi-select) becomes a bottom `Sheet` on mobile. A `Popover` used as a hover/info card stays a `Popover`.
- A `DropdownMenu` is fine on mobile — it auto-positions and doesn't claim too much space.
- Any dialog/sheet with horizontally-scrolling content inside (like the import preview table) must wrap that content in `overflow-x-auto`, not extend the dialog body itself.

**Sidebars are drawers on mobile.** The app sidebar (left) and the Sindre panel (right) both use the shadcn `Sidebar` primitive, which auto-becomes a Radix `Sheet` below 768px. Don't add a second mobile-only sidebar implementation — extend the primitive.

**Headers, breadcrumbs, dense rows.** Breadcrumbs and other long-text rows are hidden below `md:` (see `header.tsx`); replace with a single-level page label if mobile needs context. Action button clusters in the header use the same `h-7 w-7` ghost-icon sizing — touch targets land at 28px which is borderline; pair them with `aria-label` and don't shrink further.

**Tables.** Tables live inside `overflow-auto` wrappers (see `data-table.tsx`, `related-objects-table.tsx`). Column widths use truncate + `max-w-[150px] sm:max-w-[300px]` so cells get more space on larger screens. Don't add `table-fixed` without explicit need.

**Viewport meta** is set in `apps/web/index.html` (`width=device-width, initial-scale=1.0`). Do not change it without a product reason.

## File Organization
```
src/
  components/
    ui/           # Design system primitives (Button, Card, Badge, Dialog, Input)
    shared/       # Reusable business components (StatusBadge, EmptyState, etc.)
    layout/       # Sidebar, PageHeader, WorkspaceSwitcher
    objects/      # Object CRUD components
    bets/         # Bet-specific views
    agents/       # Agent cards, pulse indicator
    activity/     # Activity feed
  hooks/          # TanStack Query hooks (one file per resource)
  lib/            # Utilities, API client, auth, SSE, query config
  routes/         # TanStack Router file-based routes
  types/          # Additional TypeScript types
```

## Rules
- **Reuse over creation** — always search for and use existing components, hooks, and utilities before creating new ones. Consistency and DRY are the top priorities. See `.claude/rules/frontend.md`
- Always use the `api` object from `src/lib/api.ts` for API calls — never raw fetch
- Always use `queryKeys` from `src/lib/query-keys.ts` — never inline cache keys
- Always use `cn()` for combining Tailwind classes — no custom CSS files, no inline `style={}`
- Always use semantic color tokens (e.g., `text-text-secondary`, `bg-bg-surface`) — never hardcode hex values
- Always use `useWorkspace()` to get workspace context — never parse URL params directly
- Same component for the same purpose everywhere — no one-off alternatives
- New hooks go in `src/hooks/`, new UI primitives in `src/components/ui/`, new shared components in `src/components/shared/`
- `routeTree.gen.ts` is auto-generated by TanStack Router Vite plugin — never edit it
- Path alias `@` maps to `src/` — always use `@/` imports (e.g., `@/lib/api`, `@/components/ui/button`)

## Testing
- **Framework**: Vitest + React Testing Library + jsdom
- **Full conventions**: see `.claude/rules/testing.md`
- **Test pyramid**: lib utilities first → hooks → components (build from pure functions up)
- **Run**: `cd apps/web && pnpm vitest run`

### Test file locations
- Lib/utility tests: `src/__tests__/lib/{module}.test.ts`
- Hook tests: `src/__tests__/hooks/{hook}.test.ts`
- Component tests: `src/__tests__/components/{feature}/{component}.test.tsx`

### Patterns
- Mock `@/lib/api` at module level with `vi.mock` — never make real API calls
- Test hooks with `renderHook` from `@testing-library/react` wrapped in `TestWrapper` (provides `QueryClientProvider` with retry: false)
- Test components with `render` + query by role/text — never use test IDs
- Use `createTestQueryClient()` from `src/__tests__/setup.ts` for fresh query clients
