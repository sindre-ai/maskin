# Agent Keychain — v1 user credential surface

**Bet:** [Agent Keychain](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/d46bb7f2-611b-417a-ba3c-049850b320fb)
**Prototype:** `prototypes/keychain-v1/index.html` (single file — open directly, use the top bar to switch view + viewport)
**Design PR:** *(this PR)*

## User + job

A workspace member — the human who runs Maskin loops — needs to give their agents a way to authenticate to external services (GitHub, Notion, Stripe, LinkedIn, …) without pasting the same secret into every session or, worse, letting the agent operate as *them*. They add a credential once, decide which agents/loops can reach it, and later audit exactly who used it. The Keychain is the trust surface: everything else in Layer 2 + 3 of the [MCP strategy](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/f9e2badc-dbf8-4945-aa82-656ccd18ffde) depends on it.

## Design system reuse

- **Reuses:** `<Card>`, `<Button>` (primary / secondary / ghost / outline / destructive + `sm`), `<Input>`, `<Label>`, `<Badge>` (status colour tokens), `<Tabs>` (pill variant, per `mcp-connection.tsx`), `<Sheet>`, `<Dialog>` (via `<ResponsiveDialog>`), `<Checkbox>`, `<RadioGroup>`, `<Popover>`, `<DropdownMenu>`, `<Select>`, `<Table>`, `<Skeleton>`, `<Spinner>`, `<Tooltip>`, `<EmptyState>` (shared), `<Breadcrumb>`, `<Sidebar>`. Neutral scale + `--brand` indigo + status badge tokens from `apps/web/src/app.css`. Row-with-status-dot pattern is copied verbatim from `settings/integrations.tsx` `ProviderRow`. Two-step wizard shape and copy-URL pattern are copied from `SkjaldConnectDialog`.
- **Extends:** `<Badge>` gains no new variants — reuses `active` / `processing` / `failed` / `paused` for connection status, plus `brand` for "OAuth" type chips. `<Sheet>` gets a keyboard-friendly slide-over role for the scope-picker; no new prop, just usage. A **credential list row** is a new usage of `<Card>` + grid that adds two columns (Type, Last used) to the existing single-row provider pattern — the pattern extends `ProviderRow` rather than replacing it, so a future refactor can share one component.
- **New patterns:**
  - **Blast-radius rule.** A left-ruled indigo call-out that shows the *live consequence* of the current scope selection ("2 agents selected · ~60 sess/wk"). Rationale: security-load-bearing decisions need to make consequence visible in the same frame as the action. The existing `<Alert>` pattern is passive; this one recomputes as the user checks agents. Component: `<ScopeBlastRadius>` — takes `agentIds[]`, resolves session/week counts from usage metrics, renders indigo left-rule + count. Landing in the design system.
  - **`revoke`-typed confirmation.** A modal that only enables the destructive button once the user types the literal word `revoke`. Rationale: existing destructive confirms in the app are single-click; revoking a credential unassigns from every agent and can silently break running loops. This is rare + expensive enough to warrant friction. Component: `<TypedConfirmDialog>` — takes `confirmWord`, `title`, `body`, `onConfirm`. Landing in the design system.
  - **Audit-log timeline row.** A `[timestamp · body · request-badges]` grid tuned for high-frequency log rendering. Distinct from the activity feed rows in `components/activity` because those aggregate events for humans, while this must render 1000s of raw reads with column-alignment (`tabular-nums`, mono timestamps). Landing in the design system as `<AuditLogRow>`.

## Flow

1. **First-time user** (state 1b, `landing-empty`) lands on `/settings/keychain` with an empty state → clicks **Add your first credential** → picks paste vs OAuth → arrives at (3) or (4).
2. **User with keys** (state 1, `landing`) sees the credential list, filters/sorts, and clicks any row → arrives at (5).
3. **Paste flow** (state 2a, `add-paste`) — name + service URL + auth method + secret + optional header override → **Save and assign scope** → sheet (6) opens.
4. **OAuth flow** (state 2b, `add-oauth`) — 4-step wizard: pick service → paste OAuth app client id/secret + copy redirect URL → authorize (opens new tab, in-app loading state, error state on `redirect_uri_mismatch`) → sheet (6) opens on return.
5. **Detail + audit** (state 4, `detail`) — metadata + scope + audit log timeline. Header actions: **Rotate** (7), **Revoke** (8).
6. **Scope sheet** (state 3, `scope`) — assign agents (canonical) and/or loops (macro over agents); live blast-radius count. **Save scope** → back to detail (5).
7. **Rotate confirm** (state 5a, `rotate`) — modal with new-secret field. One click.
8. **Revoke confirm** (state 5b, `revoke`) — modal with blast-radius warning + typed-word confirmation.
9. **Empty log** (state 4b, `detail-empty`) — how the detail page reads for a just-added credential nobody's used yet.
10. **Registry deep-link** (state 6, `registry`) — how the [MCP Registry](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/6b7e8339-8c7a-4981-b3f4-bdf9a5722321) surface pulls a user into (3)/(4) mid-install and returns them to the Registry when saved.

