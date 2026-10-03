import type { Database } from '@maskin/db'
import type { PgEvent } from '@maskin/realtime'
import { Cron } from 'croner'
import {
	type KnowledgeExportDeps,
	defaultKnowledgeExportDeps,
	runKnowledgeExport,
} from '../lib/integrations/providers/telnyx/knowledge-exporter'
import { logger } from '../lib/logger'

/** Baseline refresh, off the round hour like the other nightly jobs. */
const CRON_EXPRESSION = '41 3 * * *'
/** Events on a knowledge object (entity_type is the object's type) that can change what is exported. */
const REFRESH_ACTIONS = new Set(['created', 'updated', 'deleted'])
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
		this.listener = (event) => this.onEvent(event)
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

	private onEvent(event: PgEvent): void {
		if (event.entity_type !== 'knowledge' || !REFRESH_ACTIONS.has(event.action)) return
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
