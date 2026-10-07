/**
 * Unipile webhook ingest: a verified, parsed envelope becomes at most one
 * `events` row per active integration row, deduped and flag-gated.
 *
 * Lives in the provider directory (not the route) so the route keeps owning
 * the transport (headers, secret, status codes for signature and JSON) and this
 * module owns the pipeline:
 *
 *   account -> integration rows -> flag -> claims -> classify -> commit
 *
 * Everything runs inline inside a work budget. Permanent conditions answer 200
 * with a skip reason (Unipile's retries would only repeat them). Only a
 * transient failure answers 503, and the claims are released first so the
 * retry at +2s or +12s can reprocess.
 */

import type { Database } from '@maskin/db'
import { integrations, webhookDeliveries } from '@maskin/db/schema'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { recordEvents } from '../../../events/record-event'
import { isFlagEnabled } from '../../../feature-flags'
import { logger } from '../../../logger'
import type { IntegrationConfig } from '../../../types'
import { ClaimReleasedError, commitWebhookDelivery } from '../../webhooks/commit'
import { type DeliveryReporter, createDeliveryReporter } from './delivery-telemetry'
import { readOwnLinkedinIds } from './direction'
import type { UnipileEnvelope } from './envelope'
import { type EventMapRow, type IntegrationRow, resourceId } from './event-map'

const PROVIDER = 'linkedin-unipile'

/** Unipile gives up on a delivery after 5 seconds; leave a second to answer. */
export const WORK_BUDGET_MS = 4000

export interface IngestOutcome {
	status: 200 | 503
	body: Record<string, unknown>
}

type RowResult = { outcome: 'emitted' } | { outcome: 'skipped'; reason: string }

class DuplicateDeliveryError extends Error {
	constructor() {
		super('duplicate delivery')
		this.name = 'DuplicateDeliveryError'
	}
}

class BudgetExceededError extends Error {
	constructor() {
		super('work budget exceeded')
		this.name = 'BudgetExceededError'
	}
}

/** One integration row's in-flight claims, so a failure or timeout can release exactly them. */
interface InFlight {
	integration: IntegrationRow
	claimIds: string[]
	settled: boolean
}

/**
 * Owner actor for flag checks and the fallback event actor: the connecting
 * human on the integration row.
 */
function ownerActorId(row: IntegrationRow): string {
	return row.actorId ?? row.createdBy
}

/** system_actor_id, then the integration actor, then created_by. */
function eventActorId(row: IntegrationRow): string {
	const config = row.config as IntegrationConfig | null
	const systemActorId = config?.system_actor_id
	return typeof systemActorId === 'string' && systemActorId.length > 0
		? systemActorId
		: ownerActorId(row)
}

/** Two claims per delivery in one transaction, both onConflictDoNothing. Either missing means duplicate. */
async function claimDelivery(
	db: Database,
	workspaceId: string,
	keys: string[],
): Promise<string[] | 'duplicate'> {
	try {
		return await db.transaction(async (tx) => {
			const ids: string[] = []
			for (const externalId of keys) {
				const rows = await tx
					.insert(webhookDeliveries)
					.values({ provider: PROVIDER, externalId, workspaceId })
					.onConflictDoNothing({
						target: [
							webhookDeliveries.provider,
							webhookDeliveries.externalId,
							webhookDeliveries.workspaceId,
						],
					})
					.returning({ id: webhookDeliveries.id })
				const id = rows[0]?.id
				// Throwing rolls back the claim already inserted, so a duplicate leaves no orphan.
				if (!id) throw new DuplicateDeliveryError()
				ids.push(id)
			}
			return ids
		})
	} catch (err) {
		if (err instanceof DuplicateDeliveryError) return 'duplicate'
		throw err
	}
}

/** Delete unprocessed claims only: a claim the commit already marked processed must stay. */
async function releaseClaims(db: Database, claimIds: string[]): Promise<void> {
	if (claimIds.length === 0) return
	await db
		.delete(webhookDeliveries)
		.where(and(inArray(webhookDeliveries.id, claimIds), isNull(webhookDeliveries.processedAt)))
}

function errorCode(err: unknown): string {
	if (err instanceof Error) {
		const code = (err as { code?: unknown }).code
		return typeof code === 'string' ? code : err.name
	}
	return 'unknown'
}

/**
 * Failure after (or around) the claim: release the claims, write a dead-letter
 * events row (ids and an error code, never a body) and report the delivery as
 * failed (its one log line and PostHog event). Idempotent so the
 * row's own catch and the budget timeout cannot both run it.
 */
