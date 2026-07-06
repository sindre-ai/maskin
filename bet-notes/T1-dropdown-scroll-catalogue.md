# T1 — Dropdown scroll catalogue & diagnosis

Investigation under bet `bet/dropdown-scroll`. Browser repro not run (dev stack
needs Docker, unavailable here); mechanism verified statically + via Tailwind v4
compile output (see "Verification" below).

## Primitives in `apps/web/src/components/ui/`

| File | Constraint | Scroll? |
|---|---|---|
| `select.tsx` line 69 | `max-h-[--radix-select-content-available-height]` + `overflow-y-auto` | **FAILS** — Tailwind v4 emits invalid `max-height: --radix-select-content-available-height;` (browser silently drops). No effective max-height → list overflows viewport with no scroll. |
| `dropdown-menu.tsx` line 64 | `max-h-[var(--radix-dropdown-menu-content-available-height)]` + `overflow-y-auto` | works |
| `popover.tsx` line 24 | (none) | **FAILS** — PopoverContent has neither `max-h-*` nor `overflow-y-auto`. Any list-shaped popover overflows. |
| `responsive-popover.tsx` (Sheet mode, <768px) | `max-h-[85dvh]` + `flex flex-col` | works (mobile only) |
| `responsive-popover.tsx` (Popover mode, ≥768px) | delegates to `popover.tsx` | **FAILS** (same root cause as popover.tsx) |

## Call sites in `apps/web/src/`

