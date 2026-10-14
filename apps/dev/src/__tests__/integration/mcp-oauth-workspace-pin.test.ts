// A Claude connector token (mat_) resolves to the person who approved it and stays inside
// the one workspace on its grant. Real Postgres, the real app, a real listening server (the
// /mcp route needs a Node socket) and the in-process MCP server calling back into the API.
// No endpoint mints a token yet, so every grant and token row is inserted directly.

import { serve } from '@hono/node-server'
import {
	MCP_FORWARD_HEADER,
	evictMembership,
	evictOAuthTokens,
	getMcpForwardMarker,
	mintToken,
	runWithOAuthPin,
} from '@maskin/auth'
import {
	files,
	oauthGrants,
	oauthTokens,
	objects,
	workspaceMembers,
	workspaceSkills,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../app-factory'
import { getWorkspaceRole, isWorkspaceWriter } from '../../lib/workspace-auth'
import { __resetMcpActorCache, __resolveAgentActor } from '../../routes/mcp'
import {
	insertActor,
	insertConversation,
	insertNotification,
	insertObject,
	insertRelationship,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { db } from './global-setup'

const CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata'

let base: string
let closeServer: () => void
const priorPort = process.env.PORT

beforeAll(async () => {
	vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', 'true')
	const app = createApp(
		{
			db,
			notifyBridge: {} as never,
			sessionManager: { stopSession: async () => {}, createSession: async () => ({}) } as never,
			agentStorage: {} as never,
			storageProvider: {} as never,
		},
		{ includeExtensions: false },
	)
	const server = serve({ fetch: app.fetch, port: 0 })
	await new Promise((resolve) => server.once('listening', resolve))
	const { port } = server.address() as { port: number }
	// routes/mcp.ts points the in-process MCP server at http://localhost:$PORT.
	process.env.PORT = String(port)
	base = `http://localhost:${port}`
	closeServer = () => server.close()
}, 60_000)

afterAll(() => {
	closeServer?.()
	vi.unstubAllEnvs()
	if (priorPort === undefined) Reflect.deleteProperty(process.env, 'PORT')
	else process.env.PORT = priorPort
})

async function connect(actorId: string, workspaceId: string, clientId = CLIENT_ID) {
	const [grant] = await db
		.insert(oauthGrants)
		.values({
			actorId,
			workspaceId,
			clientId,
			clientName: 'Claude',
			resource: 'https://maskin.io/mcp',
		})
		.returning()
	const token = mintToken('mat_')
	await db.insert(oauthTokens).values({
		grantId: grant.id,
		kind: 'access',
		tokenHash: token.hash,
		expiresAt: new Date(Date.now() + 3_600_000),
	})
	return { grant, token: token.raw }
}

interface ApiOptions {
	token: string
	workspaceId?: string
	method?: string
	body?: unknown
	/** The /mcp forwarder adds the marker; a direct caller does not have it. */
	marker?: boolean
}

async function api(path: string, opts: ApiOptions) {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${opts.token}`,
	}
	if (opts.marker !== false) headers[MCP_FORWARD_HEADER] = getMcpForwardMarker()
	if (opts.workspaceId) headers['X-Workspace-Id'] = opts.workspaceId
	const res = await fetch(`${base}${path}`, {
		method: opts.method ?? 'GET',
		headers,
		...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
	})
	const text = await res.text()
	let body: unknown = text
	try {
		body = JSON.parse(text)
	} catch {}
	// biome-ignore lint/suspicious/noExplicitAny: parsed JSON, shape asserted per test
	return { status: res.status, body: body as any, text, headers: res.headers }
}

async function mcpToolCall(token: string, name: string, args: Record<string, unknown>) {
	const res = await fetch(`${base}/mcp`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name, arguments: args },
		}),
	})
	const raw = await res.text()
	const rpc = JSON.parse(raw) as {
		result?: { isError?: boolean; content?: Array<{ text?: string }> }
	}
	const text = rpc.result?.content?.[0]?.text ?? ''
	// biome-ignore lint/suspicious/noExplicitAny: parsed JSON, shape asserted per test
	let payload: any = null
	try {
		payload = JSON.parse(text)
	} catch {}
	return { status: res.status, isError: rpc.result?.isError === true, text, raw, payload }
}

/** One human in two workspaces, a task in each, and a Claude token pinned to workspace A. */
async function seedTwoWorkspaces() {
	const person = await insertActor(db)
	const wsA = await insertWorkspace(db, person.id)
	const wsB = await insertWorkspace(db, person.id)
	const objA = await insertObject(db, wsA.id, person.id, {
		type: 'task',
		title: 'Task in A',
		status: 'todo',
	})
	const objB = await insertObject(db, wsB.id, person.id, {
		type: 'task',
		title: 'Task in B',
		status: 'todo',
	})
	const { grant, token } = await connect(person.id, wsA.id)
	return { person, wsA, wsB, objA, objB, grant, token }
}

describe('a mat_ token pinned to workspace A', () => {
	it('answers 403 workspace_mismatch when X-Workspace-Id names workspace B', async () => {
		const { wsB, token } = await seedTwoWorkspaces()

		const res = await api('/api/objects', { token, workspaceId: wsB.id })

		expect(res.status).toBe(403)
		expect(res.body.error.oauth_error).toBe('workspace_mismatch')
		expect(res.text).not.toContain('Task in B')
	})

	it('answers 404 for an object that lives in B when no header is sent, and 200 for one in A', async () => {
		const { objA, objB, token } = await seedTwoWorkspaces()

		expect((await api(`/api/objects/${objB.id}`, { token })).status).toBe(404)
		const own = await api(`/api/objects/${objA.id}`, { token })
		expect(own.status).toBe(200)
		expect(own.body.title).toBe('Task in A')
	})

	it('lists only the pinned workspace on GET /api/workspaces', async () => {
		const { wsA, token } = await seedTwoWorkspaces()

		const res = await api('/api/workspaces', { token })

		expect(res.status).toBe(200)
		expect(res.body.map((w: { id: string }) => w.id)).toEqual([wsA.id])
	})

	it('lists only the pinned workspace objects when no header is sent', async () => {
		const { objA, token } = await seedTwoWorkspaces()

		const res = await api('/api/objects', { token })

		expect(res.status).toBe(200)
		expect(res.body.map((o: { id: string }) => o.id)).toEqual([objA.id])
	})

	it('answers 403 insufficient_scope on POST /api/workspaces', async () => {
		const { token } = await seedTwoWorkspaces()

		const res = await api('/api/workspaces', { token, method: 'POST', body: { name: 'nope' } })

		expect(res.status).toBe(403)
		expect(res.body.error.oauth_error).toBe('insufficient_scope')
		expect(res.headers.get('www-authenticate')).toContain('insufficient_scope')
	})

	it('answers 403 on a route outside the allowlist: regenerating an API key', async () => {
		const { person, token } = await seedTwoWorkspaces()

		const res = await api(`/api/actors/${person.id}/api-keys`, { token, method: 'POST' })

		expect(res.status).toBe(403)
		expect(res.text).not.toContain('ank_')
	})

	it('cannot create an actor: POST /api/actors accepts API keys only', async () => {
		const { wsA, token } = await seedTwoWorkspaces()

		const res = await api('/api/actors', {
			token,
			method: 'POST',
			body: { type: 'agent', name: 'Sneaky', workspace_id: wsA.id },
		})

		expect(res.status).toBe(401)
	})

	it('is rejected on /api/* without the forward marker, even with a valid token', async () => {
		const { token } = await seedTwoWorkspaces()

		const res = await api('/api/objects', { token, marker: false })

		expect(res.status).toBe(401)
	})

	it('is refused for an unknown token', async () => {
		await seedTwoWorkspaces()

		expect((await api('/api/objects', { token: mintToken('mat_').raw })).status).toBe(401)
	})

	it('creates objects under the person, so changes show under their name', async () => {
		const { person, wsA, token } = await seedTwoWorkspaces()

		const res = await api('/api/objects', {
			token,
			method: 'POST',
			body: { type: 'task', title: 'Made through Claude', status: 'todo' },
		})

		expect(res.status).toBe(201)
		expect(res.body.createdBy).toBe(person.id)
		expect(res.body.workspaceId ?? res.body.workspace_id).toBe(wsA.id)
	})

	it('writes a viewer can make with an API key are treated the same through a token', async () => {
		const { wsA } = await seedTwoWorkspaces()
		const viewer = await insertActor(db)
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: wsA.id, actorId: viewer.id, role: 'viewer' })
		const { token } = await connect(viewer.id, wsA.id)
		const body = { type: 'task', title: 'Viewer write', status: 'todo' }

		const viaToken = await api('/api/objects', { token, method: 'POST', body })
		const viaKey = await api('/api/objects', {
			token: viewer.apiKey,
			workspaceId: wsA.id,
			method: 'POST',
			body,
			marker: false,
		})

		expect(viaToken.status).toBe(viaKey.status)
	})

	it('does not return an api_key field from the actor routes', async () => {
		const { person, wsA, token } = await seedTwoWorkspaces()

		const list = await api('/api/actors', { token })
		const one = await api(`/api/actors/${person.id}`, { token, workspaceId: wsA.id })

		expect(list.status).toBe(200)
		expect(one.status).toBe(200)
		expect(list.text).not.toMatch(/api_?key/i)
		expect(one.text).not.toMatch(/api_?key/i)
	})

	it('cannot reach anything by id that lives in B, whatever the route family', async () => {
		const { person, wsB, objB, token } = await seedTwoWorkspaces()
		const objB2 = await insertObject(db, wsB.id, person.id, {
			type: 'bet',
			title: 'Second in B',
			status: 'signal',
		})
		const rel = await insertRelationship(db, person.id, {
			sourceType: 'object',
			sourceId: objB.id,
			targetType: 'object',
			targetId: objB2.id,
			type: 'informs',
		})
		const [file] = await db
			.insert(files)
			.values({
				workspaceId: wsB.id,
				name: 'secret.txt',
				mimeType: 'text/plain',
				sizeBytes: 1,
				storageKey: 'k',
				createdBy: person.id,
			})
			.returning()
		const trigger = await insertTrigger(db, wsB.id, person.id, person.id, {})
		const session = await insertSession(db, wsB.id, person.id, person.id, {})
		const note = await insertNotification(db, wsB.id, person.id, {})
		const conversation = await insertConversation(db, wsB.id, person.id)
		const agent = await insertActor(db, { type: 'agent', email: null })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: wsB.id, actorId: agent.id, role: 'member' })
		const [skill] = await db
			.insert(workspaceSkills)
			.values({
				workspaceId: wsB.id,
				name: 'secret-skill',
				content: 'x',
				storageKey: 'k',
				sizeBytes: 1,
				createdBy: person.id,
			})
			.returning()

		const attempts: Array<[string, string, unknown?]> = [
			['GET', `/api/objects/${objB.id}`],
			['PATCH', `/api/objects/${objB.id}`, { title: 'hijacked' }],
			['DELETE', `/api/objects/${objB.id}`],
			['GET', `/api/objects/${objB.id}/graph`],
			['GET', `/api/objects/${objB.id}/graph/traverse`],
			['DELETE', `/api/relationships/${rel.id}`],
			['GET', `/api/files/${file.id}`],
			['PATCH', `/api/files/${file.id}`, { name: 'hijacked' }],
			['DELETE', `/api/files/${file.id}`],
			['PATCH', `/api/triggers/${trigger.id}`, { enabled: false }],
			['DELETE', `/api/triggers/${trigger.id}`],
			['GET', `/api/sessions/${session.id}`],
			['PATCH', `/api/sessions/${session.id}`, { current_activity: 'hijacked' }],
			['GET', `/api/sessions/${session.id}/logs`],
			['GET', `/api/sessions/${session.id}/logs/deep`],
			['POST', `/api/sessions/${session.id}/stop`],
			['POST', `/api/sessions/${session.id}/pause`],
			['POST', `/api/sessions/${session.id}/resume`],
			['GET', `/api/notifications/${note.id}`],
			['PATCH', `/api/notifications/${note.id}`, { status: 'dismissed' }],
			['DELETE', `/api/notifications/${note.id}`],
			['GET', `/api/conversations/${conversation.id}`],
			['GET', `/api/conversations/${conversation.id}/messages`],
			['POST', `/api/conversations/${conversation.id}/messages`, { content: 'hello' }],
			['GET', `/api/actors/${agent.id}`],
			['PATCH', `/api/actors/${agent.id}`, { description: 'hijacked' }],
			['DELETE', `/api/actors/${agent.id}/workspace-skills/${skill.id}`],
			['GET', `/api/workspaces/${wsB.id}/members`],
			['GET', `/api/workspaces/${wsB.id}/skills`],
			['GET', `/api/workspaces/${wsB.id}/skills/${skill.name}`],
		]
		const outcomes: string[] = []
		for (const [method, path, body] of attempts) {
			const res = await api(path, { token, method, body })
			if (![403, 404].includes(res.status)) outcomes.push(`${method} ${path} -> ${res.status}`)
			expect(res.text).not.toContain('Task in B')
			expect(res.text).not.toContain('Second in B')
		}
		expect(outcomes).toEqual([])

		// Attaching a skill from B reports a per-item failure instead of attaching it.
		const attach = await api(`/api/actors/${agent.id}/workspace-skills/batch`, {
			token,
			method: 'POST',
			body: { workspaceSkillIds: [skill.id] },
		})
		expect(JSON.stringify(attach.body)).toContain('"success":false')

		// Nothing in B was changed or deleted.
		const [stillThere] = await db
			.select()
			.from(files)
			.where(and(eq(files.id, file.id), eq(files.workspaceId, wsB.id)))
		expect(stillThere?.name).toBe('secret.txt')
		const [object] = await db.select().from(objects).where(eq(objects.id, objB.id))
		expect(object?.title).toBe('Task in B')
	})
})

describe('the same person with an API key', () => {
	it('still reaches both workspace A and workspace B', async () => {
		const { person, wsA, wsB } = await seedTwoWorkspaces()

		const a = await api('/api/objects', {
			token: person.apiKey,
			workspaceId: wsA.id,
			marker: false,
		})
		const b = await api('/api/objects', {
			token: person.apiKey,
			workspaceId: wsB.id,
			marker: false,
		})

		expect(a.status).toBe(200)
		expect(b.status).toBe(200)
		expect(a.body.map((o: { title: string }) => o.title)).toEqual(['Task in A'])
		expect(b.body.map((o: { title: string }) => o.title)).toEqual(['Task in B'])
	})
})

describe('who the caller is', () => {
	it('is the same person for authMiddleware and the /mcp telemetry label, for a key and for a token', async () => {
		const { person, wsA, token } = await seedTwoWorkspaces()
		__resetMcpActorCache()

		const created = async (bearer: string, workspaceId: string | undefined, marker: boolean) =>
			(
				await api('/api/objects', {
					token: bearer,
					workspaceId,
					method: 'POST',
					body: { type: 'task', title: 'Who am I', status: 'todo' },
					marker,
				})
			).body.createdBy

		const keyCaller = await created(person.apiKey, wsA.id, false)
		const tokenCaller = await created(token, undefined, true)

		expect(keyCaller).toBe(person.id)
		expect(tokenCaller).toBe(person.id)
		expect((await __resolveAgentActor(db, person.apiKey))?.actorId).toBe(keyCaller)
		expect((await __resolveAgentActor(db, token))?.actorId).toBe(tokenCaller)
	})

	it('is nobody for a refresh token or an unknown token, on both paths', async () => {
		await seedTwoWorkspaces()
		__resetMcpActorCache()

		expect(await __resolveAgentActor(db, mintToken('mrt_').raw)).toBeNull()
		expect(await __resolveAgentActor(db, mintToken('mat_').raw)).toBeNull()
	})
})

describe('ending a connection', () => {
	it('answers 401 on the next request once the person is removed from the pinned workspace', async () => {
		const { person, wsA, token } = await seedTwoWorkspaces()
		expect((await api('/api/objects', { token })).status).toBe(200)

		await db
			.delete(workspaceMembers)
			.where(and(eq(workspaceMembers.actorId, person.id), eq(workspaceMembers.workspaceId, wsA.id)))
		// The members route calls this when it removes someone.
		evictMembership(person.id, wsA.id)

		expect((await api('/api/objects', { token })).status).toBe(401)
	})

	it('answers 401 on the next request once the grant is revoked', async () => {
		const { grant, token } = await seedTwoWorkspaces()
		expect((await api('/api/objects', { token })).status).toBe(200)

		await db
			.update(oauthGrants)
			.set({ revokedAt: new Date(), revokeReason: 'user' })
			.where(eq(oauthGrants.id, grant.id))
		evictOAuthTokens()

		expect((await api('/api/objects', { token })).status).toBe(401)
	})

	it('answers 401 once the token has expired', async () => {
		const { grant, token } = await seedTwoWorkspaces()
		await db
			.update(oauthTokens)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(oauthTokens.grantId, grant.id))
		evictOAuthTokens()

		expect((await api('/api/objects', { token })).status).toBe(401)
	})
})

describe('grant bookkeeping', () => {
	it('stamps last_used_at on the grant after a request', async () => {
		const { grant, token } = await seedTwoWorkspaces()
		expect((await api('/api/objects', { token })).status).toBe(200)

		await vi.waitFor(async () => {
			const [row] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, grant.id))
			expect(row.lastUsedAt).not.toBeNull()
		})
	})
})

describe('kill switch', () => {
	it('gives a mat_ token today\'s 401 "Invalid token format" when MASKIN_MCP_OAUTH_ENABLED is unset', async () => {
		const { token } = await seedTwoWorkspaces()
		vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', '')
		try {
			const res = await api('/api/objects', { token })
			expect(res.status).toBe(401)
			expect(res.body.error.message).toBe('Invalid token format')
		} finally {
			vi.stubEnv('MASKIN_MCP_OAUTH_ENABLED', 'true')
		}
	})
})

describe('through /mcp', () => {
	it('returns a tool error and no data for a tool call that names workspace B', async () => {
		const { wsB, token } = await seedTwoWorkspaces()

		const call = await mcpToolCall(token, 'list_objects', { workspace_id: wsB.id, type: 'task' })

		expect(call.payload?.error).toBeDefined()
		expect(call.payload?.objects).toBeUndefined()
		expect(call.raw).not.toContain('Task in B')
	})

	it('serves a tool call for the pinned workspace', async () => {
		const { wsA, token } = await seedTwoWorkspaces()

		const call = await mcpToolCall(token, 'list_objects', { workspace_id: wsA.id, type: 'task' })

		expect(call.payload?.error).toBeUndefined()
		expect(call.raw).toContain('Task in A')
		expect(call.raw).not.toContain('Task in B')
	})

	it('shows one workspace from list_workspaces', async () => {
		const { wsA, wsB, token } = await seedTwoWorkspaces()

		const call = await mcpToolCall(token, 'list_workspaces', {})

		expect(call.payload?.workspaces?.map((w: { id: string }) => w.id)).toEqual([wsA.id])
		expect(call.raw).not.toContain(wsB.id)
	})

	it('fails create_workspace under a connector token', async () => {
		const { token } = await seedTwoWorkspaces()

		const call = await mcpToolCall(token, 'create_workspace', { name: 'Should not exist' })

		expect(call.isError).toBe(true)
		expect(call.text).toContain('403')
	})

	it('writes an object under the person when a tool creates one', async () => {
		const { person, wsA, token } = await seedTwoWorkspaces()

		const call = await mcpToolCall(token, 'create_objects', {
			workspace_id: wsA.id,
			nodes: [{ $id: 'n1', type: 'task', title: 'Created by a tool', status: 'todo' }],
			edges: [],
		})

		expect(call.isError).toBe(false)
		const [row] = await db.select().from(objects).where(eq(objects.title, 'Created by a tool'))
		expect(row?.createdBy).toBe(person.id)
		expect(row?.workspaceId).toBe(wsA.id)
	})
})

describe('a viewer connected through Claude is read-only', () => {
	async function seedViewer() {
		const { person, wsA, objA, token: memberToken } = await seedTwoWorkspaces()
		const viewer = await insertActor(db)
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: wsA.id, actorId: viewer.id, role: 'viewer' })
		const { token } = await connect(viewer.id, wsA.id)
		return { person, wsA, objA, viewer, token, memberToken }
	}

	it('answers 403 on a header-scoped write (create) and 201 for a member with the same call', async () => {
		const { wsA, token, memberToken } = await seedViewer()
		const body = { type: 'task', title: 'Viewer write', status: 'todo' }

		const asViewer = await api('/api/objects', { token, method: 'POST', body })
		const asMember = await api('/api/objects', { token: memberToken, method: 'POST', body })

		expect(asViewer.status).toBe(403)
		expect(asMember.status).toBe(201)
		const rows = await db.select().from(objects).where(eq(objects.workspaceId, wsA.id))
		expect(rows.filter((o) => o.title === 'Viewer write')).toHaveLength(1)
	})

	it('answers 403 on by-ID writes (patch, delete) and still serves the read', async () => {
		const { objA, token } = await seedViewer()

		const patch = await api(`/api/objects/${objA.id}`, {
			token,
			method: 'PATCH',
			body: { title: 'renamed by a viewer' },
		})
		const del = await api(`/api/objects/${objA.id}`, { token, method: 'DELETE' })
		const read = await api(`/api/objects/${objA.id}`, { token })

		expect(patch.status).toBe(403)
		expect(del.status).toBe(403)
		expect(read.status).toBe(200)
		const [row] = await db.select().from(objects).where(eq(objects.id, objA.id))
		expect(row?.title).toBe('Task in A')
	})

	it('answers 403 on a header-scoped write whether the key or the token filled the shared cache first', async () => {
		const { wsA, viewer, token } = await seedViewer()
		const body = { type: 'task', title: 'Poisoned?', status: 'todo' }
		const viaKey = () =>
			api('/api/objects', {
				token: viewer.apiKey,
				workspaceId: wsA.id,
				method: 'POST',
				body,
				marker: false,
			})
		const viaToken = () => api('/api/objects', { token, method: 'POST', body })

		// Token first, then key, then token again: each reads the cache the other wrote.
		expect((await viaToken()).status).toBe(403)
		expect((await viaKey()).status).toBe(403)
		expect((await viaToken()).status).toBe(403)

		// Key first for a second viewer.
		const second = await insertActor(db)
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: wsA.id, actorId: second.id, role: 'viewer' })
		const { token: secondToken } = await connect(second.id, wsA.id)
		const keyFirst = await api('/api/objects', {
			token: second.apiKey,
			workspaceId: wsA.id,
			method: 'POST',
			body,
			marker: false,
		})
		const tokenAfter = await api('/api/objects', { token: secondToken, method: 'POST', body })

		expect(keyFirst.status).toBe(403)
		expect(tokenAfter.status).toBe(403)
		const rows = await db.select().from(objects).where(eq(objects.workspaceId, wsA.id))
		expect(rows.filter((o) => o.title === 'Poisoned?')).toHaveLength(0)
	})
})

describe('a token pinned to workspace A cannot write by id into workspace B', () => {
	it('answers 404 and changes nothing, even though the person owns both workspaces', async () => {
		const { person, wsB, objB, objA, token } = await seedTwoWorkspaces()
		const [file] = await db
			.insert(files)
			.values({
				workspaceId: wsB.id,
				name: 'b.txt',
				mimeType: 'text/plain',
				sizeBytes: 1,
				storageKey: 'kb',
				createdBy: person.id,
			})
			.returning()

		const patchObject = await api(`/api/objects/${objB.id}`, {
			token,
			method: 'PATCH',
			body: { title: 'hijacked' },
		})
		const deleteObject = await api(`/api/objects/${objB.id}`, { token, method: 'DELETE' })
		const patchFile = await api(`/api/files/${file.id}`, {
			token,
			method: 'PATCH',
			body: { name: 'hijacked' },
		})
		// Same person, same call, inside the pin: allowed.
		const ownPatch = await api(`/api/objects/${objA.id}`, {
			token,
			method: 'PATCH',
			body: { title: 'renamed in A' },
		})

		expect(patchObject.status).toBe(404)
		expect(deleteObject.status).toBe(404)
		expect(patchFile.status).toBe(404)
		expect(ownPatch.status).toBe(200)
		const [stillB] = await db.select().from(objects).where(eq(objects.id, objB.id))
		expect(stillB?.title).toBe('Task in B')
		const [stillFile] = await db.select().from(files).where(eq(files.id, file.id))
		expect(stillFile?.name).toBe('b.txt')
	})

	it('getWorkspaceRole and isWorkspaceWriter answer null and false outside the pin, and normally inside it', async () => {
		const { person, wsA, wsB, grant } = await seedTwoWorkspaces()
		const pin = { workspaceId: wsA.id, grantId: grant.id, clientId: CLIENT_ID }

		expect(await getWorkspaceRole(db, person.id, wsB.id)).toBe('owner')
		expect(await isWorkspaceWriter(db, person.id, wsB.id)).toBe(true)

		await runWithOAuthPin(pin, async () => {
			expect(await getWorkspaceRole(db, person.id, wsA.id)).toBe('owner')
			expect(await isWorkspaceWriter(db, person.id, wsA.id)).toBe(true)
			expect(await getWorkspaceRole(db, person.id, wsB.id)).toBeNull()
			expect(await isWorkspaceWriter(db, person.id, wsB.id)).toBe(false)
		})
	})
})
