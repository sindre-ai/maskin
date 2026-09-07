import { randomUUID } from 'node:crypto'
import {
	actors,
	agentSkills,
	marketplaceAgents,
	marketplaceInstallations,
	marketplaceSkills,
	triggers,
	workspaceSkills,
} from '@maskin/db/schema'
import { eq, inArray } from 'drizzle-orm'
import { insertWorkspace } from '../factories'
import { installMarketplaceItem } from '../../services/marketplace-install'
import { uninstallMarketplaceItem } from '../../services/marketplace-uninstall'
import { db, getTestActorId } from './global-setup'

/**
 * Service-level tests for the uninstall path — §3.3 semantics: soft-delete
 * on the audit row, agent archive (not hard-delete), skill fan-out check,
 * mcp_server delegation stub, trigger cleanup.
 */

async function seedAgent() {
	const [row] = await db
		.insert(marketplaceAgents)
		.values({
			slug: `agent-${randomUUID().slice(0, 8)}`,
			displayName: 'IR Agent',
			outcomeLine: 'Manages investor updates',
			description: 'Long-form',
			systemPrompt: 'You are an IR agent.',
			team: 'revenue',
			triggerSeeds: [
				{
					name: 'Weekly IR pipeline review',
					type: 'schedule',
					config: { cron: '0 9 * * MON' },
					actionPrompt: 'Review the pipeline.',
				},
			],
		})
		.returning()
	return row
}

async function seedSkill() {
	const [row] = await db
		.insert(marketplaceSkills)
		.values({
			slug: `skill-${randomUUID().slice(0, 8)}`,
			displayName: 'Draft Post',
			outcomeLine: 'Turns notes into a post',
			description: 'Long-form',
			content: '# Skill\n\nBody.',
			team: 'growth',
		})
		.returning()
	return row
}

describe('marketplace-uninstall — agent archive semantics', () => {
	it('soft-deletes the install row and archives the actor (not delete)', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await seedAgent()
		const install = await installMarketplaceItem(db, {
			itemKind: 'agent',
			catalogId: agent.id,
			workspaceId: ws.id,
			installedByActorId: getTestActorId(),
		})
		if (install.status !== 'installed') throw new Error('setup failed')

		const result = await uninstallMarketplaceItem(db, {
			installationId: install.installation.id,
			workspaceId: ws.id,
			uninstalledByActorId: getTestActorId(),
		})

		expect(result.status).toBe('uninstalled')

		// Install row is soft-deleted — still present, uninstalled_at populated.
		const [row] = await db
			.select()
			.from(marketplaceInstallations)
			.where(eq(marketplaceInstallations.id, install.installation.id))
		expect(row.uninstalledAt).not.toBeNull()

		// Actor row survives (audit-trail preservation per §3.3).
		const actorId = install.installation.actorId ?? ''
		const [actor] = await db.select().from(actors).where(eq(actors.id, actorId))
		expect(actor).toBeDefined()

		// Triggers seeded from triggerSeeds are hard-deleted.
		const triggerIds = Array.isArray(install.installation.triggerIds)
			? (install.installation.triggerIds as string[])
			: []
		if (triggerIds.length > 0) {
			const remaining = await db
				.select()
				.from(triggers)
				.where(inArray(triggers.id, triggerIds))
			expect(remaining).toEqual([])
		}
	})
})

describe('marketplace-uninstall — skill fan-out check', () => {
	it('deletes only the skill install\'s fan-out joins, keeps the skill if other agents reference it', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const skillCatalog = await seedSkill()
		const install = await installMarketplaceItem(db, {
			itemKind: 'skill',
			catalogId: skillCatalog.id,
			workspaceId: ws.id,
			installedByActorId: getTestActorId(),
		})
		if (install.status !== 'installed') throw new Error('setup failed')

		// Simulate a second agent that references this skill via agentSkills.
		const [otherAgent] = await db
			.insert(actors)
			.values({
				type: 'agent',
				name: 'Other Agent',
				apiKey: `ank_${randomUUID().slice(0, 12)}`,
			})
			.returning()
		await db.insert(agentSkills).values({
			actorId: otherAgent.id,
			workspaceSkillId: install.installation.workspaceSkillId ?? '',
		})

		const result = await uninstallMarketplaceItem(db, {
			installationId: install.installation.id,
			workspaceId: ws.id,
			uninstalledByActorId: getTestActorId(),
		})
		expect(result.status).toBe('uninstalled')

		// The workspace_skills row is kept because otherAgent still references it.
		const [skill] = await db
			.select()
			.from(workspaceSkills)
			.where(eq(workspaceSkills.id, install.installation.workspaceSkillId ?? ''))
		expect(skill).toBeDefined()

		// Fan-out check should preserve otherAgent's join.
		const joins = await db
			.select()
			.from(agentSkills)
			.where(eq(agentSkills.workspaceSkillId, install.installation.workspaceSkillId ?? ''))
		expect(joins).toHaveLength(1)
		expect(joins[0].actorId).toBe(otherAgent.id)
	})

	it('deletes the workspace_skills row when no agents reference it', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const skillCatalog = await seedSkill()
		const install = await installMarketplaceItem(db, {
			itemKind: 'skill',
			catalogId: skillCatalog.id,
			workspaceId: ws.id,
			installedByActorId: getTestActorId(),
		})
		if (install.status !== 'installed') throw new Error('setup failed')

		await uninstallMarketplaceItem(db, {
			installationId: install.installation.id,
			workspaceId: ws.id,
			uninstalledByActorId: getTestActorId(),
		})

		const rows = await db
			.select()
			.from(workspaceSkills)
			.where(eq(workspaceSkills.id, install.installation.workspaceSkillId ?? ''))
		expect(rows).toEqual([])
	})
})

describe('marketplace-uninstall — error branches', () => {
	it('returns not_found for an unknown installation id', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const result = await uninstallMarketplaceItem(db, {
			installationId: randomUUID(),
			workspaceId: ws.id,
			uninstalledByActorId: getTestActorId(),
		})
		expect(result.status).toBe('not_found')
	})

	it('returns already_uninstalled when the row is already soft-deleted', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const skillCatalog = await seedSkill()
		const install = await installMarketplaceItem(db, {
			itemKind: 'skill',
			catalogId: skillCatalog.id,
			workspaceId: ws.id,
			installedByActorId: getTestActorId(),
		})
		if (install.status !== 'installed') throw new Error('setup failed')

		await uninstallMarketplaceItem(db, {
			installationId: install.installation.id,
			workspaceId: ws.id,
			uninstalledByActorId: getTestActorId(),
		})
		const second = await uninstallMarketplaceItem(db, {
			installationId: install.installation.id,
			workspaceId: ws.id,
			uninstalledByActorId: getTestActorId(),
		})
		expect(second.status).toBe('already_uninstalled')
	})

	it('returns not_owned when the caller workspace does not match', async () => {
		const wsA = await insertWorkspace(db, getTestActorId())
		const wsB = await insertWorkspace(db, getTestActorId())
		const skillCatalog = await seedSkill()
		const install = await installMarketplaceItem(db, {
			itemKind: 'skill',
			catalogId: skillCatalog.id,
			workspaceId: wsA.id,
			installedByActorId: getTestActorId(),
		})
		if (install.status !== 'installed') throw new Error('setup failed')

		const result = await uninstallMarketplaceItem(db, {
			installationId: install.installation.id,
			workspaceId: wsB.id,
			uninstalledByActorId: getTestActorId(),
		})
		expect(result.status).toBe('not_owned')
	})
})