## States (per screen)

### 1. Landing (`landing` / `landing-empty`)
- **Default:** Table of credentials, each with icon · name · type badge · assigned agents (chips) · last used · status badge. Rows are `<a>` — click anywhere navigates to detail.
- **Hover:** Row background → `--muted`; cursor pointer.
- **Focus:** Row shows a 2px `--brand` outline offset; keyboard nav via arrow-up/down.
- **Loading:** `<Skeleton>` 6 rows using the existing `ListSkeleton`.
- **Error:** Full-page `<RouteError>` reusing the existing shared component.
- **Empty:** State `landing-empty` — hero icon + primary CTA + 3-card explanation strip.
- **Success (post-save toast):** `<Toast variant="success">` "Stripe · Sindre AI saved. 2 agents assigned." for 5 s; the new row is highlighted with a fade of `--brand-subtle` for 1.2 s (`duration-slide`, `ease-emphasized`).

### 2. Add credential — Paste (`add-paste`)
- **Default:** Two entry-mode cards at top (paste selected, OAuth navigates away). Form: Name, Service URL (optional), Auth method radio group (API key / Bearer / Basic), Secret (password + Show toggle), collapsible Header details, indigo fail-closed rule.
- **Hover:** Radio-group cards get border → `--border-hover`; the selected card keeps its indigo ring (`ring-2 ring-[var(--brand)]/25`).
- **Focus:** Every input uses the standard 3-px indigo shadow focus ring; radios use native focus.
- **Loading:** Test-connection button spinner-in-place for ≤5 s; Save button spinner + disabled.
- **Error:** Inline field errors under input in `--destructive` text; failed test-connection surfaces a `.danger-rule` block with the raw error message and a **Retry** link.
- **Empty:** N/A (form).
- **Success:** Route to scope sheet (3).

### 3. OAuth wizard (`add-oauth`)
Numbered horizontal stepper (Service · OAuth app · Authorize · Scope). Prototype shows step 2.
- **Default:** Service card + client id/secret inputs + copyable redirect URL + scope chips.
- **Hover / focus:** Standard.
- **Loading:** After **Authorize with LinkedIn**, in-app card with `<Spinner>` and copy "Waiting for LinkedIn to redirect back…" (see prototype `data-state-hidden` block).
- **Error:** Two named cases — `redirect_uri_mismatch` (surfaced with copy fix suggestion) and `user_denied` (soft, "no worries — try again or paste an API key instead").
- **Empty:** N/A (form).
- **Success:** Route to scope sheet (3), auto-filled with credential name from OAuth `userinfo`.

### 4. Scope assignment sheet (`scope`)
Right-hand `<Sheet>` on desktop/tablet; bottom-sheet-full on mobile (see Responsive). The most security-critical screen.
- **Default:** Header (credential icon + name + eyebrow "Assign scope"). Blast-radius rule shows live agent + session count. Tabs: **Agents** (default) / **Loops**. Filterable list of agents with checkboxes + avatar + name + role + session/week estimate. Collapsible "Also assign by loop" section explains that loop assignments resolve to their member agents (single mental model — agents are the boundary).
- **Hover:** Row background → `--muted`; checkbox border darkens.
- **Focus:** Checkbox uses native focus; row keyboard-navigable via j/k or arrow keys (reuses `useKeyboardShortcuts` from `command-palette.tsx`).
- **Loading:** Save-button spinner; agent list `<Skeleton>`.
- **Error:** Save failure → inline `.danger-rule` under footer with retry.
- **Empty:** "No agents in this workspace yet — [invite one or create an agent]."
- **Success:** Sheet closes with slide-right (`duration-slide`, `ease-emphasized`); toast in parent view.

