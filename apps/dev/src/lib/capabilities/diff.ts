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

export interface Finding {
	kind: FindingKind
	source: string
	tools: string[]
	/** Only a tool_added finding with at least one holder is flagged. */
	flagged: boolean
	/** Set on tool_added findings: sha256(workspace, source, kind, tool name, schema hash). */
	dedupeKey: string | null
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
	for (const name of added) {
		findings.push({
			kind: 'tool_added',
			source,
			tools: [name],
			flagged,
			dedupeKey: dedupeKeyFor(workspaceId, source, 'tool_added', name, curr[name]),
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
