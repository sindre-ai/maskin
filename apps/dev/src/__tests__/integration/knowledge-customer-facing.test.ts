import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { integrations, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { TelnyxKnowledgeExporterJob } from '../../jobs/telnyx-knowledge-exporter'
import { SCRIPT_VERSION } from '../../lib/integrations/providers/telnyx/assistant'
import type { TelnyxClient } from '../../lib/integrations/providers/telnyx/client'
import {
	bucketNameFor,
	loadCustomerFacingKnowledge,
	runKnowledgeExport,
} from '../../lib/integrations/providers/telnyx/knowledge-exporter'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

const MIGRATION = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		'../../../../../packages/db/drizzle/0089_knowledge_customer_facing_field.sql',
	),
	'utf8',
)

async function knowledgeFields(workspaceId: string): Promise<unknown> {
	const [row] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
	return (row?.settings as { field_definitions?: { knowledge?: unknown } } | null)
		?.field_definitions?.knowledge
}

describe('knowledge customer_facing settings migration (0089)', () => {
	const ORIGINAL = [
		{ name: 'doc_type', type: 'enum', values: ['note'] },
		{ name: 'summary', type: 'text', required: true },
	]

	it('appends customer_facing once, keeps order, and a second run changes nothing', async () => {
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: { field_definitions: { knowledge: ORIGINAL } },
		})
		await sql.unsafe(MIGRATION)
		const once = await knowledgeFields(ws.id)
		expect(once).toEqual([...ORIGINAL, { name: 'customer_facing', type: 'boolean' }])
		await sql.unsafe(MIGRATION)
		expect(await knowledgeFields(ws.id)).toEqual(once)
	})

	it('skips a workspace whose list already holds customer_facing, whatever its type', async () => {
		const stored = [...ORIGINAL, { name: 'customer_facing', type: 'text' }]
		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: { field_definitions: { knowledge: stored } },
		})
		await sql.unsafe(MIGRATION)
		expect(await knowledgeFields(ws.id)).toEqual(stored)
	})

	it('leaves workspaces with no stored knowledge field list, or other types only, untouched', async () => {
		const none = await insertWorkspace(db, getTestActorId(), { settings: {} })
		const otherOnly = await insertWorkspace(db, getTestActorId(), {
			settings: { field_definitions: { bet: [{ name: 'archive_reason', type: 'text' }] } },
		})
		await sql.unsafe(MIGRATION)
		expect(await knowledgeFields(none.id)).toBeUndefined()
		expect(await knowledgeFields(otherOnly.id)).toBeUndefined()
		const [row] = await db
			.select({ settings: workspaces.settings })
			.from(workspaces)
			.where(eq(workspaces.id, otherOnly.id))
		expect(row?.settings).toEqual({
			field_definitions: { bet: [{ name: 'archive_reason', type: 'text' }] },
		})
	})
})

async function knowledgeWorkspace() {
	const ws = await insertWorkspace(db, getTestActorId())
	const add = (title: string, content: string, customerFacing?: boolean | string) =>
		insertObject(db, ws.id, getTestActorId(), {
			type: 'knowledge',
			status: 'validated',
			title,
			content,
			metadata: customerFacing === undefined ? {} : { customer_facing: customerFacing },
		})
	return { ws, add }
}

