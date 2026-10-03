import { describe, expect, it, vi } from 'vitest'
import {
	KB_RETRIEVAL_TOOL_NAME,
	type KnowledgeBucket,
	type KnowledgeExporterConfig,
	bucketKey,
	exportKnowledge,
	proseHasFirstPerson,
	readKnowledgeExporterConfig,
	renderKnowledgeMarkdown,
} from '../../lib/integrations/providers/telnyx/knowledge-exporter'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

function fakeBucket(initial: Record<string, string> = {}) {
	const files = new Map(Object.entries(initial))
	const bucket: KnowledgeBucket = {
		ensureBucket: async () => {},
		put: async (key, data) => {
			files.set(key, Buffer.from(data as Buffer).toString('utf8'))
		},
		list: async (prefix) => [...files.keys()].filter((k) => k.startsWith(prefix)),
		delete: async (key) => {
			files.delete(key)
		},
	}
	return { files, bucket }
}

function fakeTelnyx() {
	return {
		embedBucket: vi.fn(async () => {}),
		ensureRetrievalTool: vi.fn(async () => 'tool-1'),
	} as never
}

function config(workspaceId: string): KnowledgeExporterConfig {
	return { workspaceId, bucketName: 'kb-bucket', storageEndpoint: 'https://s.test', apiKey: 'k' }
}

describe('knowledge exporter', () => {
	it('uploads only customer_facing = true objects of the configured workspace as markdown', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const other = await insertWorkspace(db, getTestActorId())
		const actor = getTestActorId()
		const yes = await insertObject(db, ws.id, actor, {
			type: 'knowledge',
			title: 'How meetings work',
			content: 'The meeting is 30 minutes on Google Meet.',
			metadata: { customer_facing: true, summary: 'Meeting flow' },
		})
		await insertObject(db, ws.id, actor, {
			type: 'knowledge',
			title: 'Internal roadmap',
			content: 'Secret',
			metadata: { customer_facing: false },
		})
		await insertObject(db, ws.id, actor, { type: 'knowledge', title: 'No flag', metadata: {} })
		await insertObject(db, other.id, actor, {
			type: 'knowledge',
			title: 'Other workspace',
			metadata: { customer_facing: true },
		})
		await insertObject(db, ws.id, actor, {
			type: 'note',
			title: 'Wrong type',
			metadata: { customer_facing: true },
		})

		const { files, bucket } = fakeBucket()
		const telnyx = fakeTelnyx()
		const result = await exportKnowledge(db, { config: config(ws.id), bucket, telnyx })

		expect([...files.keys()]).toEqual([bucketKey(yes.id)])
		expect(files.get(bucketKey(yes.id))).toBe(
			'# How meetings work\n\nMeeting flow\n\nThe meeting is 30 minutes on Google Meet.\n',
		)
		expect(result.retrievalToolId).toBe('tool-1')
		expect(telnyx.ensureRetrievalTool).toHaveBeenCalledWith(KB_RETRIEVAL_TOOL_NAME, 'kb-bucket')
		// First export of an empty bucket asks Telnyx to embed it.
		expect(telnyx.embedBucket).toHaveBeenCalledWith('kb-bucket')
	})

	it('drops the file of an object that stopped being customer facing, and does not re-embed', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const kept = await insertObject(db, ws.id, getTestActorId(), {
			type: 'knowledge',
			title: 'Kept',
			metadata: { customer_facing: true },
		})
		const { files, bucket } = fakeBucket({
			[bucketKey('00000000-0000-0000-0000-000000000000')]: 'stale',
			'unrelated.txt': 'not ours',
		})
		const telnyx = fakeTelnyx()
		const result = await exportKnowledge(db, { config: config(ws.id), bucket, telnyx })
		expect([...files.keys()].sort()).toEqual([bucketKey(kept.id), 'unrelated.txt'].sort())
		expect(result.removed).toEqual([bucketKey('00000000-0000-0000-0000-000000000000')])
		expect(telnyx.embedBucket).not.toHaveBeenCalled()
	})

	it('warns on first-person prose but still exports it', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const row = await insertObject(db, ws.id, getTestActorId(), {
			type: 'knowledge',
			title: 'Founder voice',
			content: 'We built this because I was frustrated.',
			metadata: { customer_facing: true },
		})
		const { files, bucket } = fakeBucket()
		const result = await exportKnowledge(db, {
			config: config(ws.id),
			bucket,
			telnyx: fakeTelnyx(),
		})
		expect(result.warnings).toEqual([{ id: row.id, title: 'Founder voice' }])
		expect(files.has(bucketKey(row.id))).toBe(true)
	})
})

