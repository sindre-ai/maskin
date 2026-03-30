# Frontend Rules — Component Reuse & Consistency

## Core Principle: Reuse Everything, Create Nothing (Unless Absolutely Necessary)

The #1 frontend rule is **DRY and consistency**. Before building anything new, exhaust every existing option. Creating a new component should be extremely rare and requires a strong, specific justification.

## Component Reuse Hierarchy

When implementing any UI, follow this order strictly:

1. **Use existing shadcn/ui primitives** (`src/components/ui/`) — plain, as-is, with default variants and sizes
2. **Use existing shared components** (`src/components/shared/`) — these already solve common business UI needs
3. **Use existing feature components** (`src/components/{feature}/`) — check if another feature already built what you need
4. **Compose existing components** — combine primitives and shared components before inventing new ones
5. **Create a new component** — absolute last resort. Must be justified by a genuinely new pattern that no existing component covers

### When is it OK to create a new component?

Only when ALL of these are true:
- No existing component (ui, shared, or feature) can serve the need
- The pattern will be reused in multiple places (not a one-off)
- It cannot be achieved by composing existing components

## shadcn/ui — Use As-Is

shadcn/ui components are built on **Radix UI** primitives and are the foundation of the design system.

- **Use them plain** — default variants, default sizes. Don't override height, border, padding, or text size
- **Don't wrap shadcn/ui in custom abstractions** — use `<Button>`, `<Card>`, `<Dialog>` directly. Don't create `<MyButton>` or `<CustomDialog>`
- **Add new primitives via CLI** — `npx shadcn@latest add <component>`. Never hand-write a UI primitive
- **All interactive elements use Radix** — never use raw HTML `<select>`, `<dialog>`, `<input type="checkbox">`, etc. Always use the Radix-based equivalent from `src/components/ui/`

## Finding Existing Components

Before creating anything new, search for what already exists:

- **UI primitives**: list `apps/web/src/components/ui/` — these are shadcn/ui components
- **Shared components**: list `apps/web/src/components/shared/` — reusable business UI
- **Feature components**: list `apps/web/src/components/` — check if another feature already built what you need
- **Hooks**: list `apps/web/src/hooks/` — data-fetching and mutation logic
- **Utilities**: list `apps/web/src/lib/` — `cn()`, `api`, `queryKeys`, etc.

## DRY & Consistency Rules

- **Same component, same purpose, everywhere** — if StatusBadge shows statuses in one place, it shows them everywhere. No one-off alternatives
- **Search before creating** — before writing a new component, hook, or utility, search for existing ones that do the same thing
- **Reuse hooks** from `src/hooks/` — never duplicate data-fetching logic. If a hook doesn't exist for a resource, add a function to the existing hook file
- **Reuse utilities** from `src/lib/` — `cn()`, `api`, `queryKeys`, `formatEvent`, etc. are all centralized for a reason
- **Consistent patterns** — if existing components use a particular pattern (e.g., `cn()` for classes, `lucide-react` for icons, semantic color tokens), all new code must follow the same pattern
- **No custom CSS files** — all styling through Tailwind classes and `cn()`. No `.module.css`, no `styled-components`, no inline `style={}`
- **No one-off abstractions** — don't create a utility or wrapper for something that's used in only one place
