// pnpm trigger:lint <workspace-uuid> — diagnostic CLI for surfacing dead
// triggers in a workspace. Load-bearing for the trigger-engine bet's rollout
// plan (§7.3 step 4 — **--predict** sizes reactivation bursts before each
// **FF_WORKSPACE_FEATURES** flag flip so ops can spot a workspace like bet
// #8's, where 13 dormant triggers would reactivate at once, BEFORE the flag
// turns on.
//
// Read-only by contract: this script never mutates trigger config and never
// dispatches a session. **--fix-relight** prints a copy-pasteable PATCH body;
// the operator applies it. **--predict** replays a fresh matcher v2 pass
// in-memory and never touches the DB row.
//
// Modes (all combine — e.g. --json --predict is a machine-readable
// predict-mode row):
//   default        Human-readable per-trigger report (§2.3 report shape)
//   --json         One JSONL row per trigger (machine-readable)
//   --events N     Replay window per workspace (default 500)
//   --fix-relight  Append PATCH body for each DEAD trigger with an
//                  array-valued filter
//   --predict      Dry-run matcher v2 over the last N events for every
//                  ENABLED trigger; project fire counts, sort desc, WARN > 100
//   --strict       Exit 1 if any DEAD triggers found (default exit is 0)
//
// Run:
//   DATABASE_URL=... pnpm --filter @maskin/dev exec tsx scripts/trigger-lint.ts <workspace-uuid> [options]

import { pathToFileURL } from 'node:url'
import { type Database, createDb } from '@maskin/db'
import { events, triggers } from '@maskin/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import {
	type TriggerCondition,
	evaluateConditions,
	evaluateFilterV2,
	resolvePath,
} from '../src/services/trigger-runner'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CliArgs {
	workspace: string
	events: number
	json: boolean
	fixRelight: boolean
	predict: boolean
	strict: boolean
	help: boolean
}

/**
 * Row shape lifted straight off `triggers`. Only the fields the matcher
 * evaluates against; extras (createdBy, etc.) are irrelevant to lint output.
 */
export interface TriggerRow {
	id: string
	name: string
	type: string
	enabled: boolean
	config: Record<string, unknown>
}

/**
 * Row shape lifted off `events`. `data` is nullable because the events NOTIFY
 * trigger strips it to stay under Postgres's 8KB payload cap on some paths;
 * the CLI is read from the row via SELECT, so `data` is always populated
 * unless the row was inserted without one.
 */
export interface EventRow {
	eventId: string
	entityType: string
	action: string
	data: Record<string, unknown> | null
}

/** A filter entry whose value is an array — the shape matcher v1 rejects. */
export interface ArrayFilterHit {
	key: string
	values: readonly unknown[]
}

/**
 * One row per trigger in the report. The default and JSON printers both
 * consume this shape; the JSON printer emits it verbatim, the default printer
 * renders §2.3's human-readable form.
 */
export interface TriggerReport {
	trigger_id: string
	trigger_name: string
	trigger_type: string
	status: 'DEAD' | 'HEALTHY'
	matches_v1: number
	window: number
	config: Record<string, unknown>
	cause: string | null
	relight_patch: { path: string; body: unknown } | null
	projected_fires_v2: number | null
	projection_warning: boolean
}

export const HELP_TEXT = `Usage: pnpm trigger:lint <workspace-uuid> [options]

Diagnostic CLI for surfacing dead triggers in a workspace. Read-only —
never mutates trigger config, never fires sessions.

Positional:
  <workspace-uuid>       Workspace to lint (required, must be a UUID)

Options:
  --events N             Replay window in events (default 500)
  --json                 Machine-readable output (one JSON row per trigger)
  --fix-relight          Print copy-pasteable PATCH /triggers/:id body for
                         each DEAD trigger with an array-valued filter.
                         Does NOT mutate.
  --predict              Dry-run matcher v2 against the last N events for
                         every ENABLED trigger; print projected fire counts
                         for currently-DEAD triggers, sorted descending.
                         Flag > 100 projected fires as WARN.
  --strict               Exit 1 if any DEAD triggers found (default: 0).
  -h, --help             Show this help.

Required env: DATABASE_URL (Postgres connection string).
`

/**
 * Argument parser. Rejects unknown flags (a typo like --fix-relight-all would
 * otherwise silently produce a report that ignored the caller's intent).
 * `--events N` accepts either space-separated (`--events 200`) or equals
 * form (`--events=200`); both are validated as a positive integer to avoid
 * `NaN` reaching downstream limits (see input-validation rule).
 */
