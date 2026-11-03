// list_objects paging contract, end to end: the real MCP tool talking to the
// real /api/objects route over HTTP, backed by Postgres. Bulk imports stamp
// every row with one microsecond-precision created_at; the cursor must still
// return each row exactly once, totalCount must be the real total, and
// hasMore must agree with next_cursor.

import { serve } from '@hono/node-server'
import { createMcpServer } from '@maskin/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { sql } from 'drizzle-orm'
import { insertObject, insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')

interface ListObjectsResult {
	structuredContent: {
		heroCard: { totalCount?: number; page?: { hasMore: boolean } }
		objects: Array<{ id: string }>
		page: { limit: number; returned: number }
		next_cursor?: string
	}
}

describe('list_objects pagination through the MCP tool', () => {
	const TIED_ROWS = 250
	let workspaceId: string
	let client: Client
	let closeApi: () => void

	// The shared setup truncates every table before each test, so rows are seeded
	// per test; the API server and MCP client are built once.
	beforeEach(async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		for (let i = 0; i < TIED_ROWS; i++) {
			await insertObject(db, workspaceId, actorId, {
				type: 'task',
				status: 'todo',
				title: `Tied ${i}`,
			})
		}
		await db.execute(
			sql`UPDATE objects SET created_at = '2026-01-01T00:00:00.123456Z', updated_at = '2026-01-01T00:00:00.123456Z' WHERE workspace_id = ${workspaceId}`,
		)
	}, 60_000)

	beforeAll(async () => {
		const app = createIntegrationApp({ path: '/api/objects', module: objectsRoutes as never })
		const server = serve({ fetch: app.fetch, port: 0 })
		await new Promise((resolve) => server.once('listening', resolve))
		closeApi = () => server.close()
		const { port } = server.address() as { port: number }

		const mcp = createMcpServer({
			apiBaseUrl: `http://localhost:${port}`,
			apiKey: 'test-key',
			defaultWorkspaceId: '00000000-0000-0000-0000-000000000000',
			telemetrySink: () => {},
		})
		const [serverSide, clientSide] = InMemoryTransport.createLinkedPair()
		client = new Client({ name: 'list-objects-pagination-test', version: '1.0.0' })
		await Promise.all([mcp.connect(serverSide), client.connect(clientSide)])
	}, 120_000)

	afterAll(() => closeApi?.())

	it.each([100, 7])(
		'walks every row exactly once at limit %i',
		async (limit) => {
			const walked: string[] = []
			let cursor: string | undefined
			for (let hop = 0; hop < 100; hop++) {
				const res = (await client.callTool({
					name: 'list_objects',
					arguments: {
						workspace_id: workspaceId,
						type: 'task',
						limit,
						...(cursor ? { cursor } : {}),
					},
				})) as unknown as ListObjectsResult
				const { heroCard, objects, page, next_cursor } = res.structuredContent

				expect(heroCard.totalCount).toBe(TIED_ROWS)
				expect(page.limit).toBe(limit)
				// The count reports rows shipped, and every counted row has a record.
				expect(page.returned).toBe(objects.length)
				expect(objects.length).toBeGreaterThan(0)
				// hasMore and next_cursor agree.
				expect(heroCard.page?.hasMore).toBe(Boolean(next_cursor))

				walked.push(...objects.map((o) => o.id))
				if (!next_cursor) break
				cursor = next_cursor
			}
			expect(walked).toHaveLength(TIED_ROWS)
			expect(new Set(walked).size).toBe(TIED_ROWS)
		},
		60_000,
	)
})