### Select (uses `select.tsx`) — 16 files, all **fail to scroll when overflowed**
- routes/_authed/$workspaceId/settings/members.tsx
- routes/_authed/$workspaceId/activity.tsx
- mcp-apps/shared/schema-select.tsx
- mcp-apps/schema/app.tsx
- components/triggers/trigger-form.tsx
- components/objects/object-document.tsx
- components/objects/metadata-properties.tsx
- components/objects/metadata-field-add.tsx
- components/objects/linked-objects.tsx
- components/objects/bulk-action-bar.tsx
- components/imports/import-dialog.tsx (the import-dialog's mapping selects — the originating Slack report)
- components/extensions/extension-removal-dialog.tsx
- components/agents/skills.tsx
- components/agents/mcp-servers.tsx
- components/agents/agent-document.tsx
- components/agents/agent-create-form.tsx

### DropdownMenu (uses `dropdown-menu.tsx`) — 7 files, **scroll when overflowed**
- routes/_authed/$workspaceId/settings/skills.tsx
- routes/_authed/$workspaceId/settings/members.tsx
- components/objects/data-table/display-panel.tsx
- components/objects/auxiliary-action-menu.tsx
- components/layout/nav-user.tsx
- components/layout/header.tsx
- components/chat/chat-panel.tsx

### Popover direct (uses `popover.tsx`) — 2 files, **fail to scroll when overflowed**
- components/files/annotation-overlay.tsx (annotation comment popover — long threads overflow)
- components/chat/slash-picker.tsx (slash command list)

### ResponsivePopover (uses `popover.tsx` on desktop) — 5 files, **fail on desktop, OK on mobile**
- components/triggers/searchable-multi-select.tsx (multi-select list)
- components/shared/date-range-picker.tsx (calendar — fixed height, low-risk)
- components/objects/data-table/display-panel.tsx (display panel — long column list)
- components/objects/data-table/data-table-controls.tsx (filter/sort controls)
- components/agents/skills.tsx (skill picker)

### Combobox / cmdk surfaces
- No `cmdk`/`Command*` JSX usage anywhere in `apps/web/src` — searchable lists are built on `Popover` + a manual list (e.g. `searchable-multi-select.tsx`). They inherit the `popover.tsx` failure.

## Diagnosis — two shared-primitive root causes

1. **`apps/web/src/components/ui/select.tsx` line 69** — uses Tailwind v4 invalid bracket syntax for CSS-variable values:
   - Authored: `max-h-[--radix-select-content-available-height]`
   - Tailwind v3 auto-wrapped `[--foo]` in `var()`. **Tailwind v4 does not** — `[--foo]` is the literal string `--foo`, which is an invalid `max-height` and is silently dropped by the browser. The `overflow-y-auto` then has no overflow trigger because the element has no max-height, so the content grows to its natural list height and extends beyond the viewport with no scrollbar.
   - The same broken pattern shows on line 69 `origin-[--radix-select-content-transform-origin]` (cosmetic — affects enter/exit animation transform origin only).
2. **`apps/web/src/components/ui/popover.tsx` line 24** — PopoverContent declares `w-72` and shadows/animations only. No `max-height`, no `overflow-y-auto`. Any popover whose children overflow the viewport (cmdk-like multi-selects, slash picker, annotation thread) cannot scroll.

`dropdown-menu.tsx` is unaffected because it was authored with the explicit `[var(--…)]` syntax for `max-h`. `responsive-popover.tsx` Sheet mode is unaffected because the mobile sheet has its own `max-h-[85dvh]`; only its desktop path (which renders `PopoverContent`) inherits the bug.

## Verification

Static, no browser needed. I compiled the two bracket forms with `npx @tailwindcss/cli` against `tailwindcss@4.3.2` (same major as the repo's `^4.2.3`):

```
.max-h-\[--radix-select-content-available-height\] {
  max-height: --radix-select-content-available-height;  /* invalid */
}
.max-h-\[var\(--radix-select-content-available-height\)\] {
  max-height: var(--radix-select-content-available-height);
}
.max-h-\(--radix-select-content-available-height\) {
  max-height: var(--radix-select-content-available-height);
}
```

This is the same major version pinned in `apps/web/package.json`. The compiled-CSS evidence above is mechanism-level proof: every Select surface lacks an effective max-height in v4 builds.

### Browser confirmation at 1280×700

Live confirmation followed in a standalone Vite + Playwright harness that imports the verbatim primitive source from `apps/web/src/components/ui/{select,dropdown-menu,popover}.tsx`. Each surface rendered with a 60-item or 1500px-tall list and was opened in a real Chromium under a 700px viewport.

| Surface | Computed `max-height` | `overflow-y` | Content rect bottom (viewport 700) | Scrolls? | Last item reachable? |
|---|---|---|---|---|---|
| Select | **`none`** (class on element, no effective value) | `auto` | **798** (overflows by 98px); `--radix-select-content-available-height` is correctly set to `626px` on the same element but ignored by the broken Tailwind class | NO | NO |
| DropdownMenu | `645px` (matches Radix var) | `auto` | 700 (clamped) | YES | YES (after scroll) |
| Popover | `none` | `visible` | **1589** (overflows by 889px) on 1500px-tall content | NO | NO |

The Select element carries the inline style `--radix-select-content-available-height: 626px` set by Radix Popper — confirming that Radix's measurement is correct and the bug is purely in the Tailwind class on the primitive, not in Radix or in any parent `overflow: hidden`. DropdownMenu serves as the controlled counter-example: same Radix layer, same containment, but the corrected `[var(--…)]` form clamps the content to 645px and scrolls.

## Prior fix (import-dialog) revisited

PR #865 wrapped the import dialog body in `flex-1 min-h-0 overflow-y-auto`. That made the **dialog body** scroll, which masked one symptom (long mapping form clipped at the dialog edge), but did not touch either failing primitive. The Select popovers inside the dialog were never the dialog-body scroll target — they portal to body. So the customer's "dropdowns still don't scroll" report after PR #865 is consistent: that fix didn't touch the layer where the bug lives.

When T2 fixes `select.tsx`, the dialog-body `overflow-y-auto` wrapper can stay (it's still correct for the mapping table when there are many columns).

## Scope decision for T2

**Shared-primitive fix across 2 files in `apps/web/src/components/ui/`** — within the bet's `≤3 distinct call sites` exit criterion. T2 patches:

1. `apps/web/src/components/ui/select.tsx`
   - Line 69: `max-h-[--radix-select-content-available-height]` → `max-h-(--radix-select-content-available-height)` (Tailwind v4 shorthand) **or** `max-h-[var(--radix-select-content-available-height)]` (explicit, matches `dropdown-menu.tsx`).
   - Same line: `origin-[--radix-select-content-transform-origin]` → `origin-(--radix-select-content-transform-origin)` (cosmetic, fix while in the file).
2. `apps/web/src/components/ui/popover.tsx`
   - Line 24: add `max-h-[var(--radix-popover-content-available-height)] overflow-y-auto` to `PopoverContent`'s className.
   - Same line: `origin-[--radix-popover-content-transform-origin]` → `(--radix-popover-content-transform-origin)` (cosmetic).

Optional housekeeping in T2 (cosmetic only, not scroll-blocking):
- `dropdown-menu.tsx` line 64: `origin-[--radix-dropdown-menu-content-transform-origin]` → `(--radix-dropdown-menu-content-transform-origin)`.

Both primitive fixes are 1–2 line CSS class changes. Acceptance for T2 = manual scroll repro on (a) import-dialog mapping selects, (b) annotation-overlay popover, plus a regression scan that opening/positioning/click-to-select don't change on a representative Select, DropdownMenu, and Popover surface.