export function parseArgs(argv: readonly string[]): CliArgs {
	const args: CliArgs = {
		workspace: '',
		events: 500,
		json: false,
		fixRelight: false,
		predict: false,
		strict: false,
		help: false,
	}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === undefined) continue
		if (a === '--json') args.json = true
		else if (a === '--fix-relight') args.fixRelight = true
		else if (a === '--predict') args.predict = true
		else if (a === '--strict') args.strict = true
		else if (a === '--help' || a === '-h') args.help = true
		else if (a === '--events') {
			const next = argv[i + 1]
			args.events = parsePositiveInt(next, '--events')
			i++
		} else if (a.startsWith('--events=')) {
			args.events = parsePositiveInt(a.slice('--events='.length), '--events')
		} else if (a.startsWith('-')) {
			throw new Error(`Unknown flag: ${a}`)
		} else if (!args.workspace) {
			args.workspace = a
		} else {
			throw new Error(`Unexpected positional arg: ${a}`)
		}
	}
	return args
}

function parsePositiveInt(raw: string | undefined, flag: string): number {
	if (raw === undefined) throw new Error(`${flag} requires a value`)
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
		throw new Error(`${flag} must be a positive integer, got: ${raw}`)
	}
	return parsed
}

/**
 * v1 filter body — what today's runtime does when `trigger_engine_v2` is OFF
 * for a workspace. Strict equality on every entry; an array value
 * reference-compared against a scalar `resolvePath` result is always false,
 * which is EXACTLY the bug the CLI exists to surface. Kept inline (not
 * imported from trigger-runner) because trigger-runner inlines this body too
 * at line 831 and doesn't export a v1 helper — pinning the diagnostic here
 * keeps the two definitions side by side.
 */
export function matchesFilterV1(
	filter: Record<string, unknown>,
	root: Record<string, unknown>,
): boolean {
	return Object.entries(filter).every(([key, value]) => resolvePath(root, key) === value)
}

/**
 * Enumerate every filter entry whose value is an array. Bet #8's dead
 * triggers are exactly this shape — an author who wanted "status in
 * [onboarding, kickoff]" wrote it into `filter` where matcher v1 rejects it
 * silently, instead of `conditions[]` where the `in` operator handles arrays.
 * The relighter uses this to move each hit into a `conditions[]` entry that
 * fires under v1 too.
 */
export function arrayValuedEntries(
	filter: Record<string, unknown> | undefined | null,
): ArrayFilterHit[] {
	if (!filter || typeof filter !== 'object') return []
	const out: ArrayFilterHit[] = []
	for (const [key, value] of Object.entries(filter)) {
		if (Array.isArray(value)) out.push({ key, values: value })
	}
	return out
}

/**
 * Approximation of `trigger-runner.ts` `buildFilterRoot` (line 748). The
 * runtime hydrates the `objects` row for `updated`/`status_changed` events
 * from the DB; the CLI reads only the event row and unpacks the `updated`
 * side of the legacy `{previous, updated}` shape when present. Result: the
 * count is exact for triggers whose filter reads keys the raw event data
 * still carries (integration triggers, commented triggers, and legacy
 * object-update events on this bet's branch). Triggers that filter on a
 * hydrated `current` column not present on the raw payload will undercount;
 * that limitation is called out in `describeCause`.
 */
export function buildFilterRoot(event: EventRow): Record<string, unknown> {
	const data = event.data
	if (!data || typeof data !== 'object') return {}
	if (event.action === 'commented') {
		return { ...data }
	}
	if (event.action === 'updated' || event.action === 'status_changed') {
		const updated = (data as { updated?: unknown }).updated
		if (updated && typeof updated === 'object' && !Array.isArray(updated)) {
			return updated as Record<string, unknown>
		}
		return data as Record<string, unknown>
	}
	return data as Record<string, unknown>
}

/**
 * Entity-type + action gate. Mirrors trigger-runner.ts's `slack.message`
 * catch-all so a `slack.channel_message` event matches a trigger configured
 * against `slack.message` — the same shape the runtime accepts.
 */
export function passesEntityAndAction(config: Record<string, unknown>, event: EventRow): boolean {
	const configEntityType = config.entity_type as string | undefined
	const configAction = config.action as string | undefined
	if (configEntityType && configEntityType !== event.entityType) {
		if (
			configEntityType !== 'slack.message' ||
			!event.entityType.startsWith('slack.') ||
			!event.entityType.endsWith('_message')
		) {
			return false
		}
	}
	if (configAction && configAction !== event.action) return false
	return true
}

function passesConditions(config: Record<string, unknown>, root: Record<string, unknown>): boolean {
	const raw = config.conditions
	if (!Array.isArray(raw) || raw.length === 0) return true
	return evaluateConditions(raw as TriggerCondition[], root)
}

