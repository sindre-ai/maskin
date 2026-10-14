import type { ProviderConfig } from '../integrations/types'
import { resolveToolAddedKind } from './connection-findings'
import { sha256 } from './schema-hash'

/** How long a removed tool stays a tombstone, so a tool that flaps back is not new. */
export const TOMBSTONE_DAYS = 30
/** A source is reported unreachable once, on exactly this many failures in a row. */
export const UNREACHABLE_AFTER_FAILURES = 3

const DAY_MS = 24 * 60 * 60 * 1000

export interface CapabilitySnapshot {
	v: 1
	source: string
	scanned_at: string
	/** Tool name to input-schema hash. Names and hashes only, never descriptions. */
	tools: Record<string, string>
	/** Hash of a stdio server spec; null for sources that are probed over a transport. */
	spec_hash: string | null
	/** Tool name to the ISO time it disappeared. Entries older than 30 days are dropped. */
	removed: Record<string, string>
}

export type ProbeOutcome =
	| { ok: true; tools: Record<string, string>; specHash: string | null }
	| { ok: false }

export type FindingKind =
	| 'tool_added'
	| 'tool_removed'
	| 'schema_changed'
	| 'server_spec_changed'
	| 'source_unreachable'
	| 'needs_reconnect'
	| 'available_not_attached'

export interface Finding {
	kind: FindingKind
	source: string
	tools: string[]
	/** Only a tool_added or needs_reconnect finding with a holder, and available_not_attached, are flagged. */
	flagged: boolean
	/** Set on flagged findings: sha256(workspace, source, kind, tool name, schema hash). */
	dedupeKey: string | null
	/** Set on needs_reconnect findings: scope names the stored token lacks. Names only. */
	missingScopes?: string[]
}

export interface DiffInput {
	workspaceId: string
	source: string
	prev: CapabilitySnapshot | null
	probe: ProbeOutcome
	/** Agent ids that may use this source, from holders.ts. A hint at scan time. */
	holders: readonly string[]
	/** Failures in a row before this probe. */
	priorFailures: number
	now: Date
	/**
	 * What the source's stored token was granted, for oauth2 providers. When it
	 * lacks a scope the provider config now requires, a new tool is recorded as
	 * needs_reconnect instead of tool_added. Only scope strings, never a token.
	 */
	connection?: {
		config: ProviderConfig | undefined
		credentials: { scope?: unknown; userScope?: unknown }
	}
}

export interface DiffCounts {
	tools_total: number
	tools_added: number
	tools_removed: number
	schema_changed: number
}

export interface DiffResult {
	mode: 'baseline' | 'diff' | 'failed'
	/** Snapshot to write, or null when nothing changed and the previous one stands. */
	next: CapabilitySnapshot | null
	findings: Finding[]
	counts: DiffCounts
	/** Failures in a row after this probe (0 after a success). */
	consecutiveFailures: number
}

export function dedupeKeyFor(
	workspaceId: string,
	source: string,
	kind: FindingKind,
	toolName: string,
	schemaHash: string,
): string {
	return sha256(JSON.stringify([workspaceId, source, kind, toolName, schemaHash]))
}

/**
 * Pure comparison of one source's previous snapshot with what the probe
 * returned. No I/O. Rules:
 * - no previous snapshot: baseline, snapshot written, zero findings
 * - a failed probe keeps the previous snapshot, is never a removal, and
 *   reports source_unreachable once, on the third failure in a row
 * - tool_added is flagged only when the source has a holder and the name is not
 *   a tombstone younger than 30 days
 * - a tool_added on a held source whose stored token lacks a required scope is
 *   a needs_reconnect finding instead: the tool is not usable until a reconnect
 * - tool_removed, schema_changed and server_spec_changed are recorded, never flagged
 */
