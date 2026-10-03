import type { Database } from '@maskin/db'
import { integrations } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { decrypt } from '../lib/crypto'
import type { StoredCredentials } from '../lib/integrations/types'
import { logger as defaultLogger } from '../lib/logger'
import type { IntegrationConfig } from '../lib/types'

// Cadence ladder (spec §8.3). Age = NOW - row.created_at.
export const CADENCE_TIGHT_UNTIL_MS = 5 * 60 * 1000
export const CADENCE_MID_UNTIL_MS = 20 * 60 * 1000
export const CADENCE_SLOW_UNTIL_MS = 30 * 60 * 1000
export const CADENCE_TIGHT_MS = 15_000
export const CADENCE_MID_MS = 60_000
export const CADENCE_SLOW_MS = 120_000
export const TIMEOUT_MS = CADENCE_SLOW_UNTIL_MS
const TICK_INTERVAL_MS = 15_000

// Resend `GET /domains/:id` response shape (spec §8.1). Only the fields this
// job maps into `config.resend` are declared — Resend may return more.
export interface ResendDomainGetResponse {
	id: string
	status: 'not_started' | 'pending' | 'verified' | 'failure'
	records?: ResendDnsRecord[]
	capabilities?: { sending?: string; receiving?: string }
}

export interface ResendDnsRecord {
	record: string
	type: string
	name: string
	value: string
	status: 'pending' | 'verified' | 'failed'
	ttl?: string | number
	priority?: number
}

export interface ResendDnsRecordConfig {
	record: string
	type: string
	name: string
	value: string
	priority?: number
	status: 'pending' | 'verified' | 'failed'
}

export interface ResendCapabilities {
	sending?: string
	receiving?: string
}

export interface ResendIntegrationConfig extends IntegrationConfig {
	resend?: {
		receive_subdomain?: string
		resend_domain_id?: string
		verification_status?: 'pending' | 'verified' | 'failed'
		verification_error?: string | null
		last_polled_at?: string | null
		webhook_url?: string
		dns_records?: ResendDnsRecordConfig[]
		capabilities?: ResendCapabilities
	}
}

type PollOutcome =
	| { kind: 'ok'; body: ResendDomainGetResponse }
	| { kind: 'auth_failed' }
	| { kind: 'not_found' }
	| { kind: 'retry'; statusOrErr: string }

type Logger = typeof defaultLogger

export type PollFn = (resendDomainId: string, accessToken: string) => Promise<PollOutcome>

/** Choose the cadence band for a row of a given age (spec §8.3). */
export function selectCadenceMs(ageMs: number): number {
	if (ageMs < CADENCE_TIGHT_UNTIL_MS) return CADENCE_TIGHT_MS
	if (ageMs < CADENCE_MID_UNTIL_MS) return CADENCE_MID_MS
	return CADENCE_SLOW_MS
}

/** True when the row's age crosses the 30-minute timeout boundary. */
export function isTimedOut(ageMs: number): boolean {
	return ageMs >= TIMEOUT_MS
}

/** Map Resend's top-level `status` to our stored `verification_status`. */
export function mapTopStatus(
	resendStatus: ResendDomainGetResponse['status'],
): 'pending' | 'verified' | 'failed' {
	if (resendStatus === 'verified') return 'verified'
	if (resendStatus === 'failure') return 'failed'
	return 'pending'
}

/**
 * Match Resend's per-record response against the row's stored `dns_records`
 * by the `record` field (SPF / DKIM / MX / Tracking) and copy the incoming
 * `status`. Preserve `name` / `value` / `priority` from the row's originals
 * so a benign re-echo from Resend doesn't churn the stored blob (spec §8.3).
 */
export function mergeDnsRecords(
	stored: ResendDnsRecordConfig[] | undefined,
	incoming: ResendDnsRecord[] | undefined,
): ResendDnsRecordConfig[] {
	if (!stored || stored.length === 0) {
		return (incoming ?? []).map((r) => ({
			record: r.record,
			type: r.type,
			name: r.name,
			value: r.value,
			priority: r.priority,
			status: r.status,
		}))
	}
	const byRecord = new Map<string, ResendDnsRecord>()
	for (const r of incoming ?? []) {
		byRecord.set(r.record, r)
	}
	return stored.map((row) => {
		const match = byRecord.get(row.record)
		return { ...row, status: match ? match.status : row.status }
	})
}

interface PollFieldMappingArgs {
	stored: ResendIntegrationConfig
	response: ResendDomainGetResponse
	now: Date
}

/** Build the new `config` blob to write after a successful poll (spec §8.1). */
export function buildPollFieldUpdate({
	stored,
	response,
	now,
}: PollFieldMappingArgs): ResendIntegrationConfig {
	const topStatus = mapTopStatus(response.status)
	const merged: ResendIntegrationConfig['resend'] = {
		...(stored.resend ?? {}),
		verification_status: topStatus,
		dns_records: mergeDnsRecords(stored.resend?.dns_records, response.records),
		capabilities: response.capabilities
			? { ...response.capabilities }
			: (stored.resend?.capabilities ?? undefined),
		last_polled_at: now.toISOString(),
	}
	if (topStatus === 'verified') {
		merged.verification_error = null
	}
	return { ...stored, resend: merged }
}