/**
 * Simulate the number of events (of the passed set) that would have matched
 * this trigger under the chosen matcher body. **v2** counts what will happen
 * after the flag flips; **v1** counts what happens today. `from_status` /
 * `to_status` are deliberately skipped — those need the previous object row,
 * which the CLI does not hydrate.
 */
export function countMatches(
	trigger: TriggerRow,
	replay: readonly EventRow[],
	useV2: boolean,
): number {
	const filter = trigger.config.filter as Record<string, unknown> | undefined
	let matches = 0
	for (const event of replay) {
		if (!passesEntityAndAction(trigger.config, event)) continue
		const root = buildFilterRoot(event)
		if (filter) {
			if (useV2) {
				if (!evaluateFilterV2(filter, root).matches) continue
			} else {
				if (!matchesFilterV1(filter, root)) continue
			}
		}
		if (!passesConditions(trigger.config, root)) continue
		matches += 1
	}
	return matches
}

/**
 * Plain-English cause. Prioritises the array-filter shape (bet #8's primary
 * failure) — its wording matches the §2.3 example verbatim so ops see the
 * same sentence they saw in the spec. Falls back to entity-type / action
 * dormancy checks, then a generic "no matches" note.
 */
export function describeCause(trigger: TriggerRow, replay: readonly EventRow[]): string {
	const filter = trigger.config.filter as Record<string, unknown> | undefined
	const arrays = arrayValuedEntries(filter)
	if (arrays.length > 0) {
		const first = arrays[0]
		if (!first) return 'unknown'
		const more =
			arrays.length > 1
				? ` (${arrays.length - 1} more array-valued entr${arrays.length - 1 === 1 ? 'y' : 'ies'})`
				: ''
		return `filter value at "${first.key}" is an array. Matcher v1 (today) rejects array values silently. Enable flag "trigger_engine_v2" for this workspace, then this trigger will match on the next event.${more}`
	}
	const configEntityType = trigger.config.entity_type as string | undefined
	const configAction = trigger.config.action as string | undefined
	if (configEntityType) {
		const seen = replay.some((e) => passesEntityAndAction({ entity_type: configEntityType }, e))
		if (!seen) {
			return `no events with entity_type "${configEntityType}" seen in the last ${replay.length} events; source events aren't happening in this workspace.`
		}
	}
	if (configAction) {
		const seen = replay.some((e) => e.action === configAction)
		if (!seen) {
			return `no events with action "${configAction}" seen in the last ${replay.length} events; source action isn't happening in this workspace.`
		}
	}
	return `no matching events in the last ${replay.length}. Filter/conditions may be too narrow, or the source events aren't happening in this workspace.`
}

/**
 * Build the copy-pasteable PATCH body that moves every array-valued filter
 * entry into a `conditions[]` row with operator `in`. Under matcher v1 this
 * makes the trigger fire without needing the flag — v1's `evaluateCondition`
 * already handles the `in` operator against an array of allowed values (see
 * trigger-runner.ts line 1585). Only produced for triggers that actually
 * have an array-valued filter; other DEAD triggers get `null`.
 */
export function relightPatch(trigger: TriggerRow): { path: string; body: unknown } | null {
	const filter = trigger.config.filter as Record<string, unknown> | undefined
	const arrays = arrayValuedEntries(filter)
	if (arrays.length === 0 || !filter) return null
	const arrayKeys = new Set(arrays.map((h) => h.key))
	const newFilter: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(filter)) {
		if (!arrayKeys.has(k)) newFilter[k] = v
	}
	const existingConditions = Array.isArray(trigger.config.conditions)
		? (trigger.config.conditions as unknown[])
		: []
	const newConditions = [
		...existingConditions,
		...arrays.map(({ key, values }) => ({
			field: key,
			operator: 'in',
			value: [...values],
		})),
	]
	const { filter: _oldFilter, ...configWithoutFilter } = trigger.config
	const newConfig: Record<string, unknown> = { ...configWithoutFilter }
	if (Object.keys(newFilter).length > 0) newConfig.filter = newFilter
	newConfig.conditions = newConditions
	return {
		path: `PATCH /api/triggers/${trigger.id}`,
		body: { config: newConfig },
	}
}

/**
 * Threshold above which a projected-fires count is flagged with WARN in
 * `--predict` output. Chosen so a workspace like bet #8's (13 dormant
 * triggers, ~200-500 stored events/day) doesn't spam WARN for every trigger
 * that happens to match; only the ones that would burst hard.
 */