describe('customer_facing knowledge export', () => {
	it('loads only objects with customer_facing = true, as markdown', async () => {
		const { ws, add } = await knowledgeWorkspace()
		const yes = await add('Security', 'Data stays in the EU.', true)
		await add('Roadmap', 'Internal plans.', false)
		await add('Unflagged', 'No flag at all.')
		await add('String true', 'A string, not a boolean.', 'yes')
		await insertObject(db, ws.id, getTestActorId(), {
			type: 'task',
			title: 'A task',
			metadata: { customer_facing: true },
		})
		const other = await knowledgeWorkspace()
		await other.add('Other workspace', 'Not ours.', true)

		const docs = await loadCustomerFacingKnowledge(db, ws.id)
		expect(docs).toEqual([
			{ name: `${yes.id}.md`, markdown: '# Security\n\nData stays in the EU.\n' },
		])
	})

	function fakeClient() {
		const synced: Array<{ bucket: string; names: string[] }> = []
		let assistant = { id: 'asst-1', description: 'maskin-script:old', toolIds: [] as string[] }
		const client = {
			syncKnowledgeBucket: vi.fn(async (bucket: string, docs: Array<{ name: string }>) => {
				synced.push({ bucket, names: docs.map((d) => d.name) })
				return { retrievalToolId: `tool-for-${bucket}` }
			}),
			getAssistant: vi.fn(async () => assistant),
			createAssistant: vi.fn(),
			updateAssistant: vi.fn(async (_id: string, payload: Record<string, unknown>) => {
				assistant = {
					id: 'asst-1',
					description: payload.description as string,
					toolIds: payload.tool_ids as string[],
				}
				return assistant
			}),
		} as unknown as TelnyxClient
		return { client, synced }
	}

	async function connectTelnyx(workspaceId: string, status = 'active') {
		await db.insert(integrations).values({
			workspaceId,
			provider: 'telnyx',
			status: status as 'active',
			credentials: 'x',
			config: {},
		})
	}

	it('uploads one bucket per telnyx workspace and attaches the retrieval tool to the assistant', async () => {
		const { ws, add } = await knowledgeWorkspace()
		await connectTelnyx(ws.id)
		const doc = await add('Security', 'Data stays in the EU.', true)
		await add('Roadmap', 'Internal.', false)
		const { client, synced } = fakeClient()

		const result = await runKnowledgeExport(db, {
			client,
			assistantId: 'asst-1',
			webhookUrl: 'https://maskin.example/api/integrations/telnyx/webhook',
		})

		expect(synced.filter((s) => s.bucket === bucketNameFor(ws.id))).toEqual([
			{ bucket: bucketNameFor(ws.id), names: [`${doc.id}.md`] },
		])
		expect(result.toolIds).toContain(`tool-for-${bucketNameFor(ws.id)}`)
		expect(result.assistant).toBe('updated')
		const update = (client.updateAssistant as ReturnType<typeof vi.fn>).mock.calls[0]
		expect((update?.[1] as { tool_ids: string[] }).tool_ids).toContain(
			`tool-for-${bucketNameFor(ws.id)}`,
		)
		expect((update?.[1] as { description: string }).description).toBe(
			`maskin-script:${SCRIPT_VERSION}`,
		)
	})

	it('never exports a workspace that has no active telnyx integration', async () => {
		const { ws, add } = await knowledgeWorkspace()
		await add('Security', 'Data stays in the EU.', true)
		const revoked = await knowledgeWorkspace()
		await connectTelnyx(revoked.ws.id, 'revoked')
		await revoked.add('Revoked', 'No.', true)
		const { client, synced } = fakeClient()
		await runKnowledgeExport(db, { client, assistantId: 'asst-1', webhookUrl: 'https://x/y' })
		expect(synced.map((s) => s.bucket)).not.toContain(bucketNameFor(ws.id))
		expect(synced.map((s) => s.bucket)).not.toContain(bucketNameFor(revoked.ws.id))
	})

	it('creates no bucket and attaches no retrieval tool for a workspace with nothing flagged', async () => {
		const { ws, add } = await knowledgeWorkspace()
		await connectTelnyx(ws.id)
		await add('Roadmap', 'Internal.', false)
		const { client, synced } = fakeClient()
		await runKnowledgeExport(db, { client, assistantId: 'asst-1', webhookUrl: 'https://x/y' })
		expect(synced.map((s) => s.bucket)).not.toContain(bucketNameFor(ws.id))
	})
})

describe('TelnyxKnowledgeExporterJob', () => {
	function source() {
		const listeners: Array<(e: unknown) => void> = []
		return {
			on: (_: 'event', l: (e: never) => void) => {
				listeners.push(l as (e: unknown) => void)
			},
			emit: (e: Record<string, unknown>) => {
				for (const l of listeners) l(e)
			},
		}
	}

	async function until(check: () => boolean, ms = 3000) {
		const start = Date.now()
		while (!check()) {
			if (Date.now() - start > ms) throw new Error('timed out waiting')
			await new Promise((r) => setTimeout(r, 10))
		}
	}

	it('exports once, shortly after a knowledge object is updated, and not for other objects', async () => {
		const { ws, add } = await knowledgeWorkspace()
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: 'telnyx',
			status: 'active',
			credentials: 'x',
			config: {},
		})
		const doc = await add('Security', 'Data stays in the EU.', true)
		const task = await insertObject(db, ws.id, getTestActorId(), { type: 'task', title: 'noise' })

		const syncKnowledgeBucket = vi.fn(async () => ({ retrievalToolId: 'tool-1' }))
		const client = {
			syncKnowledgeBucket,
			getAssistant: vi.fn(async () => ({
				id: 'asst-1',
				description: `maskin-script:${SCRIPT_VERSION}`,
				toolIds: ['tool-1'],
			})),
		} as unknown as TelnyxClient
		const src = source()
		const job = new TelnyxKnowledgeExporterJob(
			db,
			src,
			() => ({ client, assistantId: 'asst-1', webhookUrl: 'https://x/y' }),
			20,
			'0 0 1 1 *',
		)
		job.start()
		try {
			const ev = (entity_id: string, action = 'updated') => ({
				workspace_id: ws.id,
				actor_id: getTestActorId(),
				action,
				entity_type: 'object',
				entity_id,
				event_id: '1',
			})
			src.emit(ev(task.id))
			src.emit(ev(doc.id, 'deleted'))
			await new Promise((r) => setTimeout(r, 150))
			expect(syncKnowledgeBucket).not.toHaveBeenCalled()

			// A burst of edits collapses into one export.
			src.emit(ev(doc.id))
			src.emit(ev(doc.id))
			src.emit(ev(doc.id))
			await until(() => syncKnowledgeBucket.mock.calls.length > 0)
			await new Promise((r) => setTimeout(r, 150))
			expect(syncKnowledgeBucket).toHaveBeenCalledTimes(1)
		} finally {
			job.stop()
		}
	})

	it('does nothing at all when Telnyx is not configured', async () => {
		const src = source()
		const resolve = vi.fn(() => null)
		const job = new TelnyxKnowledgeExporterJob(db, src, resolve, 10, '0 0 1 1 *')
		await job.tick()
		expect(resolve).toHaveBeenCalledOnce()
	})
})
