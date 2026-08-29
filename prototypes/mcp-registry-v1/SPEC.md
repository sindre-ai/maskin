# MCP Registry — v1 curated + BYO + per-loop activation

**Bet:** [MCP Registry — curated + bring-your-own MCP connector inside Maskin](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/6b7e8339-8c7a-4981-b3f4-bdf9a5722321)
**Prototype:** `prototypes/mcp-registry-v1/index.html` (single file — open directly, use the top bar to switch view + viewport)
**Design PR:** *(this PR)*
**Companion:** builds on [Keychain prototype PR #1464](https://github.com/sindre-ai/maskin/pull/1464) — every credential flow ends in that Keychain shell.

## User + job

A workspace member has just built a loop that needs to read from an external service (Notion, Linear, an internal API — whatever). They open the Registry, find a curated MCP or paste their own endpoint, connect a credential via the Keychain, and go back to the loop where they pick which of this MCP's tools this step actually needs. Two minutes to first call. Nothing they didn't ask for gets loaded into any loop.

## Design system reuse

- **Reuses:** `<Card>`, `<Button>` (primary / secondary / ghost / outline / destructive + `sm`), `<Input>`, `<Label>`, `<Badge>` (status colour tokens, plus the `brand` variant for OAuth/BYO chips), `<Tabs>` (pill variant, per `mcp-connection.tsx`), `<Sheet>`, `<Dialog>` (via `<ResponsiveDialog>`), `<Checkbox>`, `<RadioGroup>`, `<Table>` for the Installed list, `<Skeleton>`, `<Spinner>`, `<Tooltip>`, `<Breadcrumb>`, `<Sidebar>`. Neutral scale + `--brand` indigo + status badge tokens from `apps/web/src/app.css`. Row-with-status-dot pattern is copied verbatim from the Keychain prototype's landing list. The wizard shape (stepper + card body + footer) mirrors `SkjaldConnectDialog` and the Keychain OAuth wizard. **Health rows are a composition, not a new atomic:** `<Badge variant="status">` (existing) + inline `<Button size="sm">` for the fix action, laid out with the same `.warn-rule` / `.danger-rule` left-rules Keychain already ships. The load-bearing design decision is co-location of state + fix; the atomic components already exist.
- **Extends:** `<Badge>` gains one usage-only variant — `outline` for the numeric step badges in the loop-builder step column (styling exists in the token set, no new prop). `<Card>` picks up a **catalogue-card hover pattern** (border + shadow lift, click-anywhere navigate) shared with `settings/integrations.tsx` `ProviderRow` — this hover state exists in the Keychain landing rows already; here it graduates from list-row to card-grid. `<Tabs>` grows a **danger-count chip** (small tinted count next to a tab, used by the Health tab when items need attention). No new prop; count-chip is a slot.
- **New patterns:** two, each with a one-line "why the existing patterns fail this job".
  - **`<TrustGrade>`** — the Glama-style A–F letter grade. Renders as a rounded, colour-mapped mono badge with a tooltip that decomposes the score into ownership, maintenance, and reliability sub-scores. **Why new:** `<Badge>` is single-token; a grade is a composite of three signals, and the sub-score tooltip is the whole point. The SEO research ([knowledge 3d6e6826](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/3d6e6826-e4c6-4099-833f-5136614cc946)) is unambiguous: ownership tiers are the emerging trust currency and the grade is what a buyer skims for. This is UI-load-bearing.
  - **`<ToolCountMeter>`** — a compact bar+count that shifts from success-green to warning-amber to destructive-red as tool count crosses 50 / 200. Sits next to every MCP card and inside every install/inspect header. **Why new:** the deferred-tool-loading insight ([347146b3](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/347146b3-1db9-45b1-ac07-d522c70a19bd)) makes tool count a first-class token-cost signal. A raw number in `<Badge>` doesn't communicate that 213 tools is a *lot* the way a coloured meter does. The meter is the visual anchor for the deferred-load story the Registry has to tell.
  - ~~**`<HealthPulse>`**~~ — **trimmed after Developer feasibility check (2026-08-29).** Health rows now compose from existing `<Badge variant="status">` + inline `<Button size="sm">`; the co-location of state + fix is a layout pattern applied inside the row, not an atomic component. The 2.5s opacity pulse animation is aesthetic, not load-bearing — dropped. Screen-reader semantics (state + fix in same live region) survive via `role="status"` on the row container.
- **Reused verbatim from Keychain prototype:** the `.scope-rule` indigo left-rule, the `.warn-rule` amber left-rule, the `.danger-rule` red left-rule, the wizard stepper, the OAuth-in-a-new-tab loading state, the fail-closed messaging, the sidebar layout + tablet rail. Nothing in this prototype invents chrome that Keychain has already established.

## Flow

The three surfaces the bet demands + the health surface, mapped to the ten views in the prototype. Views 1–3 live in Settings ▸ MCP Registry; view 4 lives inside the loop builder; view 5 is the third tab of Settings ▸ MCP Registry.

1. **Browse (1, 1b, 1c)** — user lands on the catalogue, filters by service / auth / tool count / grade, clicks a card to inspect (1c). No-results (1b) hands them three explicit paths: search unverified, paste BYO, or request curation.
2. **Install (2a, 2b)** — from Inspect (1c) or a per-loop deep-link (4), user runs the 3-step wizard (Confirm → Credential → Agent scope). Credential step routes into the Keychain OAuth flow (existing Keychain PR #1464 prototype). BYO variant (2b) replaces "Confirm" with "Endpoint URL + auth method + capability preview" — a `server/discover` round-trip against the endpoint before storing anything.
3. **Installed (3)** — the workspace's installed MCPs. Every row shows tool count, loops-using chips, current health, trust grade. Failed-health rows are surfaced with amber/red left-rules and inline fix buttons.
4. **Per-loop MCP activation (4, 4b)** — inside a loop step, the "MCPs active in this step" panel is the affordance. Fail-closed default: newly installed MCPs are OFF in every loop until turned on. Zero-active is a valid and visibly normal state (4b), not a mistake. Per-MCP: pick which subset of tools to load. Token budget on the right hand rail — makes the deferred-load win legible. **Panel shape confirmed by Developer (2026-08-29):** inline collapsible chip row inside the step card, aligned with how ASKS renders — no side sheet, no graph-canvas inspector. The loop builder is a vertical `<StepRow>` stack (`components/loops/loop-flow.tsx`); dnd-kit only, no react-flow / xyflow / dagre.
5. **Health (5)** — third tab of the Registry surface. Summary counters at the top (healthy / auth-failed / server-down / first-use failure rate). Unhealthy items rendered above healthy ones, with the fix action legally next to the state.

## States (per screen)

### 1. Browse (`browse`)
- **Default:** Filter toolbar at the top; curation trust rule; a 3-column card grid (2 on tablet, 1 on mobile); an "advanced results" fold below grade B. Every card is `<a>`, click-anywhere navigates to Inspect. Install button on cards is a nested `<button>` that intercepts the click and jumps straight into the install wizard.
- **Hover:** Card border → `--border-hover`, `box-shadow: var(--shadow-md)`; cursor pointer.
- **Focus:** Card outline `2px var(--brand)` offset 2px; keyboard nav via Tab.
- **Loading:** `<Skeleton>` card grid (6 cards); toolbar stays interactive; sync-status in top-right shows "syncing…" with spinner.
- **Error:** Full-page `<RouteError>` reusing the existing shared component; catalogue-source fallback banner if `registry.modelcontextprotocol.io` is unreachable ("showing 12 h cached snapshot").
- **Empty:** State `browse-empty` — three-CTA fallback (search unverified · paste BYO · request curation) with the Queen's University 66%-flawed-MCPs warning as a `.danger-rule`.
- **Success (post-install toast):** `<Toast variant="success">` "Linear installed. 24 tools available to your loops." for 5 s; the new row highlights on the Installed view when navigated to.

### 1c. Inspect (`inspect`)
- **Default:** Header with logo · name · large `<TrustGrade>` · ownership tier · endpoint URL · last-verified time. Primary CTA "Install for this workspace" with a `~90 sec incl. OAuth` sub-label so the 2-min Won criterion is visible on the surface. Two-column body: left = Requirements card + Tools card (with tool-cluster preview); right = Trust sub-scores card + Auth card + Community card.
- **Hover / focus:** Standard.
- **Loading:** Both column cards `<Skeleton>`; header remains.
- **Error:** MCP-unreachable falls back to cached metadata + a warn-rule "Live capability check failed 12 min ago — showing last-known state."
- **Empty:** N/A (a listed MCP always has metadata).
- **Success:** Route to install wizard.

### 2a. Install — curated (`install-curated`)
Stepper: `Confirm ✓ · Credential · Agent scope`. Prototype shows step 2.
- **Default:** Scope-rule indigo call-out explaining what the MCP needs. Credential card lists existing Keychain rows for this service + a highlighted "Add a new credential" card that launches the Keychain OAuth flow.
- **Hover:** Credential row background → `--muted`.
- **Focus:** Radio native focus; standard shadow ring on inputs.
- **Loading:** Post-authorize state — inline card with spinner + "Waiting for {Service} to redirect back…" (mirrors Keychain SPEC exactly).
- **Error:** OAuth failure surfaces the same two named cases from Keychain (`redirect_uri_mismatch`, `user_denied`).
- **Empty:** N/A (form).
- **Success:** Route to step 3 (Agent scope — reuses `<ScopeBlastRadius>` from Keychain SPEC verbatim; not remocked in this prototype to avoid drift with Keychain PR #1464). On step-3 save: toast + return to Registry or to the loop step that deep-linked in.

### 2b. Install — BYO (`install-byo`)
Stepper: `Endpoint · Auth · Preview + scope`.
- **Default:** Endpoint URL input + Discover button; display name input; auth-method 4-way radio grid (None public / Bearer / API key header / OAuth 2.1); capability preview card that renders `tools/list` response as `<tool-chip>` cluster + server-info + capabilities chips.
- **Hover / focus:** Standard.
- **Loading:** Discover button spinner-in-place; preview card `<Skeleton>` while `initialize` + `tools/list` round-trip. Timeout at 8 s → error state.
- **Error (endpoint):** Named cases inline under the URL field — `ENOTFOUND` ("we can't resolve this hostname"), `ECONNREFUSED` ("nothing is listening"), `TLS handshake failed`, `initialize returned {status}` ("this doesn't look like an MCP server"). Never a raw stack trace.
- **Error (tool count > 500):** Warn-rule below preview — install allowed but the loop-step picker will be aggressive about search.
- **Empty:** Before Discover fires, preview card shows a muted "Paste an endpoint above and click Discover" hint.
- **Success:** Route to Agent scope (same step-3 as curated).

### 3. Installed (`installed`)
- **Default:** Full-width table, columns: MCP · Tools · Loops using · Health · Trust · caret. Unhealthy rows carry a warn/danger left-rule, and the health cell exposes the inline fix button.
- **Hover:** Row bg → `--muted`; unhealthy rules stay visible.
- **Focus:** Row is `<a>`; 2 px `--brand` outline offset.
- **Loading:** 6-row `<Skeleton>`.
- **Error:** Row-level auth failure inline in Health cell; full-page via `<RouteError>`.
- **Empty:** Zero-installed state — hero panel with "Browse the catalogue" primary CTA + `Paste an endpoint` secondary. Not designed as a separate view (dev can reuse the standard `<EmptyState>` primitive).
- **Success:** Post-install toast + row highlight on the newly-added row (same fade as Keychain).

### 4. Per-loop activation (`loop-activation`)
- **Default:** Loop-builder chrome with 4 vertically-stacked steps; step 2 expanded showing the "MCPs active in this step" panel. Panel header carries "N tools loaded · Nk tokens" so the deferred-load story is legible without hover. Each row: checkbox · MCP icon + name · loaded-tools summary · Pick tools button. Rows for installed-but-off MCPs render dimmed. Rows for unhealthy MCPs disable the checkbox and surface a "Health →" button pointing to view 5. Terminal row: "Install another MCP…" deep-links into browse and returns here.
- **Hover:** Row bg → `--muted`; active rows tint further.
- **Focus:** Checkbox native focus; row keyboard-navigable via j/k or arrows (reuses `useKeyboardShortcuts` from `command-palette.tsx`).
- **Loading:** Panel `<Skeleton>` rows while the workspace's installed MCPs list resolves.
- **Error:** Health-fetch failure per row → inline warn state, "Retry health check" ghost button.
- **Empty (no MCPs installed):** Row 1 becomes an inline empty state pointing at Browse. NOT a separate view — the "Install another MCP…" terminal row already handles this.
- **Success:** Save writes the step's active-MCP set; runs against the token-budget calc and re-renders the right-rail budget card.

### 4b. Loop with zero active MCPs (`loop-empty`)
- **Default:** Same step chrome; the panel body renders as a centered, quiet empty state — icon + "No MCPs active in this step — pure LLM" + two secondary CTAs ("Turn one on" / "Install something new"). A footer strip states "A loop step with zero MCPs is valid — it just runs the model with the prompt." This state is intentionally **not** rendered as a warning; a copy-polish loop legitimately doesn't need any MCP.
- **Hover / focus / loading:** Same as (4).
- **Error:** N/A (nothing to fetch when zero are active).
- **Success:** N/A.

### 5. Health (`health`)
- **Default:** Summary strip (4 counters: healthy, auth-failed, server-down, first-use fails 30d) + a "Needs attention" card with unhealthy items surfaced first + collapsed "Healthy" section below + a first-use failure sparkline against the 20% Lost ceiling. Every unhealthy row exposes its fix (`Reconnect` for auth-failed, `Retry now` for server-down) inline and lists affected loops as chips so the blast radius is visible in the same frame as the fix. State is rendered as `<Badge variant="status">` + inline `<Button size="sm">` composition inside the row (no `<HealthPulse>` atomic).
- **Hover:** Row bg → `--muted`; healthy rows collapse-summary hover.
- **Focus:** Standard row/button focus.
- **Loading (initial):** Counter cards + sparkline `<Skeleton>`; row list resolves independently.
- **Reconnect — pending state:** On `Reconnect` click, button disables and swaps its label to `Opening {Service}…` with an inline `<Spinner>`, then to `Waiting for {Service} to redirect back…` once the OAuth tab opens. Row shows an optimistic amber → indigo state transition (assumes reconnect will succeed) but does NOT flip the badge to `Healthy` until the next successful health check lands. If the OAuth tab is closed without completion within 90 s, button re-enables and a `.warn-rule` note appears: "Reconnect cancelled — try again when you're ready." If the round-trip returns an OAuth error, button re-enables and the two named Keychain cases (`redirect_uri_mismatch`, `user_denied`) surface inline. This is the state the Developer feasibility check flagged (2026-08-29) — Keychain OAuth round-trip latency is real and cannot hide behind a spinner-less button.
- **Retry now — pending state:** On `Retry now` click, button disables with a `<Spinner>`; server-down `initialize` ping fires; button label becomes `Pinging {endpoint}…`. On success: row swaps to Healthy, toast fires. On failure: button re-enables, diagnostic checklist updates in place with the latest DNS/TLS/HTTP result. 5 s timeout — button re-enables with the same failure state if the endpoint doesn't answer.
- **Error (subsystem):** Health-check subsystem failure → banner "Health checks paused — {reason}. Data below is {ts} old." Doesn't misrepresent as healthy.
- **Empty (all healthy, zero installed):** Sparkline + a small "Nothing installed yet — install something to see health" hint. Rare state, uses standard `<EmptyState>`.
- **Success:** Fix-click routes into Reconnect (Keychain OAuth wizard) or Retry-now (in-place ping + spinner + toast on recovery). Row's badge state only flips after the next real health check confirms — no optimistic-only success.

## Responsive

- **Mobile (≤640px):** Sidebar hidden behind a top-bar hamburger. Catalogue grid collapses to a single column with card padding tightened. Toolbar filters wrap; sort collapses behind a `Sort` icon-button that opens a bottom sheet. Install wizards fill the viewport; stepper truncates to `2/3` numeric. Loop activation panel keeps the checkbox column but drops the loaded-tools summary preview onto a second line under the MCP name. Health summary strip becomes a 2×2 grid.
- **Tablet (641–1024px):** Sidebar becomes an icon rail (matches Keychain). Catalogue grid = 2 columns. Loop activation right-rail collapses under the step column. Inspect two-column grid becomes 1 column with side cards stacked below tools.
- **Desktop (>1024px):** Full sidebar. Catalogue grid = 3 columns. Inspect uses `1fr · 320px`. Loop activation uses `1fr · 320px`.

## Copy

Every visible string in the prototype. If you see one in the built feature that isn't here, treat it as a bug.

### Registry landing / browse
- Page title: `MCP Registry`
- Page description: `Every tool your agents can reach. Browse curated MCPs, or paste a server endpoint of your own. Nothing is live in a loop until you activate it there — MCPs are installed here, activated per loop.`
- Primary CTAs: `Paste endpoint` · `Installed ({n})`
- Tab labels: `Catalogue` · `Installed` · `Health`
- Sync-status eyebrow: `Registry` · `{host}` · `synced {n} min ago`
- Toolbar labels: `Search Notion, Slack, Linear, github.com/…` · `Service` · `Auth type` · `Tool count` · `Sort` · `Trust grade`
- Filter chip label prefix: `Auth: {value}` · `Grade: {value}` · `Clear all`
- Result-count: `{n} MCPs · {m} shown`
- Curation rule title: `Maskin curates — the community publishes`
- Curation rule body: `We test every MCP in this list. The letter grade combines ownership, maintenance, and last-30-day reliability. Anything below C is behind an "advanced" toggle.`
- Curation link: `How curation works →`
- Advanced-fold caveat: `{n} more MCPs below grade B — show advanced results. Unverified sources may expose broken tools or leak auth.`

### Ownership tier labels
- `AAA · verified by Maskin`
- `Official · published by {vendor}`
- `Claimed · publisher unverified`
- `Anonymous · crawl-only`

### Card
- Card CTA: `Install` (when not installed) · `Inspect →` (when installed)
- Card status: `Installed` (badge, `active` colour) · `Not installed` (pulse, muted)
- Reliability suffix: `{n}% 30d`

### No results
- Title: `No curated MCPs match "{query}"`
- Body: `The community may already have one — we just haven't tested it. You have three paths.`
- Path cards: `Search unverified — See MCPs below grade B. May be broken or malicious.` · `Paste endpoint — If you have the MCP's URL, connect it directly. BYO.` · `Request curation — Tell us what's missing. We publish a queue.`
- Warning rule title: `Heads-up before you install an unverified MCP`
- Warning rule body: `The Queen's University study (2025) found ~66% of community MCPs have critical-level code issues — from tool descriptions that prompt-inject, to auth flows that leak tokens. Use BYO for endpoints you own or trust; use unverified only in throwaway loops.`

### Inspect
- Install CTA: `Install for this workspace` · sub-label `~{n} sec incl. OAuth`
- Requirements card title: `Before you install`
- Requirements items: `1 credential — {service} {method} token — Stored in your Keychain. Fail-closed by default — no agent can read it until you assign one.` · `1 agent scope — pick during install — Which of your workspace agents can read this credential. Configurable later.` · `Per-loop activation — you pick tools when you build the loop — Nothing is active in any loop until you turn it on in that loop's step. Zero context bloat by default.`
- Tools card title: `Tools exposed` · body: `Loaded per loop, not per session. Full descriptions in the loop-step picker.`
- Side cards: `Trust grade` (with `Verified by Maskin · updated daily`) · `Auth` (with the auth-method chip + a one-line explanation) · `Community` (with `Installs (Maskin)`, `Source`, `Also listed on`)

### Install — curated (wizard step 2)
- Stepper: `Confirm` · `Credential` · `Agent scope`
- Section title: `Credential`
- Section helper: `Pick one from your Keychain, or add a new one now.`
- Existing-credential secondary link: `Manage in Keychain →`
- Existing row: `{Service} · {credential-name}` badge `Existing` · sub `{prefix}_••••••••{last4} · used by {n} agents`
- Add-new card: `Add a new {Service} credential` · sub `Opens {Service} in a new tab, comes back automatically.` · button `Authorize with {Service}`
- Loading state: `Waiting for {Service} to redirect back…` · `A new tab has opened. Complete the sign-in there and you'll return here automatically.` (verbatim from Keychain SPEC)
- Details fold: `What Maskin stores after authorization` (list of what is / isn't stored)
- Footer: `← Back` · `Cancel` · `Continue to scope →`
- Success rule (post-scope-save): `{Service} is installed. {n} tools available to your loops.` · sub `Time-to-connection: {mm}m {ss}s.`

### Install — BYO
- Title: `Connect any MCP endpoint`
- Description: `Paste the MCP server's URL. We'll discover its tools, show you what it exposes, then ask for credentials.`
- Stepper: `Endpoint` · `Auth` · `Preview + scope`
- Endpoint label: `Endpoint URL`
- Endpoint helper: `HTTPS only. We'll call initialize then tools/list to preview capabilities before storing anything.`
- Discover button: `Discover`
- Display name label: `Display name`
- Display name helper: `What loop-builders will see in the tool picker.`
- Auth section: `Authentication` · body: `How Maskin authenticates to this MCP. Credentials go into your Keychain — nothing is stored inline on the MCP row itself.`
- Auth options: `None (public) — No credentials sent. Anyone who has the URL can call this MCP.` · `Bearer token — Static token sent in Authorization.` · `API key header — Custom header name — you configure the header + value.` · `OAuth 2.1 — Authorization-code + PKCE. You'll paste client ID/secret next.`
- Preview title: `Server responded — capability preview`
- Preview body: `This is what tools/list returned. Nothing is stored until you save.`
- Preview eyebrow: `Tools · showing {n} of {m}`
- Tool-count warn title: `{n} tools is a lot.`
- Tool-count warn body: `Maskin loads MCP schemas per loop-run, not per session — so this is safe to install. But your loop-step picker will show {n} candidates; use search there.`
- Server-info section: `Server info` · `Capabilities`
- Footer: `← Cancel` · `Install as "{display-name}" →`

### Installed
- Page description: `{n} MCPs installed in this workspace. None are running until a loop activates them.`
- Table headers: `MCP` · `Tools` · `Loops using` · `Health` · `Trust`
- Trailing hint: `Installed MCPs are not automatically active in every loop. Open a loop step and pick which MCPs it needs.`
- Row loops-using placeholder when >2: `+{n}`

### Per-loop activation
- Panel header: `MCPs active in this step`
- Header meter suffix: `{n} tools loaded · {m}k tokens`
- Header advanced link: `Advanced` (opens per-tool picker in a sheet — not remocked; reuses `<Sheet>` primitive)
- Row (on): `{Service}` · `{n} of {m} tools` · tool preview line of chosen tool names, truncated
- Row (all tools): `{Service}` · `all {n} tools` · body `Every tool this MCP exposes will be loaded.`
- Row (off): `{Service}` · `off · installed workspace-wide` · body `{n} tools available. Not loaded — this step doesn't need them.` · right slot `Toggle on`
- Row (unhealthy): `{Service}` badge `Server down` / `Auth expired` · body `Fix connection in Health before activating.` · right slot `Health →`
- Terminal row: `Install another MCP…` · right slot `Opens Registry, comes back here`
- Panel footer: `Only the checked tools are loaded when this step runs — deferred load keeps context lean.` · link `How this works →`
- Right-rail budget card title: `Context budget · step {n}`
- Right-rail budget breakdown label: `Tool schemas` · `{n} tok`
- Right-rail budget helper: `{n}% of 50k soft budget · deferred-load enabled`
- Right-rail budget body: `If you turned on every installed MCP with all tools, this step would load {n} tok of schemas before the prompt. Per-loop activation keeps you at {m}.`
- Right-rail scope card title: `Agent scope check`
- Right-rail scope items: `{Service} · read/write scoped` (green) or `{Service} · scope missing — assign in Keychain` (warn)
- Right-rail scope link: `Manage in Keychain →`
- Deep-link rule: `You can install from here.` · body `Clicking "Install another MCP…" opens the Registry and returns you to this step with the new MCP available.`

### Loop with zero active MCPs
- Panel empty title: `No MCPs active in this step — pure LLM`
- Panel empty body: `This is a normal state. This step doesn't need to reach any external service, so nothing is loaded. Turn one on if you want the model to look things up.`
- Panel empty CTAs: `Turn one on` · `Install something new`
- Panel empty footer: `A loop step with zero MCPs is valid — it just runs the model with the prompt.`

### Health
- Page title: `Connection health`
- Page description: `One row per installed MCP. Anything that isn't healthy gets a fix.`
- Summary counter labels: `Healthy` · `Auth failed` · `Server down` · `First-use fails · 30d`
- First-use fails sub-label: `Well under the 20% ceiling.` (auto-flips to `Approaching ceiling — investigate.` at ≥15%, `Above ceiling — bet is losing.` at ≥20%)
- Needs-attention section eyebrow: `Needs attention` · body `{n} of {m} installed MCPs`
- Auth-expired body: `Your {Service} OAuth token was revoked (probably by rotating it in {Service}'s dashboard). The credential still exists in your Keychain — you just need to re-authorise.`
- Auth-expired actions: `Reconnect` · `Pause loops`
- Reconnect pending labels: `Opening {Service}…` · `Waiting for {Service} to redirect back…` · cancelled note `Reconnect cancelled — try again when you're ready.`
- Server-down body: `Maskin can't reach {endpoint}. The endpoint isn't responding to initialize.`
- Server-down diagnostic labels: `DNS resolves` · `TLS handshake completes` · `HTTP responds — got {status} on {n} of last {m} checks`
- Server-down affects prefix: `Affects: {loop-chips} — will retry with backoff until healthy.`
- Server-down actions: `Retry now` · `Ping history`
- Retry pending label: `Pinging {endpoint}…`
- Healthy row summary: `Last check {n}s ago · {m} checks last hour · p50 latency {ms}ms`
- Sparkline title: `First-use failure rate`
- Sparkline body: `Percentage of new installs where the first tool call errors. The Lost criterion is 20%.`
- Sparkline ceiling label: `20% ceiling`

## Interaction details

- **Motion:** All colour + border transitions use `--duration-150 var(--ease-standard)`. Modal + sheet enter/exit use `--duration-slide` (300 ms) `var(--ease-emphasized)`. Health rows use `<Badge variant="status">` state colours only — no per-row pulse animation (dropped when `<HealthPulse>` was trimmed). The `Not installed` card status still uses the muted-dot pulse from the existing `.status-dot` pattern since it's a passive marker, not an active-attention state. All animations honour `prefers-reduced-motion` (already global via `app.css`).
- **Keyboard:** Catalogue is arrow-up/down navigable within the grid, `Enter` opens inspect, `n` opens Paste endpoint, `/` focuses search. Loop-activation panel: `j`/`k` for row nav, `Space` toggles the checkbox, `Escape` collapses (in sheet variant). BYO wizard: `⌘Enter` fires Discover from the URL field. Health page: `r` on a focused row triggers reconnect/retry (mirrors Gmail-style keyboard actions).
- **Accessibility:**
  - `<TrustGrade>` has an `aria-label` including the full sub-scores (e.g. `A grade — ownership: verified by Maskin, maintenance: last commit 3 days ago, reliability last 30 days: 98.1%`). Grade colour alone never carries the meaning.
  - `<ToolCountMeter>` has a tooltip announcing `{n} tools — deferred-loaded per loop, {token-est} tokens per loop-step`. Screen readers read the number, not "warning meter".
  - Health row container uses `role="status"` and wraps the `<Badge variant="status">` + inline `<Button size="sm">` so screen-readers announce state + fix together. When Reconnect enters its pending state the button's `aria-live="polite"` label transitions announce progress (`Opening Notion…` → `Waiting for Notion to redirect back…`).
  - Every catalogue card is `<a>` with a meaningful href — never a `div` with `onClick`.
  - Every unhealthy row's diagnostic checklist is a `<ul>` with `role="list"` and `aria-labelledby` on each item.
  - The zero-active loop-step state has `role="status"` (not `alert`) — because it's a valid state, not an error.
  - Contrast: every foreground/background pair passes WCAG AA at each theme.

## Out of scope

- **Marketplace listing/publishing UX** (Maskin's own MCP → Glama / PulseMCP / Smithery). That's a distribution/outreach concern, not a Registry v1 surface. Marketplace-outbound content lives in the SEO cluster.
- **Client-side installation into external clients (Cursor / VS Code / Claude Desktop).** Registry v1 installs *into Maskin*. Cross-client install is a separate bet.
- **Per-tool granular scope control (e.g. "allow `orders.list` but not `orders.refund` for this agent").** Assignment stays at credential-level per Keychain SPEC's `<ScopeBlastRadius>` model. The loop-step picker's "Pick tools" button is a *load* decision, not a *permit* decision.
- **Custom trust-grade weighting per workspace.** The grade is Maskin-curated. Enterprises who want to override curation get the "advanced results" toggle + BYO.
- **Automatic MCP updates.** Curated MCPs are pinned per install; version bumps show as a chip on the Installed row with a manual "update" action. Explicit is safer than silent for credential-adjacent code.
- **Agent-generated identity provisioning per MCP** (follow-on to Keychain). The Registry surfaces the concept implicitly (via requirements card) but the identity-provisioning wizard is out of scope.

## Open questions

1. **Curation source of truth — Maskin-hosted registry or `registry.modelcontextprotocol.io` fork?** *Resolved 2026-08-29 by CPO:* Maskin-hosted, seeded from the official registry's API (~500 entries bootstrap), then diverge on the curation layer entirely. Not a fork. v1 ships with a hand-curated seed of ~30–50 high-signal servers rather than the full official-registry import; catalogue grows only as validation can keep up. Rationale is in [event 483017](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/6b7e8339-8c7a-4981-b3f4-bdf9a5722321#comment-483017).
2. **AAA-verification tier bar.** *Resolved 2026-08-29 by Architect:* Both, in phases — manual weekly QA is fine at 3-server seed; Playwright-driven scripted E2E per AAA server (weekly, run by `trigger-runner`) automates once the AAA tier crosses ~10 entries. Results feed the Health rows via a new `mcp_canary_result` event. No new infra — Playwright already in stack.
3. **BYO OAuth 2.1 in v1 — or just Bearer / API-key / None?** *Resolved 2026-08-29 by Architect:* No OAuth 2.1 in BYO for v1 — Bearer / API key header / None only. OAuth 2.1 slips to a v1.5 follow-on. Prototype's OAuth-2.1 radio in view 2b is disabled with a "v1.5 — coming after launch" chip; the three other auth methods remain.
4. **Per-loop activation UX inside the Rails-like loop builder — is the current loop-builder amenable to inline panels?** *Resolved 2026-08-29 by Developer:* Vertical step-cards, decisively. Evidence: `components/loops/loop-flow.tsx` renders a vertical `<StepRow>` stack; `components/loops/loop-plan-card.tsx` stacks TRIGGERS with WHEN/THEN/ASKS per step; `routes/_authed/$workspaceId/loops/new.tsx` is language-first → plan card, no canvas; `apps/web/package.json` has no react-flow / xyflow / dagre (dnd-kit only, for sortable steps). **Panel affordance for MCP activation:** inline collapsible chip row inside the step card, aligned with how ASKS renders — no side sheet.
5. **First-use failure rate — do we have the instrumentation today?** *Resolved 2026-08-29 by Architect:* Ships in PR #1. All five events named + payload-shaped in spec §9, with `mcp_registry_connection_failed {failure_reason, is_first_use}` as the load-bearing event that backs the 20% Lost ceiling in-product. Health row reads directly from those events — no new emitter surface.
6. **Auth-expired detection latency.** *Resolved 2026-08-29 by Architect:* Lazy for v1 — detect on the next tool call (401 → surface Reconnect via Health row). Proactive detection needs OAuth-shaped token refresh; bundle with the OAuth 2.1 v1.5 follow-on. Prototype's "detected 4 h ago" timestamps become "detected on last tool call" copy; sparkline still shows first-use failure trend against the 20% ceiling regardless.
