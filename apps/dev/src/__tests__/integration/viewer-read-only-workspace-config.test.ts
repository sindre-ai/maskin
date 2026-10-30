import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { authMiddleware } from '@maskin/auth'
import { integrations, workspaceMembers } from '@maskin/db/schema'
import { createApiError, mapStatusToCode } from '../../lib/errors'
import { buildIntegration, insertActor, insertTrigger, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: workspacesRoutes } = await import('../../routes/workspaces')
const { default: workspaceSkillsRoutes } = await import('../../routes/workspace-skills')
const { default: triggersRoutes } = await import('../../routes/triggers')
const { default: installedLoopsRoutes } = await import('../../routes/installed-loops')
const { default: marketplaceLoopsRoutes } = await import('../../routes/marketplace-loops')
const { default: integrationsRoutes } = await import('../../routes/integrations')
const { default: skjaldConnectRoutes } = await import('../../routes/integrations-skjald-connect')
const { default: slackMcpRoutes } = await import('../../routes/integrations-slack-mcp')
const { default: gatewayRoutes } = await import('../../routes/integrations-gateway')
const { default: googleMeetMcpRoutes } = await import('../../routes/integrations-google-meet-mcp')
const { default: googleSearchConsoleMcpRoutes } = await import(
	'../../routes/integrations-google-search-console-mcp'
)
const { default: linkedinMcpRoutes } = await import(
	'../../routes/integrations-linkedin-unipile-mcp'
)
const { default: linkedinRoutes } = await import('../../routes/integrations-linkedin-unipile')
const { default: adminLinkedinRoutes } = await import('../../routes/admin-linkedin-unipile')
const { default: claudeOauthRoutes } = await import('../../routes/claude-oauth')
const { default: miniAppRegenRoutes } = await import('../../routes/mini-app-regen')

// Real authMiddleware (the role comes from its membership lookup) in front of the
// real Group B routes, so a viewer API key goes through the same path as in production.
function createApp() {
	const app = new OpenAPIHono()
	app.use('*', authMiddleware(db, { cacheTtlMs: 0 }))
	app.use('*', async (c, next) => {
		c.set('db' as never, db as never)
		// A viewer is turned away before any route touches these.
		c.set('agentStorage' as never, {} as never)
		c.set('sessionManager' as never, {} as never)
		c.set('storageProvider' as never, {} as never)
		c.set('notifyBridge' as never, {} as never)
		await next()
	})
	app.onError((err, c) => {
		if ('status' in err && typeof err.status === 'number') {
			return c.json(createApiError(mapStatusToCode(err.status), err.message), err.status as 400)
		}
		throw err
	})
	app.route('/api/workspaces', workspacesRoutes as never)
	app.route('/api/workspaces', workspaceSkillsRoutes as never)
	app.route('/api/triggers', triggersRoutes as never)
	app.route('/api/installed-loops', installedLoopsRoutes as never)
	app.route('/api/marketplace', marketplaceLoopsRoutes as never)
	app.route('/api/integrations/skjald', skjaldConnectRoutes as never)
	app.route('/api/integrations/linkedin-unipile/mcp', linkedinMcpRoutes as never)
	app.route('/api/integrations/linkedin-unipile', linkedinRoutes as never)
	app.route('/api/integrations/google-meet/mcp', googleMeetMcpRoutes as never)
	app.route('/api/integrations/google-search-console/mcp', googleSearchConsoleMcpRoutes as never)
	app.route('/api/integrations', integrationsRoutes as never)
	app.route('/api/integrations/slack/mcp', slackMcpRoutes as never)
	app.route('/api/integrations', gatewayRoutes as never)
	app.route('/api/admin/linkedin-unipile', adminLinkedinRoutes as never)
	app.route('/api/claude-oauth', claudeOauthRoutes as never)
	app.route('/api/mini-apps', miniAppRegenRoutes as never)
	return app
}