describe('knowledge exporter helpers', () => {
	it('lints first person in prose only, not in code', () => {
		expect(proseHasFirstPerson('Our meeting is short.')).toBe(true)
		expect(proseHasFirstPerson('Join us on Meet.')).toBe(true)
		expect(proseHasFirstPerson('The product books meetings.')).toBe(false)
		expect(proseHasFirstPerson('Use `we` carefully:\n```\nI we our us\n```')).toBe(false)
	})

	it('renders title, summary and body', () => {
		expect(renderKnowledgeMarkdown({ id: '1', title: 'T', content: null, metadata: null })).toBe(
			'# T\n',
		)
	})

	it('is off unless workspace, bucket and API key are all set', () => {
		const full = { TELNYX_KB_WORKSPACE_ID: 'w', TELNYX_KB_BUCKET: 'b', TELNYX_API_KEY: 'k' }
		expect(readKnowledgeExporterConfig(full)).toMatchObject({
			workspaceId: 'w',
			bucketName: 'b',
			storageEndpoint: 'https://us-central-1.telnyxcloudstorage.com',
		})
		for (const missing of Object.keys(full)) {
			const partial = { ...full, [missing]: '' }
			expect(readKnowledgeExporterConfig(partial)).toBeNull()
		}
	})
})

describe('knowledge exporter job: flip to customer_facing reaches the bucket', () => {
	it('a PATCH that flips customer_facing fires a pass through NOTIFY and the bucket receives the markdown', async () => {
		const { createIntegrationApp } = await import('./global-setup')
		const { jsonRequest } = await import('../helpers')
		const { PgNotifyBridge } = await import('@maskin/realtime')
		const { TelnyxKnowledgeExporterJob } = await import('../../jobs/telnyx-knowledge-exporter')
		const { default: objectsRoutes } = await import('../../routes/objects')

		const ws = await insertWorkspace(db, getTestActorId(), {
			settings: {
				enabled_modules: ['work', 'knowledge'],
				statuses: { knowledge: ['draft', 'validated', 'deprecated'] },
				field_definitions: {
					knowledge: [
						{ name: 'summary', type: 'text' },
						{ name: 'customer_facing', type: 'boolean' },
					],
				},
			},
		})
		const doc = await insertObject(db, ws.id, getTestActorId(), {
			type: 'knowledge',
			title: 'How meetings work',
			content: 'A meeting is 30 minutes.',
			metadata: { summary: 'Meetings' },
		})

		const saved = { ...process.env }
		process.env.TELNYX_KB_WORKSPACE_ID = ws.id
		process.env.TELNYX_KB_BUCKET = 'kb-bucket'
		process.env.TELNYX_API_KEY = 'k'
		const { files, bucket } = fakeBucket()
		const bridge = new PgNotifyBridge(process.env.DATABASE_URL as string)
		await bridge.start()
		const job = new TelnyxKnowledgeExporterJob(
			db,
			bridge,
			() => exportKnowledge(db, { config: config(ws.id), bucket, telnyx: fakeTelnyx() }),
			200,
		)
		try {
			job.start()
			// The start pass finds nothing customer facing.
			await vi.waitFor(() => expect(files.size).toBe(0))

			const app = createIntegrationApp({ path: '/api/objects', module: objectsRoutes })
			const res = await app.request(
				jsonRequest(
					'PATCH',
					`/api/objects/${doc.id}`,
					{ metadata: { summary: 'Meetings', customer_facing: true } },
					{ 'x-workspace-id': ws.id },
				),
			)
			expect(res.status).toBe(200)

			// Well inside the 60 second bar: debounce is 200ms here, 5s in production.
			await vi.waitFor(() => expect([...files.keys()]).toEqual([bucketKey(doc.id)]), {
				timeout: 20_000,
				interval: 250,
			})
			expect(files.get(bucketKey(doc.id))).toBe(
				'# How meetings work\n\nMeetings\n\nA meeting is 30 minutes.\n',
			)
		} finally {
			job.stop()
			await bridge.stop()
			process.env = saved
		}
	})
})