export const PREDICT_WARN_THRESHOLD = 100

/**
 * Build one report row per trigger. Kept pure (no DB, no I/O) so the snapshot
 * tests can drive it with a fixed event batch and stable trigger rows.
 */
export function buildReports(
	triggerRows: readonly TriggerRow[],
	replay: readonly EventRow[],
	options: { predict: boolean },
): TriggerReport[] {
	const rows: TriggerReport[] = triggerRows.map((trigger) => {
		const matches_v1 = countMatches(trigger, replay, false)
		const status: 'DEAD' | 'HEALTHY' = matches_v1 > 0 ? 'HEALTHY' : 'DEAD'
		const cause = status === 'DEAD' ? describeCause(trigger, replay) : null
		const relight_patch = status === 'DEAD' ? relightPatch(trigger) : null
		let projected_fires_v2: number | null = null
		let projection_warning = false
		if (options.predict) {
			projected_fires_v2 = countMatches(trigger, replay, true)
			projection_warning = projected_fires_v2 > PREDICT_WARN_THRESHOLD
		}
		return {
			trigger_id: trigger.id,
			trigger_name: trigger.name,
			trigger_type: trigger.type,
			status,
			matches_v1,
			window: replay.length,
			config: trigger.config,
			cause,
			relight_patch,
			projected_fires_v2,
			projection_warning,
		}
	})
	return rows
}

// ─── Renderers ─────────────────────────────────────────────────────────────

function indent(s: string, spaces: number): string {
	const pad = ' '.repeat(spaces)
	return s
		.split('\n')
		.map((line, i) => (i === 0 ? line : pad + line))
		.join('\n')
}

/**
 * Human-readable report per trigger, matching the §2.3 example shape.
 * Deliberately does NOT include a Cause line for HEALTHY triggers — nothing
 * to explain — and skips the Relight line for DEAD triggers that don't have
 * an array-valued filter (nothing to auto-fix).
 */
export function formatDefault(reports: readonly TriggerReport[]): string {
	if (reports.length === 0) return 'No enabled triggers in this workspace.\n'
	const chunks: string[] = []
	for (const r of reports) {
		const lines: string[] = []
		lines.push(`Trigger "${r.trigger_name}" (id: ${r.trigger_id})`)
		if (r.status === 'DEAD') {
			lines.push(`  Status:   DEAD (0 matches across last ${r.window} events)`)
			lines.push(`  Config:   ${JSON.stringify(r.config)}`)
			if (r.cause) {
				lines.push(`  Cause:    ${indent(r.cause, 12)}`)
			}
			if (r.relight_patch) {
				lines.push('  Relight:  --fix-relight prints the PATCH body.')
			}
		} else {
			lines.push(`  Status:   HEALTHY (${r.matches_v1} matches in last ${r.window} events)`)
		}
		chunks.push(lines.join('\n'))
	}
	return `${chunks.join('\n\n')}\n`
}

/**
 * Newline-delimited JSON (one report per line). Machine-readable — jq /
 * grep / etc. work per row. Includes every field of the report shape so
 * downstream tooling can pick what it wants; the config blob rides through
 * verbatim so ops can pipe a specific trigger's config into another tool.
 */
export function formatJson(reports: readonly TriggerReport[]): string {
	return `${reports.map((r) => JSON.stringify(r)).join('\n')}\n`
}

/**
 * Append the copy-pasteable PATCH block per DEAD-with-array-filter trigger.
 * Multiple triggers → multiple PATCH blocks separated by blank lines. Prints
 * "no candidates" if no DEAD trigger had an array filter.
 */
export function formatFixRelight(reports: readonly TriggerReport[]): string {
	const candidates = reports.filter((r) => r.relight_patch !== null)
	if (candidates.length === 0) {
		return '\n--fix-relight: no DEAD triggers with array-valued filters found.\n'
	}
	const chunks: string[] = ['', '--fix-relight (copy-pasteable, NOT sent):', '']
	for (const r of candidates) {
		const patch = r.relight_patch
		if (!patch) continue
		chunks.push(`# Trigger "${r.trigger_name}" (id: ${r.trigger_id})`)
		chunks.push(patch.path)
		chunks.push(JSON.stringify(patch.body, null, 2))
		chunks.push('')
	}
	return `${chunks.join('\n')}`
}

/**
 * --predict projection block, appended below the report. Shows one row per
 * currently-DEAD trigger, sorted by projected fires desc. WARN prefix on any
 * row above the 100-fire threshold — a signal ops should review the trigger's
 * config before flipping the flag, since a burst that large is usually a
 * config bug (e.g. missing `to_status`).
 */
