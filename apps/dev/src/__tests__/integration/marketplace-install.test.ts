import { randomUUID } from 'node:crypto'
import {
	integrations,
	marketplaceAgents,
	marketplaceInstallations,
	marketplaceSkills,
	workspaceSkills,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { insertActor, insertWorkspace } from '../factories'
import { installMarketplaceItem } from '../../services/marketplace-install'
import { db, getTestActorId } from './global-setup'

/**
 * Service-level tests for the install path. Real Postgres, no HTTP layer —
 * §3.2 branching, requires check, idempotency conflict handling, and
 * per-item_kind materialization. Route-layer mapping to HTTP codes is
 * covered separately by marketplace-flow.test.ts.
 */

async function insertMarketplaceAgent(overrides: Partial<typeof marketplaceAgents.$inferInsert> = {}) {
	const [row] = await db
		.insert(marketplaceAgents)
		.values({
			slug: `agent-${randomUUID().slice(0, 8)}`,
			displayName: 'Investor Relations',
			outcomeLine: 'Manages investor updates',
			description: 'Long-form description',
			systemPrompt: 'You are an IR agent.',
			team: 'revenue',
			...overrides,
		})
		.returning()
	return row
}

async function insertMarketplaceSkill(overrides: Partial<typeof marketplaceSkills.$inferInsert> = {}) {
	const [row] = await db
		.insert(marketplaceSkills)
		.values({
			slug: `skill-${randomUUID().slice(0, 8)}`,
			displayName: 'Draft LinkedIn Post',
			outcomeLine: 'Turns notes into a founder-voice post',
			description: 'Long-form description',
			content: '# Skill\n\nMarkdown body.',
			team: 'growth',
			...overrides,
		})
		.returning()
	return row
}

describe('marketplace-install — happy paths', () => {
	it('installs an agent, creates the actor, and writes the audit row', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertMarketplaceAgent()

		const result = await installMarketplaceItem(db, {
			itemKind: 'agent',
			catalogId: agent.id,
			workspaceId: ws.id,
			installedByActorId: getTestActorId(),
		})

		expect(result.status).toBe('installed')
		if (result.status !== 'installed') throw new Error('unreachable')
		expect(result.installation.itemKind).toBe('agent')
		expect(result.installation.catalogSlug).toBe(agent.slug)
		expect(result.installation.actorId).toBeTruthy()

		const [row] = await db
			.select()
			.from(marketplaceInstallations)
			.where(eq(marketplaceInstallations.id, result.installation.id))
		expect(row.uninstalledAt).toBeNull()
		expect(row.source).toBe('marketplace')
	})

	it('installs a skill and creates the workspace_skills row', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const skill = await insertMarketplaceSkill()

		const result = await installMarketplaceItem(db, {
			itemKind: 'skill',
			catalogId: skill.id,
			workspaceId: ws.id,
			installedByActorId: getTestActorId(),
		})

		expect(result.status).toBe('installed')
		if (result.status !== 'installed') throw new Error('unreachable')

		const [ws_skill] = await db
			.select()
			.from(workspaceSkills)
			.where(eq(workspaceSkills.id, result.installation.workspaceSkillId ?? ''))
		expect(ws_skill.name).toBe(skill.slug)
		expect(ws_skill.content).toBe(skill.content)
	})
})

describe('marketplace-install — idempotency', () => {
	it('returns already_installed when the same slug is installed twice', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertMarketplaceAgent()

		const first = await installMarketplaceItem(db, {
			itemKind: 'agent',
			catalogId: agent.id,
			workspaceId: ws.id,
			installedByActorId: getTestActorId(),
		})
		expect(first.status).toBe('installed')

		const second = await installMarketplaceItem(db, {
			itemKind: 'agent',
			catalogId: agent.id,
			workspaceId: ws.id,
			installedByActorId: getTestActorId(),
		})
		expect(second.status).toBe('already_installed')
		if (second.status !== 'already_installed') throw new Error('unreachable')
		if (first.status !== 'installed') throw new Error('unreachable')
		expect(second.installation.id).toBe(first.installation.id)
	})
})

describe('marketplace-install — requires check', () => {
	it('returns requires_not_met when a required integration is not connected', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertMarketplaceAgent({
			requires: { integrations: ['github', 'slack'] },
		})

		const result = await installMarketplaceItem(db, {
			itemKind: 'agent',
			catalogId: agent.id,
			workspaceId: ws.id,
			installedByActorId: getTestActorId(),
		})

		expect(result.status).toBe('requires_not_met')
		if (result.status !== 'requires_not_met') throw new Error('unreachable')
		expect(result.missing.integrations?.sort()).toEqual(['github', 'slack'])
	})

	it('proceeds when all required integrations are connected', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertMarketplaceAgent({
			requires: { integrations: ['github'] },
		})
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: 'github',
			status: 'connected',
			credentials: 'placeholder',
			createdBy: getTestActorId(),
		})

		const result = await installMarketplaceItem(db, {
			itemKind: 'agent',
			catalogId: agent.id,
			workspaceId: ws.id,
			installedByActorId: getTestActorId(),
		})
		expect(result.status).toBe('installed')
	})
})

describe('marketplace-install — not-found and mcp_server', () => {
	it('returns not_found for an unknown catalog id', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const result = await installMarketplaceItem(db, {
			itemKind: 'agent',
			catalogId: randomUUID(),
			workspaceId: ws.id,
			installedByActorId: getTestActorId(),
		})
		expect(result.status).toBe('not_found')
	})

	it('returns mcp_registry_unavailable for mcp_server item_kind', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const result = await installMarketplaceItem(db, {
			itemKind: 'mcp_server',
			catalogId: randomUUID(),
			workspaceId: ws.id,
			installedByActorId: getTestActorId(),
		})
		expect(result.status).toBe('mcp_registry_unavailable')
	})
})