async function failDelivery(
	db: Database,
	entry: InFlight,
	envelope: UnipileEnvelope,
	err: unknown,
	reporter: DeliveryReporter,
): Promise<void> {
	if (entry.settled) return
	entry.settled = true
	const code = errorCode(err)
	reporter.report(entry.integration, {
		outcome: 'failed',
		reason: code,
		error: err instanceof Error ? err.message : String(err),
	})
	try {
		await releaseClaims(db, entry.claimIds)
	} catch (releaseErr) {
		logger.error('linkedin-unipile webhook: failed to release claims', {
			integration_id: entry.integration.id,
			error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
		})
	}
	try {
		await recordEvents(db, [
			{
				workspaceId: entry.integration.workspaceId,
				actorId: eventActorId(entry.integration),
				action: 'failed',
				entityType: 'linkedin.webhook',
				entityId: entry.integration.id,
				data: {
					unipile_event_type: envelope.type,
					external_id: resourceId(envelope),
					envelope_id: envelope.envelopeId,
					error_code: code,
				},
			},
		])
	} catch (deadLetterErr) {
		logger.error('linkedin-unipile webhook: failed to write dead-letter event', {
			integration_id: entry.integration.id,
			error: deadLetterErr instanceof Error ? deadLetterErr.message : String(deadLetterErr),
		})
	}
}

/** The only two drops worth a durable row: they signal is_sender is unreliable, and the alert counts them. */
const PERSISTED_DROP_REASONS = new Set(['direction_unknown', 'direction_conflict'])

/**
 * Durable record of a direction drop (ids and the reason only, never a body), so
 * the alert has a database source instead of resting on PostHog capture. Guarded
 * like the dead-letter write: a failed write must not change the outcome, the
 * claims or dedupe. A retry can write a second row for the same delivery, so
 * readers count distinct envelope_id.
 */