export function diffCapabilities(input: DiffInput): DiffResult {
	const { workspaceId, source, prev, probe, holders, priorFailures, now } = input

	if (!probe.ok) {
		const consecutiveFailures = priorFailures + 1
		const findings: Finding[] = []
		if (consecutiveFailures === UNREACHABLE_AFTER_FAILURES) {
			findings.push({
				kind: 'source_unreachable',
				source,
				tools: [],
				flagged: false,
				dedupeKey: null,
			})
		}
		return {
			mode: 'failed',
			next: null,
			findings,
			counts: {
				tools_total: prev ? Object.keys(prev.tools).length : 0,
				tools_added: 0,
				tools_removed: 0,
				schema_changed: 0,
			},
			consecutiveFailures,
		}
	}

	const curr = probe.tools
	const scannedAt = now.toISOString()

	if (!prev) {
		return {
			mode: 'baseline',
			next: {
				v: 1,
				source,
				scanned_at: scannedAt,
				tools: { ...curr },
				spec_hash: probe.specHash,
				removed: {},
			},
			findings: [],
			counts: {
				tools_total: Object.keys(curr).length,
				tools_added: 0,
				tools_removed: 0,
				schema_changed: 0,
			},
			consecutiveFailures: 0,
		}
	}

	const cutoff = now.getTime() - TOMBSTONE_DAYS * DAY_MS
	const removed: Record<string, string> = {}
	for (const [name, at] of Object.entries(prev.removed ?? {})) {
		if (Date.parse(at) > cutoff) removed[name] = at
	}

	const findings: Finding[] = []
	const added: string[] = []
	const gone: string[] = []
	const changed: string[] = []
	let flapped = false

	for (const name of Object.keys(curr).sort()) {
		if (!(name in prev.tools)) {
			if (name in removed) {
				// Flapped away and back inside the window: stored, not new.
				delete removed[name]
				flapped = true
				continue
			}
			added.push(name)
		} else if (prev.tools[name] !== curr[name]) {
			changed.push(name)
		}
	}
	for (const name of Object.keys(prev.tools).sort()) {
		if (!(name in curr)) {
			gone.push(name)
			removed[name] = scannedAt
		}
	}
	const specChanged = prev.spec_hash !== probe.specHash

	const flagged = holders.length > 0
	const { connection } = input
	const resolution = connection ? resolveToolAddedKind({ ...connection, holders }) : null
	const reconnect = resolution?.kind === 'needs_reconnect' ? resolution.missingScopes : null
	const addedKind = reconnect ? 'needs_reconnect' : 'tool_added'
	for (const name of added) {
		findings.push({
			kind: addedKind,
			source,
			tools: [name],
			flagged,
			dedupeKey: dedupeKeyFor(workspaceId, source, addedKind, name, curr[name] ?? ''),
			...(reconnect ? { missingScopes: reconnect } : {}),
		})
	}
	if (gone.length > 0) {
		findings.push({ kind: 'tool_removed', source, tools: gone, flagged: false, dedupeKey: null })
	}
	if (changed.length > 0) {
		findings.push({
			kind: 'schema_changed',
			source,
			tools: changed,
			flagged: false,
			dedupeKey: null,
		})
	}
	if (specChanged) {
		findings.push({
			kind: 'server_spec_changed',
			source,
			tools: [],
			flagged: false,
			dedupeKey: null,
		})
	}

	const dirty = added.length > 0 || gone.length > 0 || changed.length > 0 || specChanged || flapped
	return {
		mode: 'diff',
		next: dirty
			? {
					v: 1,
					source,
					scanned_at: scannedAt,
					tools: { ...curr },
					spec_hash: probe.specHash,
					removed,
				}
			: null,
		findings,
		counts: {
			tools_total: Object.keys(curr).length,
			tools_added: added.length,
			tools_removed: gone.length,
			schema_changed: changed.length,
		},
		consecutiveFailures: 0,
	}
}

/**
 * The finding for an active, unattached integration. State, not a diff: it has
 * no probe and no tool, so it is built here, beside dedupeKeyFor, to share the
 * one key shape. Holders are not in the key, so a later move of holders to
 * workspace grants cannot re-report it.
 */
export function availableNotAttachedFinding(workspaceId: string, source: string): Finding {
	return {
		kind: 'available_not_attached',
		source,
		tools: [],
		flagged: true,
		dedupeKey: dedupeKeyFor(workspaceId, source, 'available_not_attached', '', ''),
	}
}
