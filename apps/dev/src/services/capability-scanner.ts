import type { Database, Transaction } from '@maskin/db'
import { events, workspaces } from '@maskin/db/schema'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { trackCapabilityScanCompleted } from '../lib/analytics/capability-events'
import {
	type CapabilitySnapshot,
	type DiffResult,
	type Finding,
	type ProbeOutcome,
	diffCapabilities,
} from '../lib/capabilities/diff'
import {
	type HolderContext,
	type HolderSource,
	countUnscannedServers,
	holdersForSources,
} from '../lib/capabilities/holders'
import { type ProbeFn, probeSource } from '../lib/capabilities/probe'
import { type CapabilitySource, enumerateSources } from '../lib/capabilities/sources'
import { findChiefOfStaffId } from '../lib/chief-of-staff'
import { recordEvent } from '../lib/events/record-event'
import { FLAGS, isFlagEnabledForWorkspace } from '../lib/feature-flags'
import { logger } from '../lib/logger'

const TICK_MS = 24 * 60 * 60 * 1000
const BOOT_DELAY_MS = 60_000
/** The boot tick only scans a workspace that has no completed scan this recent. */
const BOOT_SKIP_WINDOW_MS = 20 * 60 * 60 * 1000

export const CAPABILITY_ACTIONS = {
	snapshot: 'capability_snapshot',
	changed: 'capability_changed',
	scanCompleted: 'capability_scan_completed',
	probeMissed: 'capability_probe_missed',
	probeRecovered: 'capability_probe_recovered',
} as const

export const CAPABILITY_SOURCE_ENTITY = 'capability_source'

export interface CapabilityScannerOptions {
	/** Test seam: replaces the network and in-process probes. */
	probe?: ProbeFn
	now?: () => Date
}

export type WorkspaceScanResult =
	| { status: 'scanned'; mode: 'baseline' | 'diff'; findingsWritten: number }
	| { status: 'skipped'; reason: 'flag_off' | 'no_chief_of_staff' | 'recent_scan' | 'lock_busy' }

/**
 * Daily capability scan. A server job: no model, no session, no message. For
 * each flagged workspace it asks every tool source what it can do, compares the
 * answer with the stored snapshot and writes the result as events. Shape of
 * MeetWatchRenewer: start, stop, interval tick, running re-entrancy guard.
 *
 * Shadow mode: nothing here talks to a person. Findings pile up as
 * capability_changed events and can be read with get_events.
 */
export class CapabilityScanner {
	private timer: NodeJS.Timeout | null = null
	private bootTimer: NodeJS.Timeout | null = null
	private running = false
	private readonly probe: ProbeFn
	private readonly now: () => Date