/** Build the config blob for the 30-minute timeout branch (spec §8.3). */
export function buildTimeoutFieldUpdate(
	stored: ResendIntegrationConfig,
	now: Date,
): ResendIntegrationConfig {
	return {
		...stored,
		resend: {
			...(stored.resend ?? {}),
			verification_status: 'failed',
			verification_error: 'timeout',
			last_polled_at: now.toISOString(),
		},
	}
}

/** Build the config blob when Resend no longer knows the domain id (404). */
export function buildNotFoundFieldUpdate(
	stored: ResendIntegrationConfig,
	now: Date,
): ResendIntegrationConfig {
	return {
		...stored,
		resend: {
			...(stored.resend ?? {}),
			verification_status: 'failed',
			verification_error: 'domain_not_found',
			last_polled_at: now.toISOString(),
		},
	}
}

/** Default poll implementation — real Resend HTTP call. Override in tests. */
export const defaultPoll: PollFn = async (resendDomainId, accessToken) => {
	let response: Response
	try {
		response = await fetch(`https://api.resend.com/domains/${resendDomainId}`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${accessToken}` },
		})
	} catch (err) {
		return { kind: 'retry', statusOrErr: err instanceof Error ? err.message : String(err) }
	}
	if (response.status === 401 || response.status === 403) {
		return { kind: 'auth_failed' }
	}
	if (response.status === 404) {
		return { kind: 'not_found' }
	}
	if (response.status === 429 || response.status >= 500) {
		return { kind: 'retry', statusOrErr: String(response.status) }
	}
	if (!response.ok) {
		return { kind: 'retry', statusOrErr: String(response.status) }
	}
	const body = (await response.json()) as ResendDomainGetResponse
	return { kind: 'ok', body }
}

export interface ResendDomainVerifierOptions {
	poll?: PollFn
	logger?: Logger
	tickIntervalMs?: number
	now?: () => Date
}

interface EligibleRow {
	id: string
	workspaceId: string
	credentials: string
	config: unknown
	createdAt: Date | null
}

/**
 * Polls Resend `GET /domains/:id` on every `awaiting_secret` resend
 * integration whose `config.resend.verification_status` is still `pending`,
 * on a cadence that tightens for new rows and widens for older ones (spec §8.3).
 *
 * Mirrors the shape of GmailWatchRenewer / MeetWatchRenewer — a class with
 * `start()` / `stop()` and a private `tick()`. Every DB write is
 * conditional on the row's current `verification_status` still being
 * `pending`, which is what makes the loop safely resumable under restart
 * (spec §12.7).
 */
export class ResendDomainVerifier {
	private timer: NodeJS.Timeout | null = null
	private running = false
	private readonly poll: PollFn
	private readonly logger: Logger
	private readonly tickIntervalMs: number
	private readonly now: () => Date

	constructor(
		private db: Database,
		options: ResendDomainVerifierOptions = {},
	) {
		this.poll = options.poll ?? defaultPoll
		this.logger = options.logger ?? defaultLogger
		this.tickIntervalMs = options.tickIntervalMs ?? TICK_INTERVAL_MS
		this.now = options.now ?? (() => new Date())
	}

	start(): void {
		if (this.timer) return
		this.timer = setInterval(() => this.tick(), this.tickIntervalMs)
		// Kick a first tick shortly after boot rather than waiting a full interval
		// — new rows want fast feedback and this matches gmail-watch-renewer's shape.
		setTimeout(() => this.tick(), 5_000).unref()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
	}

	async tick(): Promise<void> {
		if (this.running) return
		this.running = true
		try {
			const rows = (await this.db
				.select({
					id: integrations.id,
					workspaceId: integrations.workspaceId,
					credentials: integrations.credentials,
					config: integrations.config,
					createdAt: integrations.createdAt,
				})
				.from(integrations)
				.where(
					and(
						eq(integrations.provider, 'resend'),
						eq(integrations.status, 'awaiting_secret'),
						sql`${integrations.config}->'resend'->>'verification_status' = 'pending'`,
					),
				)) as EligibleRow[]

			for (const row of rows) {
				try {
					await this.processRow(row)
				} catch (err) {
					// A single row throwing must not kill the loop — the next row
					// still deserves its poll. Log and continue.
					this.logger.error('resend.domain.poll.unexpected', {
						workspace_id: row.workspaceId,
						integration_id: row.id,
						err: err instanceof Error ? err.message : String(err),
					})
				}
			}
		} finally {
			this.running = false
		}
	}

	private async processRow(row: EligibleRow): Promise<void> {
		const now = this.now()
		const createdAt = row.createdAt ?? now
		const ageMs = now.getTime() - createdAt.getTime()
		const config = (row.config as ResendIntegrationConfig | null) ?? {}
		const resendDomainId = config.resend?.resend_domain_id

		if (isTimedOut(ageMs)) {
			await this.applyTimeout(row, config, now, ageMs)
			return
		}

		if (!resendDomainId) {
			// No domain id to poll — nothing this job can do; wait for T2's writer
			// to seed it or for the row to time out on the next age tick.
			return
		}

		const cadenceMs = selectCadenceMs(ageMs)
		const lastPolledAt = config.resend?.last_polled_at
			? new Date(config.resend.last_polled_at).getTime()
			: null
		if (lastPolledAt !== null && lastPolledAt + cadenceMs > now.getTime()) {
			return
		}

		const accessToken = this.readAccessToken(row)
		if (!accessToken) {
			this.logger.warn('resend.domain.poll.auth_failed', {
				workspace_id: row.workspaceId,
				integration_id: row.id,
			})
			return
		}

		const outcome = await this.poll(resendDomainId, accessToken)
		if (outcome.kind === 'auth_failed') {
			this.logger.warn('resend.domain.poll.auth_failed', {
				workspace_id: row.workspaceId,
				integration_id: row.id,
			})
			return
		}
		if (outcome.kind === 'not_found') {
			await this.applyNotFound(row, config, now, resendDomainId)
			return
		}
		if (outcome.kind === 'retry') {
			this.logger.warn('resend.domain.poll.retry', {
				workspace_id: row.workspaceId,
				resend_domain_id: resendDomainId,
				status_or_err: outcome.statusOrErr,
			})
			return
		}

		const nextConfig = buildPollFieldUpdate({ stored: config, response: outcome.body, now })
		const wasVerified = mapTopStatus(outcome.body.status) === 'verified'

		// The WHERE clause locks writes to rows still `pending` — a concurrent
		// tick that already flipped the row to `verified` cannot be re-flipped by
		// this one (spec §12.7 restart-idempotency).
		const updated = await this.db
			.update(integrations)
			.set({ config: nextConfig, updatedAt: now })
			.where(
				and(
					eq(integrations.id, row.id),
					sql`${integrations.config}->'resend'->>'verification_status' = 'pending'`,
				),
			)
			.returning({ id: integrations.id })

		if (updated.length === 0) return

		this.logger.info('resend.domain.poll', {
			workspace_id: row.workspaceId,
			resend_domain_id: resendDomainId,
			top_status: outcome.body.status,
			per_record_status: (outcome.body.records ?? []).map((r) => ({
				record: r.record,
				status: r.status,
			})),
			cadence_ms: cadenceMs,
		})
		if (wasVerified) {
			this.logger.info('resend.domain.verified', {
				workspace_id: row.workspaceId,
				elapsed_ms: ageMs,
			})
		}
	}

	private async applyTimeout(
		row: EligibleRow,
		config: ResendIntegrationConfig,
		now: Date,
		ageMs: number,
	): Promise<void> {
		const nextConfig = buildTimeoutFieldUpdate(config, now)
		const updated = await this.db
			.update(integrations)
			.set({ config: nextConfig, updatedAt: now })
			.where(
				and(
					eq(integrations.id, row.id),
					sql`${integrations.config}->'resend'->>'verification_status' = 'pending'`,
				),
			)
			.returning({ id: integrations.id })
		if (updated.length === 0) return
		this.logger.warn('resend.domain.poll.timeout', {
			workspace_id: row.workspaceId,
			resend_domain_id: config.resend?.resend_domain_id ?? null,
			elapsed_ms: ageMs,
		})
	}

	private async applyNotFound(
		row: EligibleRow,
		config: ResendIntegrationConfig,
		now: Date,
		resendDomainId: string,
	): Promise<void> {
		const updated = await this.db
			.update(integrations)
			.set({ config: buildNotFoundFieldUpdate(config, now), updatedAt: now })
			.where(
				and(
					eq(integrations.id, row.id),
					sql`${integrations.config}->'resend'->>'verification_status' = 'pending'`,
				),
			)
			.returning({ id: integrations.id })
		if (updated.length === 0) return
		this.logger.warn('resend.domain.poll.not_found', {
			workspace_id: row.workspaceId,
			integration_id: row.id,
			resend_domain_id: resendDomainId,
		})
	}

	private readAccessToken(row: EligibleRow): string | null {
		try {
			const parsed = JSON.parse(decrypt(row.credentials)) as StoredCredentials
			return typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0
				? parsed.accessToken
				: null
		} catch {
			return null
		}
	}
}

/**
 * Convenience factory + starter (spec §12.7). Constructs the verifier, starts
 * its interval, and returns the instance so the caller can `.stop()` it on
 * SIGTERM alongside the other renewers.
 */
export function startResendDomainVerifier(
	db: Database,
	options: ResendDomainVerifierOptions = {},
): ResendDomainVerifier {
	const verifier = new ResendDomainVerifier(db, options)
	verifier.start()
	return verifier
}
