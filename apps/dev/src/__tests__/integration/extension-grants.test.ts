import { randomUUID } from 'node:crypto'
import { events, blockedToolCalls, extensions, workspaceMembers } from '@maskin/db/schema'
import type { ToolGrants } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { buildGuardPolicy } from '../../lib/integrations/mcp-guard'
import extensionsRoutes from '../../routes/extensions'
import { applyExtensionGuards } from '../../services/extension-guard-launch'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// Tool grants API against real Postgres (tech spec section 5): an agent with no
// entry is denied everything, granting writes each tool's kind default, explicit
// entries override either default, and built-in integrations are never touched.

const TOOLS: { name: string; kind: 'read' | 'write' }[] = [
	{ name: 'get_transcript', kind: 'read' },
	{ name: 'list_transcripts', kind: 'read' },
	{ name: 'bookmark_meeting', kind: 'write' },
]

function buildApp(role: string | undefined = 'owner') {
	const inner = createIntegrationApp({ path: '/api/extensions', module: extensionsRoutes })
	// authMiddleware puts the caller's role on the context; the shared harness does not.
	const app = new Hono<{ Variables: { workspaceRole?: string } }>()
	app.use('*', async (c, next) => {
		if (role) c.set('workspaceRole', role)
		await next()
	})
	app.route('/', inner)
	return app
}

type GrantsJson = { toolGrants: ToolGrants; tools: { name: string; kind: string }[] }