	constructor(
		private db: Database,
		options: CapabilityScannerOptions = {},
	) {
		this.probe = options.probe ?? probeSource
		this.now = options.now ?? (() => new Date())
	}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => void this.tick(), TICK_MS)
		// Deploys are exactly when built-in tools change, so scan once after boot,
		// unless this workspace already scanned within the last 20 hours.
		this.bootTimer = setTimeout(() => void this.tick({ boot: true }), BOOT_DELAY_MS)
		this.bootTimer.unref()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
		if (this.bootTimer) {
			clearTimeout(this.bootTimer)
			this.bootTimer = null
		}
	}

	async tick(opts: { boot?: boolean } = {}): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			const rows = await this.db.select({ id: workspaces.id }).from(workspaces)
			let scanned = 0
			let skipped = 0
			for (const { id } of rows) {
				if (!isFlagEnabledForWorkspace(id, FLAGS.CAPABILITY_SCAN)) continue
				try {
					const result = await this.scanWorkspace(id, opts)
					if (result.status === 'scanned') scanned++
					else skipped++
				} catch (err) {
					logger.error('Capability scan failed for workspace', {
						workspaceId: id,
						error: err instanceof Error ? err.message : String(err),
					})
				}
			}
			if (scanned > 0 || skipped > 0) {
				logger.info('Capability scanner tick', { scanned, skipped, boot: opts.boot === true })
			}
		} finally {
			this.running = false
		}
	}

	async scanWorkspace(
		workspaceId: string,
		opts: { boot?: boolean } = {},
	): Promise<WorkspaceScanResult> {
		if (!isFlagEnabledForWorkspace(workspaceId, FLAGS.CAPABILITY_SCAN)) {
			return { status: 'skipped', reason: 'flag_off' }
		}
		// Chief of Staff is an agent, so finding one also means the workspace has one.
		const actorId = await findChiefOfStaffId(this.db, workspaceId)
		if (!actorId) {
			logger.info('Capability scan skipped: workspace has no Chief of Staff', { workspaceId })
			return { status: 'skipped', reason: 'no_chief_of_staff' }
		}
		if (opts.boot && (await this.scannedRecently(workspaceId))) {
			return { status: 'skipped', reason: 'recent_scan' }
		}

		const startedAt = Date.now()
		const ctx: HolderContext = { db: this.db, workspaceId }
		const sources = await enumerateSources(this.db, workspaceId)
		const holders = await holdersForSources(ctx, sources.map(toHolderSource))
		const unscannedServers = await countUnscannedServers(ctx)

		// Probes run before the write transaction: they can take seconds.
		const probes = new Map<string, ProbeOutcome>()
		for (const source of sources) {
			try {
				const result = await this.probe(this.db, workspaceId, source)
				probes.set(source.key, { ok: true, tools: result.tools, specHash: result.specHash })
			} catch (err) {
				logger.warn('Capability probe failed', {
					workspaceId,
					source: source.key,
					error: err instanceof Error ? err.message : String(err),
				})
				probes.set(source.key, { ok: false })
			}
		}

		const outcome = await this.db.transaction(async (tx) => {
			const locked = (await tx.execute(
				sql`SELECT pg_try_advisory_xact_lock(hashtext('capability-scan:' || ${workspaceId}::text)) AS locked`,
			)) as unknown as Array<{ locked: boolean }>
			if (!locked[0]?.locked) return null

			const now = this.now()
			const totals = {
				sources_failed: 0,
				tools_total: 0,
				tools_added: 0,
				tools_removed: 0,
				schema_changed: 0,
				findings_eligible: 0,
			}
			let baselined = false
			let findingsWritten = 0

			for (const source of sources) {
				const probe = probes.get(source.key) ?? { ok: false as const }
				const prev = await latestSnapshot(tx, workspaceId, source)
				const priorFailures = await consecutiveFailures(tx, workspaceId, source)
				const sourceHolders = holders.get(source.key) ?? []
				const diff = diffCapabilities({
					workspaceId,
					source: source.key,
					prev: prev?.snapshot ?? null,
					probe,
					holders: sourceHolders,
					priorFailures,
					now,
				})

				totals.tools_total += diff.counts.tools_total
				totals.tools_added += diff.counts.tools_added
				totals.tools_removed += diff.counts.tools_removed
				totals.schema_changed += diff.counts.schema_changed
				if (diff.mode === 'failed') totals.sources_failed++
				if (diff.mode === 'baseline') baselined = true

				findingsWritten += await writeSourceResult(tx, {
					workspaceId,
					actorId,
					source,
					diff,
					prevEventId: prev?.eventId ?? null,
					hadFailures: priorFailures > 0,
					holders: sourceHolders,
				})
				totals.findings_eligible += diff.findings.filter(
					(f) => f.kind === 'tool_added' && f.flagged,
				).length
			}

			const mode: 'baseline' | 'diff' = baselined ? 'baseline' : 'diff'
			const scan = {
				workspace_id: workspaceId,
				mode,
				sources_total: sources.length,
				sources_failed: totals.sources_failed,
				unscanned_servers: unscannedServers,
				tools_total: totals.tools_total,
				tools_added: totals.tools_added,
				tools_removed: totals.tools_removed,
				schema_changed: totals.schema_changed,
				findings_eligible: totals.findings_eligible,
				duration_ms: Date.now() - startedAt,
				model_calls: 0 as const,
			}
			await recordEvent(tx, {
				workspaceId,
				actorId,
				action: CAPABILITY_ACTIONS.scanCompleted,
				entityType: 'workspace',
				entityId: workspaceId,
				data: scan,
			})
			return { scan, findingsWritten }
		})

		if (!outcome) {
			logger.info('Capability scan skipped: another replica holds the lock', { workspaceId })
			return { status: 'skipped', reason: 'lock_busy' }
		}
		await trackCapabilityScanCompleted(outcome.scan).catch((err) => {
			logger.warn('capability_scan_completed capture failed', {
				workspaceId,
				error: err instanceof Error ? err.message : String(err),
			})
		})
		return { status: 'scanned', mode: outcome.scan.mode, findingsWritten: outcome.findingsWritten }
	}

	private async scannedRecently(workspaceId: string): Promise<boolean> {
		const since = new Date(this.now().getTime() - BOOT_SKIP_WINDOW_MS)
		const [row] = await this.db
			.select({ id: events.id })
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.entityId, workspaceId),
					eq(events.action, CAPABILITY_ACTIONS.scanCompleted),
					gt(events.createdAt, since),
				),
			)
			.orderBy(desc(events.id))
			.limit(1)
		return Boolean(row)
	}
}

