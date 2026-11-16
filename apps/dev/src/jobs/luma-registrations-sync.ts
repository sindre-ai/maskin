import { randomUUID } from 'node:crypto'
import type { Database } from '@maskin/db'
import { integrations, objects } from '@maskin/db/schema'
import { Cron } from 'croner'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getCredential } from '../lib/integrations/lookup'
import { logger } from '../lib/logger'
import {
	LumaApiError,
	countGuestsByStatus,
	findLumaListingUrl,
	listCalendarEvents,
	lumaSlug,
} from '../lib/luma-api'
import { recordReading } from '../lib/readings'

/**
 * Reads the guest list of each Luma event from Luma's own API and writes the number of
 * registrations as a reading (measure luma.registrations). No model in the path.
 *
 * Every 30 minutes, for each event with platform luma between planned and live: find the
 * Luma event from the listing URL posted on the event, page through its guests, count the
 * approved ones as the value and keep the count per approval status in the detail. The
 * status counts let a pilot see a room filling with the wrong status (waitlist, pending).
 *
 * Safe to re-run: the reading is keyed by Luma event and 30-minute slot, so a second run in
 * the same slot adds no row. One event failing is logged and the rest carry on; a failed
 * read writes nothing, so a gap is a gap and never a wrong number.
 *
 * The Luma key is read through the Keychain's choke point (getCredential) as `actorId`, so
 * the grant check and the audit row apply. With no key it logs once and does nothing until
 * one appears. Off unless the workspace and actor are configured.
 */
const CRON_EXPRESSION = '*/30 * * * *'
const SLOT_MS = 30 * 60 * 1000
const MEASURE = 'luma.registrations'
const SOURCE = 'luma-api'
/** Event statuses that are being sold: from planned up to and including live. */
const WATCHED_STATUSES = ['planned', 'in_production', 'live']
/** Always present in the detail, so a missing status reads as 0 and not as "unknown". */
const KNOWN_STATUSES = ['pending_approval', 'waitlist', 'invited', 'declined', 'session']

export interface LumaRegistrationsSyncConfig {
	workspaceId: string
	/** Agent that holds the Keychain grant for the Luma key. */
	actorId: string
	/** Display name of the Luma key in the Keychain. */
	keyName: string
}

export interface LumaRegistrationsSyncDeps {
	/** The Luma key, or null (logged) when it cannot be had. */
	readKey: (db: Database, config: LumaRegistrationsSyncConfig) => Promise<string | null>
	listCalendarEvents: typeof listCalendarEvents
	countGuestsByStatus: typeof countGuestsByStatus
	now: () => Date
}

async function readKey(db: Database, config: LumaRegistrationsSyncConfig): Promise<string | null> {
	const { workspaceId, actorId, keyName } = config
	const [row] = await db
		.select({ id: integrations.id })
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, workspaceId),
				eq(integrations.providerMode, 'byo_apikey'),
				eq(integrations.displayName, keyName),
				eq(integrations.status, 'active'),
			),
		)
		.limit(1)
	if (!row) return null
	const credential = await getCredential(db, workspaceId, row.id, {
		requestingActorId: actorId,
		outboundTarget: 'public-api.luma.com',
		requestId: `luma-registrations-sync:${randomUUID()}`,
	})
	return credential.value
}

const defaultDeps: LumaRegistrationsSyncDeps = {
	readKey,
	listCalendarEvents,
	countGuestsByStatus,
	now: () => new Date(),
}

export class LumaRegistrationsSyncJob {
	private job: Cron | null = null
	private running = false
	/** True once "no key" has been logged, so a missing key is one line and not one every 30 minutes. */
	private missingKeyLogged = false

	constructor(
		private db: Database,
		private config: LumaRegistrationsSyncConfig,
		private deps: LumaRegistrationsSyncDeps = defaultDeps,
		private cronExpression: string = CRON_EXPRESSION,
	) {}

	start(): void {
		if (this.job) return
		this.job = new Cron(this.cronExpression, { timezone: 'UTC' }, async () => {
			await this.tick()
		})
	}

	stop(): void {
		if (this.job) {
			this.job.stop()
			this.job = null
		}
	}

	/** Returns the number of readings written. Never throws. */
	async tick(): Promise<number> {
		if (this.running) return 0
		this.running = true
		try {
			const apiKey = await this.deps.readKey(this.db, this.config).catch((err) => {
				logger.error('Luma registrations sync: could not read the key', { error: String(err) })
				return null
			})
			if (!apiKey) {
				if (!this.missingKeyLogged) {
					logger.warn(
						'Luma registrations sync: no usable Luma key in the Keychain; doing nothing until there is one',
						{ keyName: this.config.keyName },
					)
					this.missingKeyLogged = true
				}
				return 0
			}
			this.missingKeyLogged = false

			const watched = await this.watchedEvents()
			if (watched.length === 0) return 0

			const calendar = await this.deps.listCalendarEvents(apiKey)
			const bySlug = new Map<string, string>()
			for (const e of calendar) {
				const slug = lumaSlug(e.url)
				if (slug) bySlug.set(slug, e.id)
			}

			const readAt = this.deps.now()
			const slot = new Date(Math.floor(readAt.getTime() / SLOT_MS) * SLOT_MS).toISOString()
			let written = 0
			for (const event of watched) {
				try {
					const url = findLumaListingUrl(event.metadata, event.content)
					const slug = url ? lumaSlug(url) : null
					if (!slug) {
						logger.warn('Luma registrations sync: no Luma listing URL on the event', {
							eventObjectId: event.id,
						})
						continue
					}
					const lumaEventId = bySlug.get(slug)
					if (!lumaEventId) {
						logger.warn('Luma registrations sync: listing URL is not on the Luma calendar', {
							eventObjectId: event.id,
						})
						continue
					}
					const counts = await this.deps.countGuestsByStatus(apiKey, lumaEventId)
					const detail: Record<string, unknown> = { luma_event_id: lumaEventId }
					for (const status of KNOWN_STATUSES) detail[status] = 0
					for (const [status, n] of Object.entries(counts)) {
						if (status !== 'approved') detail[status] = n
					}
					const { inserted } = await recordReading(this.db, {
						workspaceId: this.config.workspaceId,
						subjectId: event.id,
						measure: MEASURE,
						value: counts.approved ?? 0,
						readAt,
						source: SOURCE,
						sourceRef: `${lumaEventId}@${slot}`,
						detail,
					})
					if (inserted) written++
				} catch (err) {
					logger.error('Luma registrations sync: event not read; will retry on the next run', {
						eventObjectId: event.id,
						error: String(err),
					})
					// Luma blocks all calls for a minute after a 429; the next event would fail too.
					if (err instanceof LumaApiError && err.status === 429) break
				}
			}
			if (written > 0)
				logger.info('Luma registrations sync tick', { events: watched.length, written })
			return written
		} catch (err) {
			logger.error('Luma registrations sync tick failed', { error: String(err) })
			return 0
		} finally {
			this.running = false
		}
	}

	private async watchedEvents() {
		return this.db
			.select({ id: objects.id, metadata: objects.metadata, content: objects.content })
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, this.config.workspaceId),
					eq(objects.type, 'event'),
					inArray(objects.status, WATCHED_STATUSES),
					sql`${objects.metadata}->>'platform' = 'luma'`,
				),
			)
	}
}
