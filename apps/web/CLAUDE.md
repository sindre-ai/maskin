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
- API key stored in localStorage (`ai-native-api-key`)
- Actor info stored in localStorage (`ai-native-actor`)
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
- **Modes**: `system` | `light` | `dark` — stored in localStorage (`ai-native-theme`), default is `light`
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

### Visual Style
- Light/dark mode with full token parity — both are first-class citizens
- Light mode: clean white (Linear-inspired), pastel status badges, visible shadows
- Dark mode: zinc/neutral base, indigo accent, deep status badge colors, subtle shadows
- Glassmorphism: `glass` and `glass-heavy` utility classes (frosted-white in light, dark translucent in dark)
- Minimal, Linear-inspired aesthetic — clean lines, subtle borders, generous spacing
- Fonts: Inter (sans), JetBrains Mono (mono)
- Border radius: 6px (Linear-style) — `--radius: 0.375rem`
- Subtle transitions: `transition-colors duration-150` on all elements (base layer)

### Component Conventions
- **UI primitives** in `src/components/ui/` — shadcn/ui components (light/dark theme via CSS variables)
  - Add new components via `npx shadcn@latest add <component>` — do NOT hand-write UI primitives
  - Customized with the project's color tokens (bg, bg-surface, border, text, accent, etc.)
  - Keep primitives simple — no business logic, just styling + HTML attributes
- **Shared components** in `src/components/shared/` — ActorAvatar, StatusBadge, TypeBadge, EmptyState, LoadingSkeleton, RelativeTime, MarkdownContent, RouteError
- **Feature components** in `src/components/{feature}/` — objects/, bets/, agents/, activity/, layout/
- Use `cn()` from `src/lib/cn.ts` (clsx + tailwind-merge) for conditional class merging
- Icons from `lucide-react`, typically `size={15}` in nav, `size={16}` in content

### Layout
- Fixed sidebar (w-56) with solid background (`bg-bg-surface`) and right border, left side
- Sidebar is collapsible — shows icons only when collapsed (TODO: implement collapse toggle)
- Content area scrolls independently
- Page headers via `src/components/layout/page-header.tsx`
- Command palette (cmdk) available globally

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
- Always use the `api` object from `src/lib/api.ts` for API calls — never raw fetch
- Always use `queryKeys` from `src/lib/query-keys.ts` — never inline cache keys
- Always use `cn()` for combining Tailwind classes
- Always use semantic color tokens (e.g., `text-text-secondary`, `bg-bg-surface`) — never hardcode hex values
- Always use `useWorkspace()` to get workspace context — never parse URL params directly
- New hooks go in `src/hooks/`, new UI primitives in `src/components/ui/`, new shared components in `src/components/shared/`
- `routeTree.gen.ts` is auto-generated by TanStack Router Vite plugin — never edit it
- Path alias `@` maps to `src/` — always use `@/` imports (e.g., `@/lib/api`, `@/components/ui/button`)
