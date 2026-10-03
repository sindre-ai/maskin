import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import type { PgEvent } from '@maskin/realtime'
import { Cron } from 'croner'
import { eq } from 'drizzle-orm'
import {
	type KnowledgeExportDeps,
	defaultKnowledgeExportDeps,
	runKnowledgeExport,
} from '../lib/integrations/providers/telnyx/knowledge-exporter'
import { logger } from '../lib/logger'

/** Baseline refresh, off the round hour like the other nightly jobs. */
const CRON_EXPRESSION = '41 3 * * *'
/** Collapses a burst of knowledge edits into one export, well inside the 60s refresh target. */
const DEBOUNCE_MS = 5_000

interface EventSource {
	on(event: 'event', listener: (e: PgEvent) => void): unknown
	off?(event: 'event', listener: (e: PgEvent) => void): unknown
}

/**
 * Keeps the Telnyx knowledge base in step with customer_facing knowledge: a nightly full pass,
 * plus a debounced pass whenever a knowledge object is created or updated (PG NOTIFY). Does
 * nothing at all when TELNYX_API_KEY is unset. Mirrors PurgeIdempotencyJob: a swallowed-error
 * tick that logs but never throws, guarded against overlapping runs.
 *
 * A deleted knowledge object is not seen by the NOTIFY path (the row is gone, so its type
 * cannot be read); the nightly pass removes it from the bucket.
 */
export class TelnyxKnowledgeExporterJob {
	private job: Cron | null = null
	private timer: NodeJS.Timeout | null = null
	private running = false
	private rerun = false
	private listener: ((e: PgEvent) => void) | null = null

	constructor(
		private db: Database,
		private source: EventSource,
		private resolveDeps: () => KnowledgeExportDeps | null = defaultKnowledgeExportDeps,
		private debounceMs: number = DEBOUNCE_MS,
		private cronExpression: string = CRON_EXPRESSION,
	) {}

	start(): void {
		if (this.job) return
		this.job = new Cron(this.cronExpression, { timezone: 'UTC' }, async () => {
			await this.tick()
		})
		this.listener = (event) => {
			void this.onEvent(event)
		}
		this.source.on('event', this.listener)
	}

	stop(): void {
		this.job?.stop()
		this.job = null
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
		if (this.listener) this.source.off?.('event', this.listener)
		this.listener = null
	}

	private async onEvent(event: PgEvent): Promise<void> {
		if (event.entity_type !== 'object') return
		if (event.action !== 'created' && event.action !== 'updated') return
		try {
			const [row] = await this.db
				.select({ type: objects.type })
				.from(objects)
				.where(eq(objects.id, event.entity_id))
				.limit(1)
			if (row?.type !== 'knowledge') return
		} catch (err) {
			logger.error('Telnyx knowledge exporter event lookup failed', {
				error: err instanceof Error ? err.message : String(err),
			})
			return
		}
		this.schedule()
	}

	private schedule(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => {
			this.timer = null
			void this.tick()
		}, this.debounceMs)
	}

	async tick(): Promise<void> {
		if (this.running) {
			// An edit landed mid-export: run once more when this one ends.
			this.rerun = true
			return
		}
		this.running = true
		try {
			const deps = this.resolveDeps()
			if (!deps) return
			const result = await runKnowledgeExport(this.db, deps)
			logger.info('Telnyx knowledge export tick', { ...result })
		} catch (err) {
			logger.error('Telnyx knowledge export tick failed', {
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
			if (this.rerun) {
				this.rerun = false
				this.schedule()
			}
		}
	}
}