function toHolderSource(source: CapabilitySource): HolderSource {
	return { key: source.key, provider: source.provider, integrationId: source.integrationId }
}

interface StoredSnapshot {
	eventId: number
	snapshot: CapabilitySnapshot
}

/** Newest snapshot for a source, read through events_ws_entity_id_idx. */
async function latestSnapshot(
	tx: Transaction,
	workspaceId: string,
	source: CapabilitySource,
): Promise<StoredSnapshot | null> {
	const [row] = await tx
		.select({ id: events.id, data: events.data })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityId, source.entityId),
				eq(events.action, CAPABILITY_ACTIONS.snapshot),
				sql`${events.data}->>'source' = ${source.key}`,
			),
		)
		.orderBy(desc(events.id))
		.limit(1)
	if (!row) return null
	return { eventId: row.id, snapshot: row.data as CapabilitySnapshot }
}

/** Probe failures in a row, counted back from the newest event for this source. */
async function consecutiveFailures(
	tx: Transaction,
	workspaceId: string,
	source: CapabilitySource,
): Promise<number> {
	const recent = await tx
		.select({ action: events.action })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityId, source.entityId),
				inArray(events.action, [
					CAPABILITY_ACTIONS.snapshot,
					CAPABILITY_ACTIONS.probeMissed,
					CAPABILITY_ACTIONS.probeRecovered,
				]),
				sql`${events.data}->>'source' = ${source.key}`,
			),
		)
		.orderBy(desc(events.id))
		.limit(10)
	let count = 0
	for (const row of recent) {
		if (row.action !== CAPABILITY_ACTIONS.probeMissed) break
		count++
	}
	return count
}

async function writeSourceResult(
	tx: Transaction,
	params: {
		workspaceId: string
		actorId: string
		source: CapabilitySource
		diff: DiffResult
		prevEventId: number | null
		hadFailures: boolean
		holders: readonly string[]
	},
): Promise<number> {
	const { workspaceId, actorId, source, diff, prevEventId, hadFailures, holders } = params
	const base = {
		workspaceId,
		actorId,
		entityType: CAPABILITY_SOURCE_ENTITY,
		entityId: source.entityId,
	}

	if (diff.mode === 'failed') {
		await recordEvent(tx, {
			...base,
			action: CAPABILITY_ACTIONS.probeMissed,
			data: { source: source.key, consecutive_failures: diff.consecutiveFailures },
		})
	}

	let snapshotEventId = prevEventId
	if (diff.next) {
		await recordEvent(tx, { ...base, action: CAPABILITY_ACTIONS.snapshot, data: diff.next })
		snapshotEventId = await newestSnapshotEventId(tx, workspaceId, source)
	} else if (diff.mode === 'diff' && hadFailures) {
		await recordEvent(tx, {
			...base,
			action: CAPABILITY_ACTIONS.probeRecovered,
			data: { source: source.key },
		})
	}

	let written = 0
	for (const finding of diff.findings) {
		if (!isWritten(finding)) continue
		await recordEvent(tx, {
			...base,
			action: CAPABILITY_ACTIONS.changed,
			data: {
				source: source.key,
				kind: finding.kind,
				tools: finding.tools,
				// As of scan time: a hint for reading the log, not an authority.
				holders: finding.kind === 'tool_added' ? holders : [],
				dedupe_key: finding.dedupeKey,
				snapshot_event_id: snapshotEventId,
			},
		})
		written++
	}
	return written
}

/**
 * Only a flagged tool_added becomes a capability_changed event, plus the
 * one-off source_unreachable. Removals, schema changes and spec changes live in
 * the snapshot and the scan counts, never as findings. A tool nobody holds is
 * stored and not written.
 */
function isWritten(finding: Finding): boolean {
	return (finding.kind === 'tool_added' && finding.flagged) || finding.kind === 'source_unreachable'
}

async function newestSnapshotEventId(
	tx: Transaction,
	workspaceId: string,
	source: CapabilitySource,
): Promise<number | null> {
	const latest = await latestSnapshot(tx, workspaceId, source)
	return latest?.eventId ?? null
}
