import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import { S3StorageProvider } from '@maskin/storage'
import { Cron } from 'croner'
import {
	buildAssistantPayload,
	ensureAssistant,
	readDisclosureLocale,
} from '../lib/integrations/providers/telnyx/assistant'
import { createTelnyxClient } from '../lib/integrations/providers/telnyx/client'
import { readTelnyxRuntimeConfig } from '../lib/integrations/providers/telnyx/config'
import {
	type KnowledgeExporterConfig,
	exportKnowledge,
	readKnowledgeExporterConfig,
} from '../lib/integrations/providers/telnyx/knowledge-exporter'
import { logger } from '../lib/logger'

/**
 * Keeps the Telnyx assistant and its knowledge base current (tech spec 2b.6, layer 2). One pass
 * uploads the customer_facing knowledge objects, then creates or updates the assistant (idempotent
 * by content hash) with the retrieval tool attached. Passes run at start, nightly, and a few
 * seconds after a knowledge object changes, which keeps a flip live inside 60s. Off, with a log
 * line, until TELNYX_KB_WORKSPACE_ID, TELNYX_KB_BUCKET and TELNYX_API_KEY are set.
 */
const CRON_EXPRESSION = '0 3 * * *'
const DEBOUNCE_MS = 5_000

export class TelnyxKnowledgeExporterJob {
	private job: Cron | null = null
	private running = false
	private rerun = false
	private timer: ReturnType<typeof setTimeout> | null = null
	/** Events carry the object's own type as entity_type, so a knowledge change arrives as 'knowledge'. */
	private readonly onEvent = (event: { entity_type: string; workspace_id: string }) => {
		if (event.entity_type !== 'knowledge') return
		if (event.workspace_id !== readKnowledgeExporterConfig()?.workspaceId) return
		this.schedule()
	}

	constructor(
		db: Database,
		private bridge: Pick<PgNotifyBridge, 'on' | 'off'> | null = null,
		private pass: () => Promise<unknown> = () => runExportPass(db),
		private debounceMs: number = DEBOUNCE_MS,
	) {}

	start(): void {
		if (this.job) return
		if (readKnowledgeExporterConfig() === null) {
			logger.info(
				'Telnyx knowledge exporter off: TELNYX_KB_WORKSPACE_ID / TELNYX_KB_BUCKET / TELNYX_API_KEY not set',
			)
			return
		}
		this.job = new Cron(CRON_EXPRESSION, { protect: true }, () => void this.run('cron'))
		this.bridge?.on('event', this.onEvent)
		void this.run('start')
	}

	stop(): void {
		this.job?.stop()
		this.job = null
		this.bridge?.off('event', this.onEvent)
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
	}

	schedule(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => {
			this.timer = null
			void this.run('knowledge_changed')
		}, this.debounceMs)
	}

	async run(trigger: string): Promise<void> {
		if (this.running) {
			this.rerun = true
			return
		}
		this.running = true
		try {
			await this.pass()
		} catch (err) {
			logger.error('Telnyx knowledge export pass failed', {
				trigger,
				error: err instanceof Error ? err.message : String(err),
			})
		} finally {
			this.running = false
			if (this.rerun) {
				this.rerun = false
				void this.run('rerun')
			}
		}
	}
}

export async function runExportPass(db: Database): Promise<void> {
	const config = readKnowledgeExporterConfig()
	if (!config) return
	const runtime = readTelnyxRuntimeConfig()
	const telnyx = createTelnyxClient({ apiKey: config.apiKey, baseUrl: runtime.apiBaseUrl })
	const result = await exportKnowledge(db, {
		config,
		bucket: storageFor(config),
		telnyx,
	})
	logger.info('Telnyx knowledge exported', {
		uploaded: result.uploaded.length,
		removed: result.removed.length,
		firstPersonWarnings: result.warnings.length,
	})

	const base = (process.env.MASKIN_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
	const assistant = await ensureAssistant(telnyx, {
		assistantId: runtime.assistantId,
		payload: buildAssistantPayload({
			locale: readDisclosureLocale(),
			toolWebhookUrl: `${base}/api/integrations/telnyx/webhook`,
			toolIds: [result.retrievalToolId],
		}),
	})
	logger.info('Telnyx assistant synced', { action: assistant.action, hash: assistant.hash })
	if (assistant.action === 'created') {
		// Telnyx assigned a new id: calls only use it once TELNYX_ASSISTANT_ID names it.
		logger.warn('Telnyx assistant created: set TELNYX_ASSISTANT_ID', {
			assistantId: assistant.assistantId,
		})
	}
}

function storageFor(config: KnowledgeExporterConfig) {
	return new S3StorageProvider({
		endpoint: config.storageEndpoint,
		bucket: config.bucketName,
		accessKeyId: config.apiKey,
		secretAccessKey: config.apiKey,
	})
}