export function formatPredict(reports: readonly TriggerReport[]): string {
	const dead = reports.filter((r) => r.status === 'DEAD' && r.projected_fires_v2 !== null)
	if (dead.length === 0) {
		return '\n--predict: no currently-DEAD triggers to project.\n'
	}
	const sorted = [...dead].sort((a, b) => (b.projected_fires_v2 ?? 0) - (a.projected_fires_v2 ?? 0))
	const chunks: string[] = ['', '--predict (matcher v2 projection over the same window):', '']
	for (const r of sorted) {
		const prefix = r.projection_warning ? 'WARN  ' : '      '
		const fires = r.projected_fires_v2 ?? 0
		chunks.push(`${prefix}${fires} projected fires  →  "${r.trigger_name}" (id: ${r.trigger_id})`)
	}
	return `${chunks.join('\n')}\n`
}

/**
 * Assemble the full render for a set of reports. The renderers are separate
 * (default / json / fix-relight / predict) so tests can pin each in isolation,
 * and so the JSON path stays clean of the human-readable furniture.
 */
export function renderReport(
	reports: readonly TriggerReport[],
	args: Pick<CliArgs, 'json' | 'fixRelight' | 'predict'>,
): string {
	if (args.json) {
		let out = formatJson(reports)
		if (args.predict) out += formatPredict(reports)
		if (args.fixRelight) out += formatFixRelight(reports)
		return out
	}
	let out = formatDefault(reports)
	if (args.predict) out += formatPredict(reports)
	if (args.fixRelight) out += formatFixRelight(reports)
	return out
}

// ─── DB ────────────────────────────────────────────────────────────────────

async function loadEnabledTriggers(db: Database, workspaceId: string): Promise<TriggerRow[]> {
	const rows = await db
		.select({
			id: triggers.id,
			name: triggers.name,
			type: triggers.type,
			enabled: triggers.enabled,
			config: triggers.config,
		})
		.from(triggers)
		.where(and(eq(triggers.workspaceId, workspaceId), eq(triggers.enabled, true)))
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		type: r.type,
		enabled: r.enabled,
		config: (r.config ?? {}) as Record<string, unknown>,
	}))
}

async function loadEvents(db: Database, workspaceId: string, limit: number): Promise<EventRow[]> {
	const rows = await db
		.select({
			id: events.id,
			entityType: events.entityType,
			action: events.action,
			data: events.data,
		})
		.from(events)
		.where(eq(events.workspaceId, workspaceId))
		.orderBy(desc(events.id))
		.limit(limit)
	return rows.map((r) => ({
		eventId: String(r.id),
		entityType: r.entityType,
		action: r.action,
		data: (r.data as Record<string, unknown> | null) ?? null,
	}))
}

// ─── Entry point ───────────────────────────────────────────────────────────

async function main(argv: readonly string[]): Promise<number> {
	let args: CliArgs
	try {
		args = parseArgs(argv)
	} catch (err) {
		process.stderr.write(`${(err as Error).message}\n\n${HELP_TEXT}`)
		return 2
	}
	if (args.help) {
		process.stdout.write(HELP_TEXT)
		return 0
	}
	if (!args.workspace) {
		process.stderr.write(`workspace-uuid is required.\n\n${HELP_TEXT}`)
		return 2
	}
	if (!UUID_RE.test(args.workspace)) {
		process.stderr.write(`workspace-uuid must be a UUID, got: ${args.workspace}\n`)
		return 2
	}
	const url = process.env.DATABASE_URL || process.env.POSTGRES_URL
	if (!url) {
		process.stderr.write('DATABASE_URL is required.\n')
		return 2
	}

	const db = createDb(url)
	try {
		const [triggerRows, replay] = await Promise.all([
			loadEnabledTriggers(db, args.workspace),
			loadEvents(db, args.workspace, args.events),
		])
		const reports = buildReports(triggerRows, replay, { predict: args.predict })
		process.stdout.write(renderReport(reports, args))
		if (args.strict && reports.some((r) => r.status === 'DEAD')) return 1
		return 0
	} finally {
		await db.$client.end().catch(() => {
			/* best-effort — a stuck close should not mask the real exit code */
		})
	}
}

// Guard the auto-run so `import { ... } from 'scripts/trigger-lint'` in tests
// doesn't kick off the CLI (mirrors seed-marketplace.ts's shape).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main(process.argv.slice(2))
		.then((code) => {
			process.exit(code)
		})
		.catch((err) => {
			process.stderr.write(`trigger-lint failed: ${(err as Error).stack ?? err}\n`)
			process.exit(1)
		})
}
