import { randomUUID } from 'node:crypto'
import { marketplaceAgents, marketplaceSkills } from '@maskin/db/schema'
import { insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

/**
 * End-to-end HTTP tests — exercise the routes/marketplace-installations.ts
 * layer through app.request(). Covers §6.3–§6.5 status codes and the
 * install → list → uninstall lifecycle a frontend caller will use.
 */

const { default: marketplaceInstallationsRoutes } = await import(
	'../../routes/marketplace-installations'
)

function createApp() {
	return createIntegrationApp({
		path: '/api/marketplace',
		module: marketplaceInstallationsRoutes,
	})
}

async function seedSkill() {
	const [row] = await db
		.insert(marketplaceSkills)
		.values({
			slug: `flow-skill-${randomUUID().slice(0, 8)}`,
			displayName: 'Flow Skill',
			outcomeLine: 'For testing',
			description: 'For testing',
			content: '# Body',
			team: 'shared',
		})
		.returning()
	return row
}

async function seedAgent(requires: Record<string, string[]> = {}) {
	const [row] = await db
		.insert(marketplaceAgents)
		.values({
			slug: `flow-agent-${randomUUID().slice(0, 8)}`,
			displayName: 'Flow Agent',
			outcomeLine: 'For testing',
			description: 'For testing',
			systemPrompt: 'System.',
			team: 'shared',
			requires,
		})
		.returning()
	return row
}

describe('Marketplace install/uninstall flow — HTTP', () => {
	it('POST /install → 201 on first install, 200 on repeat', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const skill = await seedSkill()

		const first = await app.request(
			jsonRequest('POST', '/api/marketplace/install', {
				item_kind: 'skill',
				catalog_id: skill.id,
				workspace_id: ws.id,
			}),
		)
		expect(first.status).toBe(201)
		const firstBody = (await first.json()) as { id: string; item_kind: string }
		expect(firstBody.item_kind).toBe('skill')

		const second = await app.request(
			jsonRequest('POST', '/api/marketplace/install', {
				item_kind: 'skill',
				catalog_id: skill.id,
				workspace_id: ws.id,
			}),
		)
		expect(second.status).toBe(200)
		const secondBody = (await second.json()) as { id: string }
		expect(secondBody.id).toBe(firstBody.id)
	})

	it('POST /install → 424 with requires_not_met when integration missing', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await seedAgent({ integrations: ['github'] })

		const res = await app.request(
			jsonRequest('POST', '/api/marketplace/install', {
				item_kind: 'agent',
				catalog_id: agent.id,
				workspace_id: ws.id,
			}),
		)
		expect(res.status).toBe(424)
		const body = (await res.json()) as {
			error: string
			missing: { integrations?: string[] }
		}
		expect(body.error).toBe('requires_not_met')
		expect(body.missing.integrations).toEqual(['github'])
	})

	it('POST /install → 404 on unknown catalog id', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const res = await app.request(
			jsonRequest('POST', '/api/marketplace/install', {
				item_kind: 'agent',
				catalog_id: randomUUID(),
				workspace_id: ws.id,
			}),
		)
		expect(res.status).toBe(404)
	})

	it('POST /install → 501 for mcp_server (Registry deferred)', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const res = await app.request(
			jsonRequest('POST', '/api/marketplace/install', {
				item_kind: 'mcp_server',
				catalog_id: randomUUID(),
				workspace_id: ws.id,
			}),
		)
		expect(res.status).toBe(501)
	})

	it('GET /installations lists live installs; DELETE /installations/{id} soft-deletes', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const skill = await seedSkill()

		const installRes = await app.request(
			jsonRequest('POST', '/api/marketplace/install', {
				item_kind: 'skill',
				catalog_id: skill.id,
				workspace_id: ws.id,
			}),
		)
		const install = (await installRes.json()) as { id: string }

		const listRes = await app.request(
			jsonGet(`/api/marketplace/installations?workspace_id=${ws.id}`),
		)
		expect(listRes.status).toBe(200)
		const list = (await listRes.json()) as { installations: Array<{ id: string }> }
		expect(list.installations.map((r) => r.id)).toContain(install.id)

		const uninstallRes = await app.request(
			jsonDelete(`/api/marketplace/installations/${install.id}?workspace_id=${ws.id}`),
		)
		expect(uninstallRes.status).toBe(204)

		const listAfter = await app.request(
			jsonGet(`/api/marketplace/installations?workspace_id=${ws.id}`),
		)
		const listAfterBody = (await listAfter.json()) as { installations: Array<{ id: string }> }
		expect(listAfterBody.installations.map((r) => r.id)).not.toContain(install.id)
	})

	it('DELETE /installations/{id} → 404 when installation belongs to another workspace', async () => {
		const app = createApp()
		const wsA = await insertWorkspace(db, getTestActorId())
		const wsB = await insertWorkspace(db, getTestActorId())
		const skill = await seedSkill()

		const installRes = await app.request(
			jsonRequest('POST', '/api/marketplace/install', {
				item_kind: 'skill',
				catalog_id: skill.id,
				workspace_id: wsA.id,
			}),
		)
		const install = (await installRes.json()) as { id: string }

		const res = await app.request(
			jsonDelete(`/api/marketplace/installations/${install.id}?workspace_id=${wsB.id}`),
		)
		expect(res.status).toBe(404)
	})

	it('DELETE /installations/{id} → 409 when already uninstalled', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const skill = await seedSkill()

		const installRes = await app.request(
			jsonRequest('POST', '/api/marketplace/install', {
				item_kind: 'skill',
				catalog_id: skill.id,
				workspace_id: ws.id,
			}),
		)
		const install = (await installRes.json()) as { id: string }

		const first = await app.request(
			jsonDelete(`/api/marketplace/installations/${install.id}?workspace_id=${ws.id}`),
		)
		expect(first.status).toBe(204)
		const second = await app.request(
			jsonDelete(`/api/marketplace/installations/${install.id}?workspace_id=${ws.id}`),
		)
		expect(second.status).toBe(409)
	})
})