### 5a. Rotate (`rotate`)
- **Default:** Modal, single field, one **Rotate now** button. No typed confirmation.
- **Loading / error / success:** Standard button spinner; on success close + toast "Rotated 2 s ago"; on error retain field state + `.danger-rule` under.

### 5b. Revoke (`revoke`)
- **Default:** Modal with `.danger-rule` block listing every affected agent + weekly session count, then a "type `revoke` to confirm" field. Destructive button is disabled until the exact word is typed.
- **Loading:** Button spinner during API call.
- **Error:** Inline error under the confirm field.
- **Success:** Close + navigate to landing + toast "Revoked. Audit log kept."

### 4 / 4b. Credential detail + audit log (`detail`, `detail-empty`)
- **Default (populated):** Left column — audit log with mono timestamps, session-link, target URL, HTTP verb badge + status badge (200 = `--st-active-*`, 401/403 = `--st-failed-*`). Right column — Details card + Scope card + Security card.
- **Empty log (4b):** Centered empty state with icon, "No reads yet" + two secondary CTAs (Test connection · Assign agents).
- **Hover:** Log rows get `--muted` background; a **Session** link shows a `<Tooltip>` with session outcome preview.
- **Focus:** Log rows are `<a>`, standard focus.
- **Loading:** `<Skeleton>` rows; header remains.
- **Error:** Row-level 401 rendered inline in status badge; full-page error via `<RouteError>`.
- **Success:** Rotate/revoke actions push the new state into this view; audit log auto-appends new reads via SSE (existing `PgNotifyBridge` — no new realtime plumbing).

### 6. Registry deep-link (`registry`)
- **Default:** MCP Registry surface with a top-of-page **scope-rule** call-out: "A Notion credential is required" + primary "Add Notion credential" (opens the picker modal, which then routes into (3)/(4)) + secondary "Use existing credential" (which opens a picker of already-in-keychain credentials for the same service).
- **Hover / focus / loading / error / empty:** Standard.
- **Success:** After the Keychain flow completes, user is returned to this exact URL (`?resume=install-notion&credential=<id>`) with the new credential pre-selected and the **Install** button unblocked.

## Responsive

