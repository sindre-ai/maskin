import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, sql } from 'drizzle-orm'
import { logger } from '../../../logger'
import type { TelnyxClient } from './client'

export const KB_RETRIEVAL_TOOL_NAME = 'Maskin customer-facing knowledge'
const KEY_PREFIX = 'knowledge-'

export interface KnowledgeExporterConfig {
	/** The one workspace whose customer_facing knowledge reaches the assistant. */
	workspaceId: string
	/** Telnyx Storage bucket the assistant retrieves from. */
	bucketName: string
	storageEndpoint: string
	/** Telnyx Storage takes the API key as both the access key and the secret key. */
	apiKey: string
}

/**
 * Null (exporter off) unless the workspace, bucket and API key are all set. Exporting every
 * workspace's knowledge into one assistant would leak across workspaces, so the workspace is
 * explicit.
 */
export function readKnowledgeExporterConfig(
	env: NodeJS.ProcessEnv = process.env,
): KnowledgeExporterConfig | null {
	const str = (v: string | undefined) => (v && v.trim() !== '' ? v.trim() : null)
	const workspaceId = str(env.TELNYX_KB_WORKSPACE_ID)
	const bucketName = str(env.TELNYX_KB_BUCKET)
	const apiKey = str(env.TELNYX_API_KEY)
	if (!workspaceId || !bucketName || !apiKey) return null
	return {
		workspaceId,
		bucketName,
		apiKey,
		storageEndpoint:
			str(env.TELNYX_STORAGE_ENDPOINT) ?? 'https://us-central-1.telnyxcloudstorage.com',
	}
}

export interface KnowledgeRow {
	id: string
	title: string | null
	content: string | null
	metadata: Record<string, unknown> | null
}

export function bucketKey(id: string): string {
	return `${KEY_PREFIX}${id}.md`
}

export function renderKnowledgeMarkdown(row: KnowledgeRow): string {
	const summary = typeof row.metadata?.summary === 'string' ? row.metadata.summary.trim() : ''
	const parts = [`# ${row.title?.trim() || 'Untitled'}`]
	if (summary) parts.push(summary)
	if (row.content?.trim()) parts.push(row.content.trim())
	return `${parts.join('\n\n')}\n`
}

const WORD_START = '(?<![\\p{L}\\p{N}_])'
const WORD_END = '(?![\\p{L}\\p{N}_])'
const DANISH_FIRST_PERSON = new RegExp(
	`${WORD_START}(?:jeg|mig|min|mit|mine|vi|os|vores|vor|vort|vore)${WORD_END}`,
	'iu',
)
const ENGLISH_FIRST_PERSON = new RegExp(`${WORD_START}(?:we|our|us)${WORD_END}`, 'iu')
const CAPITAL_I = new RegExp(`${WORD_START}I${WORD_END}`, 'u')
/** A number followed by min is minutes, not the Danish word min (my). */
const MINUTES = new RegExp(`\\d+\\s*min${WORD_END}`, 'giu')
const DANISH_MARKERS = new Set(
	'og ikke er det til af med som har kan vil en et på om der den de for'.split(' '),
)

function looksDanish(prose: string): boolean {
	if (/[æøå]/i.test(prose)) return true
	const seen = new Set<string>()
	for (const word of prose.toLowerCase().match(/[\p{L}]+/gu) ?? []) {
		if (DANISH_MARKERS.has(word)) seen.add(word)
	}
	return seen.size >= 3
}

/**
 * First-person prose in the knowledge base pushes the agent toward speaking as a human, which
 * conflicts with the AI disclosure (tech spec 2b.6). Danish and English are both checked. A capital
 * I is only tested when the page does not look Danish, since Danish I means you (plural). Code
 * blocks and inline code are skipped.
 */
export function proseHasFirstPerson(markdown: string): boolean {
	const prose = markdown
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`[^`]*`/g, ' ')
		.replace(MINUTES, ' ')
	if (DANISH_FIRST_PERSON.test(prose) || ENGLISH_FIRST_PERSON.test(prose)) return true
	return !looksDanish(prose) && CAPITAL_I.test(prose)
}

export interface ExportResult {
	uploaded: string[]
	removed: string[]
	/** customer_facing objects whose prose reads in the first person. Left out of the bucket until reworded. */
	skipped: Array<{ id: string; title: string | null }>
	retrievalToolId: string
}

export type KnowledgeBucket = Pick<StorageProvider, 'put' | 'list' | 'delete' | 'ensureBucket'>

/**
 * Uploads exactly the validated, customer_facing = true knowledge objects of the workspace that do
 * not read in the first person, drops the files of ones that stopped qualifying (including ones
 * edited into first person), and makes sure the assistant has a retrieval tool over the bucket.
 * Telnyx re-embeds changed files on its own once the bucket has been embedded, so embedding is
 * only requested the first time.
 */
export async function exportKnowledge(
	db: Database,
	deps: { config: KnowledgeExporterConfig; bucket: KnowledgeBucket; telnyx: TelnyxClient },
): Promise<ExportResult> {
	const { config, bucket, telnyx } = deps
	const rows = await db
		.select({
			id: objects.id,
			title: objects.title,
			content: objects.content,
			metadata: objects.metadata,
		})
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, config.workspaceId),
				eq(objects.type, 'knowledge'),
				eq(objects.status, 'validated'),
				sql`${objects.metadata}->>'customer_facing' = 'true'`,
			),
		)

	await bucket.ensureBucket()
	const existing = await bucket.list(KEY_PREFIX)

	const skipped: ExportResult['skipped'] = []
	const wanted = new Set<string>()
	const uploaded: string[] = []
	for (const row of rows) {
		const markdown = renderKnowledgeMarkdown(row as KnowledgeRow)
		if (proseHasFirstPerson(markdown)) {
			skipped.push({ id: row.id, title: row.title })
			logger.warn('customer_facing knowledge skipped: reads in the first person', {
				objectId: row.id,
				title: row.title,
			})
			continue
		}
		const key = bucketKey(row.id)
		wanted.add(key)
		await bucket.put(key, Buffer.from(markdown, 'utf8'))
		uploaded.push(key)
	}

	const removed: string[] = []
	for (const key of existing) {
		if (key.startsWith(KEY_PREFIX) && !wanted.has(key)) {
			await bucket.delete(key)
			removed.push(key)
		}
	}

	if (existing.length === 0 && uploaded.length > 0) await telnyx.embedBucket(config.bucketName)
	const retrievalToolId = await telnyx.ensureRetrievalTool(
		KB_RETRIEVAL_TOOL_NAME,
		config.bucketName,
	)
	return { uploaded, removed, skipped, retrievalToolId }
}