describe('extension tool grants (integration)', () => {
	let workspaceId: string
	let extensionId: string
	let agentId: string
	const headers = () => ({ 'x-workspace-id': workspaceId })

	async function seedAgent(type = 'agent', member = true) {
		const actor = await insertActor(db, { type })
		if (member) {
			await db.insert(workspaceMembers).values({ workspaceId, actorId: actor.id, role: 'member' })
		}
		return actor.id
	}

	beforeEach(async () => {
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
		const [ext] = await db
			.insert(extensions)
			.values({
				workspaceId,
				slug: 'fireflies',
				name: 'Fireflies',
				status: 'active',
				mcpConfig: {
					envKey: 'FIREFLIES_TOKEN',
					server: { type: 'stdio', command: 'npx', args: ['mcp-remote', 'https://v.example'] },
					autoInject: true,
					credentialProvider: 'extension:fireflies',
					tools: TOOLS,
				},
			})
			.returning()
		extensionId = ext?.id ?? ''
		agentId = await seedAgent()
	})

	const put = (app: ReturnType<typeof buildApp>, path: string, body: unknown) =>
		app.request(jsonRequest('PUT', `/api/extensions/${extensionId}${path}`, body, headers()))

	const readGrants = async (app: ReturnType<typeof buildApp>) => {
		const res = await app.request(jsonGet(`/api/extensions/${extensionId}/grants`, headers()))
		expect(res.status).toBe(200)
		return (await res.json()) as GrantsJson
	}

	it('starts default-deny: no entry for the agent and an empty launch policy', async () => {
		const app = buildApp()
		const grants = await readGrants(app)
		expect(grants.toolGrants).toEqual({})
		expect(grants.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name))
		expect(buildGuardPolicy(grants.toolGrants, agentId)).toEqual({ allow: [], deny: [] })
	})

	it('granting applies defaults from each tool kind: read allow, write deny', async () => {
		const app = buildApp()
		const res = await put(app, `/grants/${agentId}`, {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as GrantsJson
		expect(body.toolGrants[agentId]).toEqual({
			get_transcript: 'allow',
			list_transcripts: 'allow',
			bookmark_meeting: 'deny',
		})
		expect(buildGuardPolicy(body.toolGrants, agentId)).toEqual({
			allow: ['get_transcript', 'list_transcripts'],
			deny: ['bookmark_meeting'],
		})
	})

	it('explicit entries override either default', async () => {
		const app = buildApp()
		const res = await put(app, `/grants/${agentId}`, {
			tools: { bookmark_meeting: 'allow', list_transcripts: 'deny' },
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as GrantsJson
		expect(body.toolGrants[agentId]).toEqual({
			get_transcript: 'allow',
			list_transcripts: 'deny',
			bookmark_meeting: 'allow',
		})
	})

	it('flips one tool without touching the others, and stores the plain string form', async () => {
		const app = buildApp()
		await put(app, `/grants/${agentId}`, {})
		const res = await put(app, `/grants/${agentId}/tools/bookmark_meeting`, { effect: 'allow' })
		expect(res.status).toBe(200)
		const [row] = await db.select().from(extensions).where(eq(extensions.id, extensionId))
		expect(row?.toolGrants[agentId]).toEqual({
			get_transcript: 'allow',
			list_transcripts: 'allow',
			bookmark_meeting: 'allow',
		})
	})

	it('flipping a tool for an agent with no entry creates an entry holding only that tool', async () => {
		const app = buildApp()
		const res = await put(app, `/grants/${agentId}/tools/get_transcript`, { effect: 'allow' })
		expect(res.status).toBe(200)
		const body = (await res.json()) as GrantsJson
		expect(body.toolGrants[agentId]).toEqual({ get_transcript: 'allow' })
	})

	it('removing an agent returns it to deny-everything and leaves other agents alone', async () => {
		const app = buildApp()
		const other = await seedAgent()
		await put(app, `/grants/${agentId}`, {})
		await put(app, `/grants/${other}`, {})
		const res = await app.request(
			jsonRequest(
				'DELETE',
				`/api/extensions/${extensionId}/grants/${agentId}`,
				undefined,
				headers(),
			),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as GrantsJson
		expect(Object.keys(body.toolGrants)).toEqual([other])
		expect(buildGuardPolicy(body.toolGrants, agentId)).toEqual({ allow: [], deny: [] })
	})

	it('refuses a tool the extension does not declare', async () => {
		const app = buildApp()
		expect((await put(app, `/grants/${agentId}`, { tools: { nope: 'allow' } })).status).toBe(400)
		expect((await put(app, `/grants/${agentId}/tools/nope`, { effect: 'allow' })).status).toBe(400)
		expect((await readGrants(app)).toolGrants).toEqual({})
	})

	it('refuses an actor that is not an agent in this workspace', async () => {
		const app = buildApp()
		const human = await seedAgent('human')
		const outsider = await seedAgent('agent', false)
		expect((await put(app, `/grants/${human}`, {})).status).toBe(400)
		expect((await put(app, `/grants/${outsider}`, {})).status).toBe(400)
		expect((await put(app, `/grants/${randomUUID()}`, {})).status).toBe(400)
		expect((await readGrants(app)).toolGrants).toEqual({})
	})

	it('refuses to grant on an extension that declares no tools', async () => {
		const app = buildApp()
		const [bare] = await db
			.insert(extensions)
			.values({ workspaceId, slug: 'webhook-only', name: 'Webhook only', status: 'active' })
			.returning()
		const res = await app.request(
			jsonRequest('PUT', `/api/extensions/${bare?.id}/grants/${agentId}`, {}, headers()),
		)
		expect(res.status).toBe(400)
	})

	it('lets only an owner or admin change grants, but any member read them', async () => {
		const member = buildApp('member')
		expect((await put(member, `/grants/${agentId}`, {})).status).toBe(403)
		expect(
			(
				await member.request(
					jsonRequest(
						'DELETE',
						`/api/extensions/${extensionId}/grants/${agentId}`,
						undefined,
						headers(),
					),
				)
			).status,
		).toBe(403)
		expect((await readGrants(member)).toolGrants).toEqual({})
		expect((await put(buildApp('admin'), `/grants/${agentId}`, {})).status).toBe(200)
	})

	it('404s for an extension in another workspace, so nothing outside the custom table is reachable', async () => {
		const app = buildApp()
		const otherWorkspace = (await insertWorkspace(db, getTestActorId())).id
		const res = await app.request(
			jsonGet(`/api/extensions/${extensionId}/grants`, { 'x-workspace-id': otherWorkspace }),
		)
		expect(res.status).toBe(404)
		expect(
			(await app.request(jsonGet(`/api/extensions/${randomUUID()}/grants`, headers()))).status,
		).toBe(404)
	})

	it('leaves built-in integration servers untouched at launch, whatever the grants say', async () => {
		const app = buildApp()
		await put(app, `/grants/${agentId}`, {})
		const session = await insertSession(db, workspaceId, agentId, getTestActorId())
		const slack = { type: 'stdio', command: 'npx', args: ['slack-mcp'] }
		const servers: Record<string, unknown> = {
			'integration-slack': { ...slack },
			'extension-fireflies': {
				type: 'stdio',
				command: 'npx',
				args: ['mcp-remote', 'https://v.example'],
			},
		}
		await applyExtensionGuards({
			db,
			sessionId: session.id,
			workspaceId,
			agentId,
			apiUrl: 'http://localhost:3000',
			servers,
		})
		expect(servers['integration-slack']).toEqual(slack)
		expect((servers['extension-fireflies'] as { command: string }).command).not.toBe('npx')
	})

	it('records an event for every grant change', async () => {
		const app = buildApp()
		await put(app, `/grants/${agentId}`, {})
		const rows = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.entityId, extensionId)))
		expect(rows).toHaveLength(1)
		expect(rows[0]?.data).toMatchObject({ fields: ['tool_grants'], agent_id: agentId })
	})

	describe('attempted tools', () => {
		const attempted = async (app: ReturnType<typeof buildApp>) => {
			const res = await app.request(jsonGet(`/api/extensions/${extensionId}/attempted`, headers()))
			expect(res.status).toBe(200)
			return (await res.json()) as {
				windowDays: number
				agents: { agentId: string; tools: string[]; lastAttemptedAt: string }[]
			}
		}

		it('is empty before any refusal', async () => {
			expect((await attempted(buildApp())).agents).toEqual([])
		})

		it('returns the distinct refused tool names per agent from the last 30 days only', async () => {
			const app = buildApp()
			const other = await seedAgent()
			const day = 24 * 60 * 60 * 1000
			const row = (agent: string, tool: string, ageMs: number, ext = extensionId) => ({
				workspaceId,
				extensionId: ext,
				agentId: agent,
				toolName: tool,
				blockedAt: new Date(Date.now() - ageMs),
			})
			const [sibling] = await db
				.insert(extensions)
				.values({ workspaceId, slug: 'cal-com', name: 'Cal.com', status: 'active' })
				.returning()
			await db
				.insert(blockedToolCalls)
				.values([
					row(agentId, 'bookmark_meeting', 60_000),
					row(agentId, 'bookmark_meeting', 120_000),
					row(agentId, 'get_transcript', 3 * day),
					row(agentId, 'ancient_tool', 31 * day),
					row(other, 'list_transcripts', 5 * day),
					row(agentId, 'other_extension_tool', 60_000, sibling?.id),
				])
			const body = await attempted(app)
			expect(body.windowDays).toBe(30)
			const byAgent = Object.fromEntries(body.agents.map((a) => [a.agentId, a.tools]))
			expect(byAgent[agentId]).toEqual(['bookmark_meeting', 'get_transcript'])
			expect(byAgent[other]).toEqual(['list_transcripts'])
			expect(body.agents).toHaveLength(2)
			const latest = body.agents.find((a) => a.agentId === agentId)?.lastAttemptedAt ?? ''
			expect(Date.now() - new Date(latest).getTime()).toBeLessThan(5 * 60_000)
		})
	})
})