- **Mobile (≤640px):** Single-column layout, sidebar becomes a top-bar hamburger. Credential list uses stacked-row (icon+name row, then chip-row of type · assigned · last-used · status). Add-credential form fills the viewport. Scope sheet slides up as a bottom sheet (full-height minus 10%). Rotate/Revoke modals stack from the bottom (per `<ResponsiveDialog>`). Filters collapse behind a **Filter** button that opens a sheet.
- **Tablet (641–1024px):** Sidebar becomes an icon rail (matches the current app's tablet layout). List is two-column: rest of the columns from desktop layout are collapsed into "meta row" under the credential name.
- **Desktop (>1024px):** Full sidebar, 5-column credential table, detail view uses `[1fr · 320px]` two-column grid (log + side panels).

## Copy

Every visible string in the prototype. If you see one in the built feature that isn't here, treat it as a bug.

- Page title: `Keychain`
- Page description: `Credentials your agents use to reach external services. Each key is encrypted at rest, assigned to specific agents or loops, and every use is logged.`
- Primary CTA: `Add credential`
- Empty-state title: `One place for every credential your agents need`
- Empty-state body: `Paste an API key or connect a service with OAuth. Assign it to specific agents or loops, and Maskin injects it into their runs — encrypted, scoped, and logged.`
- Empty-state CTAs: `Add your first credential` · `How security works`
- Empty-state cards: `Paste — API key, Bearer, or Basic Auth — For any service you have a raw secret for.` · `OAuth — Connect a service you own — Bring your OAuth app; we run the dance.` · `Scope — Fail-closed by default — New keys reach zero agents until you assign.`
- Toolbar labels: `Search credentials, services, agents…` · `Type` · `Status` · `Sort` · `Last used`
- List column headers (eyebrow): `Credential` · `Type` · `Assigned to` · `Last used` · `Status`
- Type badges: `API key` · `OAuth` · `Bearer` · `Basic`
- Status badges: `Connected` · `Expires in {n}d` · `Unassigned` · `Revoked` · `{n} last call` (for error codes like `401 last call`)
- Assignment chip empty: `No agents — fail-closed`
- Footer helper: `Encrypted at rest. Every use is logged. See any credential for its audit trail.`
- Add-credential entry cards: `Paste a secret` (`API key, Bearer token, or Basic Auth. Fastest for services you already have credentials for.`) · `Connect via OAuth` (`Bring your own OAuth app; Maskin runs the auth dance and stores the resulting tokens.`)
- Form labels: `Name` · `Service URL (optional)` · `Auth method` (radios: `API key` / `Bearer token` / `Basic auth`) · `Secret` · `Header details (optional)` (fields: `Header name`, `Value format`)
- Form helpers: `What agents will see. e.g. "Stripe · Sindre AI"` · `Base URL this credential authenticates against.` · `Encrypted at rest. Never displayed after save. Only shown as last-4.`
- Fail-closed rule: `Fail-closed by default. No agents can use this credential until you assign it on the next screen. Nothing runs until you say so.`
- Form actions: `Cancel` · `Test connection` · `Save and assign scope`
- OAuth stepper: `Service` · `OAuth app` · `Authorize` · `Scope`
- OAuth field labels: `Client ID` · `Client secret` · `Redirect URL — copy this into your OAuth app` · `Scopes`
- OAuth service hint: `You'll paste the client ID and secret from your own LinkedIn OAuth app. Maskin then runs the authorization flow and stores the resulting access + refresh tokens. Where do I find these?`
- OAuth CTA: `Authorize with {Service}`
- OAuth loading: `Waiting for {Service} to redirect back…` · `A new tab has opened. Complete the sign-in there and you'll return here automatically.`
- OAuth error (`redirect_uri_mismatch`): `Authorization failed: redirect_uri_mismatch. The redirect URL in your {Service} OAuth app doesn't match the one above. Copy it exactly and try again.` (link: `Retry`)
- Scope sheet: eyebrow `Assign scope` · title uses credential name · body `Pick who can use this credential. You can always change this later.`
- Blast-radius default: `Blast radius: 0 sessions per week. Nothing is authorised yet. As you check agents below, this number updates so you can see exactly what this key will unlock.`
- Scope tabs: `Agents` / `Loops`
- Loop-tab helper: `A loop assignment resolves to every agent that runs in it — you're picking a group, not a boundary. The agent list above reflects the final blast radius.`
- Scope footer: `{n} agents selected · ~{m} sess/wk` · `Skip — keep unassigned` · `Save scope`
- Detail header status hints: `pat_••••••••••••ZQ4a · github.com` (secret always shown as `<prefix>_••••••••<last4>` — never full)
- Detail actions: `Rotate` · `Revoke`
- Audit log heading: `Audit log` · body: `Every read of this credential, chronological. SOC 2 evidence.`
- Audit log row template: `{Agent} read this credential for {session-id} targeting {url}` + method + status badges + `trigger: {trigger-name}`
- Audit log actions: `Filter` · `Export CSV` · `Load {n} more entries`
- Empty log title: `No reads yet` · body: `Once an agent uses this credential, every request will show up here — session, target, method, and status.` · CTAs: `Test connection` · `Assign agents`
- Details card fields (label · value): `Service` · `Type` · `Created` · `Last used` · `Last 30 d`
- Scope card: `{n} agents can read this credential.` · action: `Edit`
- Security card items: `Encrypted at rest (AES-256)` · `Never injected into agent containers` · `Read scoped by actor_id`
- Rotate modal: title `Rotate {Credential name}` · body `Replace the secret. Scope, audit log, and assigned agents stay the same. No confirmation needed — rotation is safe and reversible via the log.` · field `New personal access token` · helper `The previous secret is revoked as soon as this saves. Any in-flight session with the old token will retry once.` · actions: `Cancel` · `Rotate now`
- Revoke modal: title `Revoke this credential?` · body `This is permanent for the assignment; the audit log is kept.` · warning header `{n} agents will lose access immediately` · warning body: line per agent with weekly session count · confirmation label `Type revoke to confirm` · actions: `Cancel` · `Revoke credential`
- Registry deep-link callout: title `A {Service} credential is required` · body `{Service} MCP calls {Service}'s API on your behalf. Add a {Service} integration secret to your Keychain, then continue installing the MCP.` · CTAs: `Add {Service} credential` · `Use existing credential` · hint: `You'll return here after saving.`
- Registry callout secondary: `Adding a credential from here writes it to your Keychain — you can revoke or reassign it later without breaking anything else.`

## Interaction details

- **Motion:** All colour + border transitions use `--duration-150 var(--ease-standard)`. Modal + sheet enter/exit use `--duration-slide` (300 ms) `var(--ease-emphasized)`. Row highlight after save uses a `fade` on `--brand-subtle` for 1.2 s. All animations honour `prefers-reduced-motion` (already global via `app.css` reduced-motion block — no per-component work).
- **Keyboard:** Landing list is arrow-up/down navigable, `Enter` opens detail, `n` opens Add-credential modal, `/` focuses filter. Scope sheet: `j`/`k` for row nav, `Space` toggles selection, `Escape` cancels, `⌘S` saves. Rotate modal: `Enter` submits after paste. Revoke modal: destructive button gets a native `disabled` until the typed-word matches. Tab order in every form matches DOM order; skip-to-content link at top.
- **Accessibility:**
  - Status badges have `aria-label` including the human phrase (`Connected · last used 2 minutes ago`), not just the visible short form.
  - Blast-radius rule has `role="status" aria-live="polite"` so screen-readers announce updates as agents are checked.
  - Revoke modal announces the affected-agent list via `aria-describedby`.
  - Contrast: every foreground/background pair passes WCAG AA at each theme (verified with `--brand` on `--card`, `--destructive` on `.danger-rule`, `--muted-foreground` on `--surface-sunken`).
  - Focus rings are 3-px `--brand`/20 shadow (already tokenised).
  - Icons are decorative (`aria-hidden`); their semantics come from adjacent text.
  - Every table row is an `<a>` with a meaningful href — never a `div` with `onClick`.

## Out of scope

- **Agent-generated identity provisioning UX** (follow-on bet). Landing surface has room for a future "Agent identities" tab next to "Credentials"; no wireframe here.
- **External secret-manager adapters** (1Password / Vault / AWS Secrets — follow-on bet). Add-credential picker leaves the third card intentionally empty.
- **Enterprise IAM / SSO federation** — out per bet body.
- **Cross-workspace credential sharing** — every credential is workspace-scoped, matching the current API.
- **Programmatic Keychain access from agents** — agents already read credentials via `getIntegrationCredential(...)` (see [Actor-scoped credential model task](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/9c25d5b3-df3d-4553-89f8-8b16fab32ee4)); this bet is the human UX for those rows.
- **Bulk actions** (multi-select revoke, bulk reassign) — the list supports single-row actions only for v1. If audit shows users routinely revoking >3 at a time, revisit.

## Open questions

1. **Loops as first-class scope, or macro-only?** The prototype models loop assignment as a *macro* that expands to per-agent assignments (agents are the single boundary). If we ever want a loop assignment to remain a live edge (so adding a new agent to the loop auto-grants credential access), we need a different data model. The task spec's `actor_id` primitive locks us in to per-agent, which is why I went macro. Ask Developer whether the DB path allows a `loop_id` column addition later without a migration nightmare.
2. **Rotate: prior secret grace period?** The rotate flow revokes the old secret immediately. If a session is in-flight and mid-request, we retry once. Is that the behaviour Developer will actually implement, or do we need a 60-s dual-valid window? Copy in the rotate modal claims immediate — I'd rather change the copy than under-promise.
3. **Audit log retention.** SOC 2 typically wants ≥1 year. The `Load 218 more entries` pagination assumes we keep everything indefinitely; if we ever truncate, this UI needs a "log truncated at {date}" band. Confirm with Architect on the events-table retention policy.
4. **OAuth "bring your own client" vs "Maskin-brokered".** The prototype assumes user pastes their own OAuth app credentials (consistent with the GSC user-brokered-OAuth ADR-006). For services where Maskin holds a shared OAuth client (Google, Slack), the wizard should skip step 2 entirely. I've designed step 2 as the harder path; the shared-client shortcut is a UX simplification — flag for Developer whether both paths land in v1 or only user-brokered.
5. **"Test connection" behaviour for OAuth credentials.** The paste form has a Test button; OAuth credentials get validated on save (the auth dance itself). Detail page also shows Test on the empty log state. For OAuth, "test" would mean calling a canonical `whoami` endpoint per service — do we have a per-provider adapter for that, or is it a v2 concern?