describe('Viewer role is read-only on workspace configuration (Group B)', () => {
	let workspaceId: string
	let viewerKey: string
	let memberKey: string
	let agentId: string
	let triggerId: string
	let integrationId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id

		const viewer = await insertActor(db, { name: 'Viewer' })
		viewerKey = viewer.apiKey
		await db.insert(workspaceMembers).values({ workspaceId, actorId: viewer.id, role: 'viewer' })

		const member = await insertActor(db, { name: 'Member' })
		memberKey = member.apiKey
		await db.insert(workspaceMembers).values({ workspaceId, actorId: member.id, role: 'member' })

		const agent = await insertActor(db, { name: 'Agent', type: 'agent' })
		agentId = agent.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })

		const trigger = await insertTrigger(db, workspaceId, getTestActorId(), agentId)
		triggerId = trigger.id

		const [integration] = await db
			.insert(integrations)
			.values(buildIntegration({ workspaceId, createdBy: getTestActorId() }))
			.returning()
		integrationId = integration.id
	})

	const auth = (key: string) => ({ Authorization: `Bearer ${key}`, 'x-workspace-id': workspaceId })
	const missing = () => randomUUID()

	// One entry per file, plus every hand-written route (the route-table guard test cannot tag
	// those). The member must get past the gate: anything but the viewer 403.
	type Case = [label: string, method: string, path: string, body: unknown]
	const cases = (): Case[] => {
		const ws = `/api/workspaces/${workspaceId}`
		const li = '/api/integrations/linkedin-unipile'
		const ig = '/api/integrations'
		const mp = '/api/marketplace/items'
		const skill = { content: '---\nname: nope\n---\nb' }
		const newSkill = { name: 'nope', ...skill }
		const trigger = {
			name: 't',
			type: 'event',
			config: { entity_type: 'task', action: 'created' },
			action_prompt: 'p',
			target_actor_id: agentId,
		}
		const skjald = {
			state: 'statestate',
			redirect_uri: 'skjald://connect/maskin',
			code_challenge: 'a'.repeat(43),
			code_challenge_method: 'S256',
		}
		const admin = { onboarding_enabled: false }
		const expose = { expose_to_agent_sessions: true }
		const nickname = { slot: 'primary', nickname: 'n' }
		const regen = { file_id: missing(), target_actor_id: agentId }
		const mcp = {}
		return [
			['workspaces', 'PATCH', ws, { settings: { pinned_files: [] } }],
			['workspaces admin', 'PATCH', `/api/workspaces/admin/${workspaceId}`, admin],
			['skills create', 'POST', `${ws}/skills`, newSkill],
			['skills update', 'PUT', `${ws}/skills/nope`, skill],
			['skills delete', 'DELETE', `${ws}/skills/nope`, undefined],
			['triggers create', 'POST', '/api/triggers', trigger],
			['triggers update', 'PATCH', `/api/triggers/${triggerId}`, { name: 'renamed' }],
			['triggers delete', 'DELETE', `/api/triggers/${triggerId}`, undefined],
			['installed loops', 'POST', '/api/installed-loops', { loopId: missing(), workspaceId }],
			['marketplace install', 'POST', `${mp}/${missing()}/install`, { workspaceId }],
			[
				'marketplace uninstall',
				'DELETE',
				`${mp}/${missing()}/uninstall`,
				{ workspaceId, keepProvisionedItems: true },
			],
			['integrations update', 'PATCH', `${ig}/${integrationId}`, expose],
			['integrations complete', 'POST', `${ig}/${integrationId}/complete`, { secret: 's' }],
			['integrations delete', 'DELETE', `${ig}/${integrationId}`, undefined],
			['github link', 'POST', `${ig}/github/link`, { installation_id: '123' }],
			['skjald authorize', 'POST', `${ig}/skjald/authorize`, skjald],
			['linkedin connect', 'POST', `${li}/connect`, mcp],
			['linkedin comment-on-post', 'POST', `${li}/comment-on-post`, mcp],
			['linkedin reply-to-comment', 'POST', `${li}/reply-to-comment`, mcp],
			['linkedin mcp', 'POST', `${li}/mcp`, mcp],
			['linkedin mcp by identity', 'POST', `${li}/mcp/acme`, mcp],
			['slack mcp', 'POST', `${ig}/slack/mcp`, mcp],
			['google meet mcp', 'POST', `${ig}/google-meet/mcp`, mcp],
			['google search console mcp', 'POST', `${ig}/google-search-console/mcp`, mcp],
			['mcp gateway', 'POST', `${ig}/linear/gateway`, mcp],
			['mcp gateway end', 'DELETE', `${ig}/linear/gateway`, undefined],
			['linkedin refresh', 'POST', '/api/admin/linkedin-unipile/refresh-identities', undefined],
			['claude oauth disconnect', 'DELETE', '/api/claude-oauth', undefined],
			['claude nickname', 'PATCH', '/api/claude-oauth/nickname', nickname],
			['claude oauth promote', 'POST', '/api/claude-oauth/promote', { slot: 'backup' }],
			['claude oauth swap', 'POST', '/api/claude-oauth/swap', mcp],
			['mini app regen', 'POST', '/api/mini-apps/regen', regen],
		]
	}

	it('returns 403 to a viewer on every Group B write', async () => {
		const app = createApp()
		const refused: string[] = []
		for (const [label, method, path, body] of cases()) {
			const res = await app.request(jsonRequest(method, path, body, auth(viewerKey)))
			if (res.status !== 403) refused.push(`${label}: ${res.status}`)
		}
		expect(refused).toEqual([])
	})

	it('lets a member past the gate on every Group B write', async () => {
		const app = createApp()
		const blocked: string[] = []
		for (const [label, method, path, body] of cases()) {
			// The MCP routes read the Node socket from c.env, which app.request does not have, so they
			// throw once past the gate. Reaching that point is the pass.
			const res = await app
				.request(jsonRequest(method, path, body, auth(memberKey)))
				.catch(() => null)
			if (!res) continue
			const text = await res.text()
			if (res.status === 403 && text.includes('Viewers have read-only access')) blocked.push(label)
		}
		expect(blocked).toEqual([])
	})

	it('still lets a member change the workspace settings, and a viewer read them', async () => {
		const app = createApp()
		const body = { settings: { pinned_files: [] } }
		const patch = await app.request(
			jsonRequest('PATCH', `/api/workspaces/${workspaceId}`, body, auth(memberKey)),
		)
		expect(patch.status).toBe(200)

		const list = await app.request(jsonGet('/api/integrations', auth(viewerKey)))
		expect(list.status).toBe(200)
		const triggersList = await app.request(jsonGet('/api/triggers', auth(viewerKey)))
		expect(triggersList.status).toBe(200)
	})
})
