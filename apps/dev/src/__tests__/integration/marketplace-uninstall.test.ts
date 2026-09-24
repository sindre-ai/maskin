import { randomUUID } from 'node:crypto'
import {
	actors,
	agentSkills,
	installedLoops,
	marketplaceAgents,
	marketplaceInstallations,
	marketplaceLoops,
	marketplaceSkills,
	triggers,
	workspaceSkills,
} from '@maskin/db/schema'
import { eq, inArray } from 'drizzle-orm'
import { installMarketplaceItem } from '../../services/marketplace-install'
import { uninstallMarketplaceItem } from '../../services/marketplace-uninstall'
import { insertWorkspace } from '../factories'
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

async function seedLoop() {
	const [row] = await db
		.insert(marketplaceLoops)
		.values({
			name: 'Weekly Digest',
			slug: `loop-${randomUUID().slice(0, 8)}`,
			description: 'A weekly digest loop',
			version: '1.0.0',
			useCase: 'ops',
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

describe('marketplace-uninstall — loop hard-delete + FK safety', () => {
	it('hard-deletes installed_loops and soft-deletes the audit row without FK 23503', async () => {
		// Regression coverage for the FK trap the reviewer flagged: uninstall
		// hard-deletes `installed_loops` while `marketplace_installations.
		// installed_loop_id` still references it. The FK is ON DELETE SET NULL
		// (see migration 0070) — without it Postgres raises 23503 and the whole
		// uninstall aborts. See Marketplace tech spec §3.3.
		const ws = await insertWorkspace(db, getTestActorId())
		const loop = await seedLoop()

		const install = await installMarketplaceItem(db, {
			itemKind: 'loop',
			catalogId: loop.id,
			workspaceId: ws.id,
			installedByActorId: getTestActorId(),
		})
		if (install.status !== 'installed') throw new Error('setup failed')

		const installedLoopId = install.installation.installedLoopId ?? ''

		const result = await uninstallMarketplaceItem(db, {
			installationId: install.installation.id,
			workspaceId: ws.id,
			uninstalledByActorId: getTestActorId(),
		})
		expect(result.status).toBe('uninstalled')

		const remaining = await db
			.select()
			.from(installedLoops)
			.where(eq(installedLoops.id, installedLoopId))
		expect(remaining).toEqual([])

		const [audit] = await db
			.select()
			.from(marketplaceInstallations)
			.where(eq(marketplaceInstallations.id, install.installation.id))
		expect(audit.uninstalledAt).not.toBeNull()
		expect(audit.installedLoopId).toBeNull()
	})
})

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
			const remaining = await db.select().from(triggers).where(inArray(triggers.id, triggerIds))
			expect(remaining).toEqual([])
		}
	})
})

describe('marketplace-uninstall — skill fan-out check', () => {
	it("deletes only the skill install's fan-out joins, keeps the skill if other agents reference it", async () => {
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
