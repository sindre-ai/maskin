import type { Database, Transaction } from '@maskin/db'
import { events, workspaces } from '@maskin/db/schema'
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { trackCapabilityScanCompleted } from '../lib/analytics/capability-events'
import { findAvailableNotAttached } from '../lib/capabilities/connection-findings'
import {
	type CapabilitySnapshot,
	type DiffResult,
	type Finding,
	type ProbeOutcome,
	availableNotAttachedFinding,
	diffCapabilities,
} from '../lib/capabilities/diff'
import {
	type HolderContext,
	type HolderSource,
	countUnscannedServers,
	holdersForSources,
} from '../lib/capabilities/holders'
import { type ProbeFn, probeSource } from '../lib/capabilities/probe'
import {
	type CapabilitySource,
	enumerateActiveIntegrations,
	enumerateSources,
	loadGrantedScopes,
	providerConfigOf,
} from '../lib/capabilities/sources'
import { findChiefOfStaffId } from '../lib/chief-of-staff'
import { recordEvent } from '../lib/events/record-event'
import { logger } from '../lib/logger'
import { runCapabilityDigest } from './capability-digest'

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
	| { status: 'skipped'; reason: 'no_chief_of_staff' | 'recent_scan' | 'lock_busy' }

/**
 * Daily capability scan. A server job: no model, no session. For
 * each workspace it asks every tool source what it can do, compares the
 * answer with the stored snapshot and writes the result as events. Shape of
 * MeetWatchRenewer: start, stop, interval tick, running re-entrancy guard.
 *
 * Findings are written as capability_changed events (readable with get_events)
 * and the digest at the end of each workspace scan messages each recipient.
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
				try {
					const result = await this.scanWorkspace(id, opts)
					if (result.status === 'scanned') {
						scanned++
						await this.digest(id)
					} else skipped++
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

	/**
	 * End of the tick for one workspace: tell people what the scan found. A failure
	 * here is logged and never stops the tick; the findings stay pending and the
	 * next daily tick retries.
	 */
	private async digest(workspaceId: string): Promise<void> {
		try {
			await runCapabilityDigest(this.db, workspaceId, { now: this.now })
		} catch (err) {
			logger.error('Capability digest failed for workspace', {
				workspaceId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	async scanWorkspace(
		workspaceId: string,
		opts: { boot?: boolean } = {},
	): Promise<WorkspaceScanResult> {
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
		const activeIntegrations = await enumerateActiveIntegrations(this.db, workspaceId)
		const holderSources = new Map<string, HolderSource>(
			sources.map((source) => [source.key, toHolderSource(source)]),
		)
		for (const row of activeIntegrations) {
			if (holderSources.has(row.sourceKey)) continue
			holderSources.set(row.sourceKey, {
				key: row.sourceKey,
				provider: row.provider,
				integrationId: row.integrationId,
			})
		}
		const holders = await holdersForSources(ctx, [...holderSources.values()])
		const grantedScopes = await loadGrantedScopes(
			this.db,
			workspaceId,
			sources.flatMap((source) => (source.integrationId ? [source.integrationId] : [])),
		)
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
					connection: source.provider
						? {
								config: providerConfigOf(source.provider),
								credentials: grantedScopes.get(source.integrationId ?? '') ?? {},
							}
						: undefined,
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
				totals.findings_eligible += diff.findings.filter(isEligible).length
			}

			// Connected but held by nobody: a state, not a diff, so it has no probe. It
			// is written through the same writer and counted the same way.
			const unattached = findAvailableNotAttached({
				integrations: activeIntegrations,
				configFor: providerConfigOf,
				holdersBySource: holders,
			})
			for (const row of unattached) {
				const finding = availableNotAttachedFinding(workspaceId, row.sourceKey)
				if (await alreadyReported(tx, workspaceId, row.integrationId, finding)) continue
				findingsWritten += await writeChangedFindings(tx, {
					workspaceId,
					actorId,
					entityId: row.integrationId,
					provider: row.provider,
					findings: [finding],
					holders: [],
					snapshotEventId: null,
				})
				totals.findings_eligible++
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

	return writeChangedFindings(tx, {
		workspaceId,
		actorId,
		entityId: source.entityId,
		provider: source.provider,
		findings: diff.findings,
		holders,
		snapshotEventId,
	})
}

/** The one writer of capability_changed events, for every finding kind. */
async function writeChangedFindings(
	tx: Transaction,
	params: {
		workspaceId: string
		actorId: string
		entityId: string
		provider: string | undefined
		findings: readonly Finding[]
		holders: readonly string[]
		snapshotEventId: number | null
	},
): Promise<number> {
	const { workspaceId, actorId, entityId, provider, findings, holders, snapshotEventId } = params
	let written = 0
	for (const finding of findings) {
		if (!isWritten(finding)) continue
		const toolKind = finding.kind === 'tool_added' || finding.kind === 'needs_reconnect'
		const connectionKind =
			finding.kind === 'needs_reconnect' || finding.kind === 'available_not_attached'
		await recordEvent(tx, {
			workspaceId,
			actorId,
			entityType: CAPABILITY_SOURCE_ENTITY,
			entityId,
			action: CAPABILITY_ACTIONS.changed,
			data: {
				source: finding.source,
				kind: finding.kind,
				tools: finding.tools,
				// As of scan time: a hint for reading the log, not an authority.
				holders: toolKind ? holders : [],
				dedupe_key: finding.dedupeKey,
				snapshot_event_id: snapshotEventId,
				// Names only: the integration and the scopes it lacks, never a token.
				...(connectionKind ? { provider } : {}),
				...(finding.missingScopes ? { missing_scopes: finding.missingScopes } : {}),
			},
		})
		written++
	}
	return written
}

/**
 * What becomes a capability_changed event: a flagged tool_added, a needs_reconnect
 * (flagged only when a holder exists), an available_not_attached, and the one-off
 * source_unreachable. Removals, schema changes and spec changes live in the
 * snapshot and the scan counts, never as findings. A tool nobody holds is stored
 * and not written.
 */
function isWritten(finding: Finding): boolean {
	return isEligible(finding) || finding.kind === 'source_unreachable'
}

/** Counted in findings_eligible on capability_scan_completed. */
function isEligible(finding: Finding): boolean {
	return (
		finding.flagged &&
		(finding.kind === 'tool_added' ||
			finding.kind === 'needs_reconnect' ||
			finding.kind === 'available_not_attached')
	)
}

/** Whether an event with this finding's dedupe_key already sits on the integration. */
async function alreadyReported(
	tx: Transaction,
	workspaceId: string,
	entityId: string,
	finding: Finding,
): Promise<boolean> {
	const [row] = await tx
		.select({ id: events.id })
		.from(events)
		.where(
			and(
				eq(events.workspaceId, workspaceId),
				eq(events.entityId, entityId),
				eq(events.action, CAPABILITY_ACTIONS.changed),
				sql`${events.data}->>'dedupe_key' = ${finding.dedupeKey}`,
			),
		)
		.limit(1)
	return Boolean(row)
}

async function newestSnapshotEventId(
	tx: Transaction,
	workspaceId: string,
	source: CapabilitySource,
): Promise<number | null> {
	const latest = await latestSnapshot(tx, workspaceId, source)
	return latest?.eventId ?? null
}