async function recordDirectionDrop(
	db: Database,
	integration: IntegrationRow,
	envelope: UnipileEnvelope,
	reason: string,
): Promise<void> {
	try {
		await recordEvents(db, [
			{
				workspaceId: integration.workspaceId,
				actorId: eventActorId(integration),
				action: 'dropped',
				entityType: 'linkedin.webhook',
				entityId: integration.id,
				data: {
					reason,
					unipile_event_type: envelope.type,
					external_id: resourceId(envelope),
					envelope_id: envelope.envelopeId,
					account_id: envelope.accountId,
				},
			},
		])
	} catch (err) {
		logger.error('linkedin-unipile webhook: failed to write direction drop event', {
			integration_id: integration.id,
			reason,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}

async function processRow(
	db: Database,
	map: EventMapRow,
	envelope: UnipileEnvelope,
	integration: IntegrationRow,
	inFlight: InFlight[],
	reporter: DeliveryReporter,
): Promise<RowResult> {
	// Flag is read per integration row, on the owner actor, before any claim, so
	// a flag-off delivery writes no claim and switching on later needs no replay.
	if (!isFlagEnabled(ownerActorId(integration), map.flag)) {
		reporter.report(integration, { outcome: 'dropped', reason: 'flag_off' })
		return { outcome: 'skipped', reason: 'flag_off' }
	}

	const keys: string[] = []
	if (envelope.accountId && envelope.envelopeId) {
		keys.push(`evt:${envelope.accountId}:${envelope.envelopeId}`)
	}
	const contentKey = map.deliveryKey(envelope)
	if (contentKey) keys.push(contentKey)

	const claimed = await claimDelivery(db, integration.workspaceId, keys)
	if (claimed === 'duplicate') {
		reporter.report(integration, { outcome: 'duplicate', reason: 'duplicate' })
		return { outcome: 'skipped', reason: 'duplicate' }
	}

	const entry: InFlight = { integration, claimIds: claimed, settled: false }
	inFlight.push(entry)

	try {
		const result = await map.classify({
			envelope,
			integration,
			ownIds: readOwnLinkedinIds,
		})
		const [primaryClaim, ...otherClaims] = claimed

		if (result.kind === 'drop') {
			// direction_unknown leaves the claims in place (a retry still dedupes, the
			// sweep recovers); every other drop is final, so mark the claims processed.
			if (!result.keepClaim) {
				await commitWebhookDelivery(db, {
					eventRows: [],
					claimRowId: primaryClaim ?? null,
					additionalClaimRowIds: otherClaims,
				})
			}
			if (PERSISTED_DROP_REASONS.has(result.reason)) {
				await recordDirectionDrop(db, integration, envelope, result.reason)
			}
			entry.settled = true
			reporter.report(integration, {
				outcome: 'dropped',
				reason: result.reason,
				extra: result.log,
			})
			return { outcome: 'skipped', reason: result.reason }
		}

		await commitWebhookDelivery(db, {
			eventRows: [
				{
					workspaceId: integration.workspaceId,
					actorId: eventActorId(integration),
					action: result.action,
					entityType: map.entityType,
					entityId: result.entityId,
					data: result.data,
				},
			],
			claimRowId: primaryClaim ?? null,
			additionalClaimRowIds: otherClaims,
		})
		entry.settled = true
		reporter.report(integration, {
			outcome: 'emitted',
			extra: { ...result.log, classification: result.data.classification },
		})
		return { outcome: 'emitted' }
	} catch (err) {
		if (err instanceof ClaimReleasedError) {
			// The reconciler (or the budget timeout) freed the claim mid-flight; the
			// transaction rolled back, so nothing was written.
			entry.settled = true
			reporter.report(integration, { outcome: 'duplicate', reason: 'claim_released' })
			return { outcome: 'skipped', reason: 'duplicate' }
		}
		await failDelivery(db, entry, envelope, err, reporter)
		throw err
	}
}

export async function ingestUnipileEnvelope(
	db: Database,
	map: EventMapRow,
	envelope: UnipileEnvelope,
	options: { budgetMs?: number } = {},
): Promise<IngestOutcome> {
	// Every delivery reports exactly once per integration row: the reporter
	// ignores a second report for the same row, so a late failure cannot add a line.
	const reporter = createDeliveryReporter(envelope, true)
	const accountId = map.accountId(envelope)
	if (!accountId) {
		reporter.report(null, { outcome: 'dropped', reason: 'missing_account_id' })
		return { status: 200, body: { ok: true, skipped: 'missing_account_id' } }
	}

	const inFlight: InFlight[] = []
	let loadedRows: IntegrationRow[] = []
	let timer: ReturnType<typeof setTimeout> | undefined
	let expired = false

	const work = (async (): Promise<IngestOutcome> => {
		const rows = await db
			.select()
			.from(integrations)
			.where(
				and(
					eq(integrations.provider, PROVIDER),
					eq(integrations.externalId, accountId),
					eq(integrations.status, 'active'),
				),
			)
		loadedRows = rows
		if (rows.length === 0) {
			reporter.report(null, { outcome: 'dropped', reason: 'no_active_integration' })
			return { status: 200, body: { ok: true, skipped: 'no_active_integration' } }
		}

		const results: RowResult[] = []
		for (const row of rows) {
			if (expired) throw new BudgetExceededError()
			results.push(await processRow(db, map, envelope, row, inFlight, reporter))
		}
		const emitted = results.filter((r) => r.outcome === 'emitted').length
		if (emitted > 0) return { status: 200, body: { ok: true, count: emitted } }
		const first = results[0]
		const reason = first?.outcome === 'skipped' ? first.reason : 'unknown'
		return { status: 200, body: { ok: true, skipped: reason } }
	})()

	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			expired = true
			reject(new BudgetExceededError())
		}, options.budgetMs ?? WORK_BUDGET_MS)
	})

	try {
		return await Promise.race([work, timeout])
	} catch (err) {
		// A timeout leaves `work` running; releasing the claims makes its commit
		// roll back (ClaimReleasedError), and swallowing its eventual rejection
		// keeps it from surfacing as an unhandled rejection.
		work.catch(() => {})
		for (const entry of inFlight) await failDelivery(db, entry, envelope, err, reporter)
		// Rows that never got as far as a claim (timeout, or a failure at the claim
		// itself) still owe their one line. Rows already reported are ignored.
		const failure = {
			outcome: 'failed',
			reason: errorCode(err),
			error: err instanceof Error ? err.message : String(err),
		} as const
		if (loadedRows.length === 0) reporter.report(null, failure)
		for (const row of loadedRows) reporter.report(row, failure)
		return {
			status: 503,
			body: {
				error: {
					code: 'INTERNAL_ERROR',
					message: 'Transient failure processing webhook; retry',
				},
			},
		}
	} finally {
		if (timer) clearTimeout(timer)
	}
}
