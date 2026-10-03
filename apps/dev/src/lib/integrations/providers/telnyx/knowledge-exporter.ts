import type { Database } from '@maskin/db'
import { INTEGRATION_STATUS_ACTIVE, integrations, objects } from '@maskin/db/schema'
import { and, asc, eq, sql } from 'drizzle-orm'
import { logger } from '../../../logger'
import { syncAssistant } from './assistant'
import { type KnowledgeDocument, type TelnyxClient, createTelnyxClient } from './client'
import { readTelnyxRuntimeConfig } from './config'

/**
 * Exports the workspace's customer_facing knowledge to a Telnyx knowledge bucket and attaches
 * it to the voice assistant as a retrieval tool (tech spec section 2b.6 layer 2). Only objects
 * with metadata.customer_facing = true leave the workspace. Flipping the flag is a review step
 * (Knowledge Curator's surface), not a self-service toggle.
 */

export function bucketNameFor(workspaceId: string): string {
	return `maskin-kb-${workspaceId}`
}

/** First-person prose in the KB would push the bot toward speaking as a founder (AI Act section 50). */
const FIRST_PERSON = /\b(I|we|our|us)\b/i

export function firstPersonWarning(markdown: string): boolean {
	// Fenced code and inline code are not spoken prose.
	const prose = markdown.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
	return FIRST_PERSON.test(prose)
}

export interface KnowledgeRow {
	id: string
	title: string | null
	content: string | null
}

export function toDocument(row: KnowledgeRow): KnowledgeDocument {
	const title = (row.title ?? '').trim() || 'Untitled'
	const body = (row.content ?? '').trim()
	return { name: `${row.id}.md`, markdown: body ? `# ${title}\n\n${body}\n` : `# ${title}\n` }
}

/** The workspace's customer_facing knowledge as markdown documents, linted. */
export async function loadCustomerFacingKnowledge(
	db: Database,
	workspaceId: string,
): Promise<KnowledgeDocument[]> {
	const rows = await db
		.select({ id: objects.id, title: objects.title, content: objects.content })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				eq(objects.type, 'knowledge'),
				sql`${objects.metadata}->>'customer_facing' = 'true'`,
			),
		)
		.orderBy(asc(objects.id))
	return rows.map((row) => {
		const doc = toDocument(row)
		if (firstPersonWarning(doc.markdown)) {
			logger.warn('customer_facing knowledge contains first-person prose', {
				workspaceId,
				objectId: row.id,
				title: row.title,
			})
		}
		return doc
	})
}

export interface KnowledgeExportDeps {
	client: TelnyxClient
	assistantId: string | null
	webhookUrl: string
}

export interface KnowledgeExportResult {
	workspaces: number
	documents: number
	toolIds: string[]
	assistant: 'created' | 'updated' | 'unchanged'
}

/** Workspaces with an active telnyx integration: the only ones whose knowledge may be exported. */
async function telnyxWorkspaceIds(db: Database): Promise<string[]> {
	const rows = await db
		.selectDistinct({ workspaceId: integrations.workspaceId })
		.from(integrations)
		.where(
			and(eq(integrations.provider, 'telnyx'), eq(integrations.status, INTEGRATION_STATUS_ACTIVE)),
		)
	return rows.map((r) => r.workspaceId)
}

/**
 * One pass: for each telnyx workspace upload its customer_facing knowledge and collect the
 * retrieval tool, then make the assistant carry exactly those tools. Safe to run any number
 * of times: the bucket is replaced and the assistant is only patched when something differs.
 */
export async function runKnowledgeExport(
	db: Database,
	deps: KnowledgeExportDeps,
): Promise<KnowledgeExportResult> {
	const workspaceIds = await telnyxWorkspaceIds(db)
	const toolIds: string[] = []
	let documents = 0
	for (const workspaceId of workspaceIds) {
		const docs = await loadCustomerFacingKnowledge(db, workspaceId)
		// No customer_facing knowledge means no bucket and no retrieval tool for this workspace.
		if (docs.length === 0) continue
		const { retrievalToolId } = await deps.client.syncKnowledgeBucket(
			bucketNameFor(workspaceId),
			docs,
		)
		toolIds.push(retrievalToolId)
		documents += docs.length
	}
	const synced = await syncAssistant(deps.client, {
		assistantId: deps.assistantId,
		webhookUrl: deps.webhookUrl,
		toolIds,
	})
	return { workspaces: workspaceIds.length, documents, toolIds, assistant: synced.action }
}

/** Real client and webhook URL from env, or null when Telnyx is not configured. */
export function defaultKnowledgeExportDeps(): KnowledgeExportDeps | null {
	const { apiKey, apiBaseUrl, assistantId } = readTelnyxRuntimeConfig()
	if (!apiKey) return null
	const base = (process.env.MASKIN_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '')
	return {
		client: createTelnyxClient({ apiKey, baseUrl: apiBaseUrl }),
		assistantId,
		webhookUrl: `${base}/api/integrations/telnyx/webhook`,
	}
}
