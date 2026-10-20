import { randomUUID } from 'node:crypto'
import { events, actors, triggers, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import { FOR_YOU_FORMAT_SKILL } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { backfillForYouCuration } from '../../../scripts/backfill-for-you-curation'
import type { AgentStorageManager } from '../../services/agent-storage'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const OLD_PROMPT = [
	'# Role',
	'A custom line the owner added.',
	'',
	'# For You feed',
	'Score attention from the user point of view.',
	'',
	'# Replies',
	'Short.',
].join('\n')

const OLD_SKILL = FOR_YOU_FORMAT_SKILL.content.replace(
	'You are an agent writing one escalation.',
	"You are an agent writing one item for the human's For You queue.",
)

describe('backfillForYouCuration (integration)', () => {
	let workspaceId: string
	let chiefId: string
	let skillId: string
	const putWorkspaceSkill = vi.fn(async (_ws: string, _id: string, content: string) => ({
		storageKey: 'k',
		sizeBytes: Buffer.byteLength(content),
	}))
	const storage = { putWorkspaceSkill } as unknown as AgentStorageManager

	beforeEach(async () => {
		putWorkspaceSkill.mockClear()
		const humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
		const chief = await insertActor(db, {
			type: 'agent',
			name: 'Chief of Staff',
			email: null,
			systemPrompt: OLD_PROMPT,
			apiKey: `ank_cos_${Date.now()}_${Math.random()}`,
		})
		chiefId = chief.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: chiefId, role: 'member' })
		skillId = randomUUID()
		await db.insert(workspaceSkills).values({
			id: skillId,
			workspaceId,
			name: FOR_YOU_FORMAT_SKILL.name,
			description: 'old',
			content: OLD_SKILL,
			storageKey: `skills/${skillId}`,
			sizeBytes: OLD_SKILL.length,
			isValid: true,
			createdBy: humanId,
		})
	})

	async function stored() {
		const [actor] = await db.select().from(actors).where(eq(actors.id, chiefId))
		const [skill] = await db.select().from(workspaceSkills).where(eq(workspaceSkills.id, skillId))
		const trigs = await db.select().from(triggers).where(eq(triggers.workspaceId, workspaceId))
		return { prompt: actor?.systemPrompt ?? '', skill: skill?.content ?? '', trigs }
	}

	it('reports the plan and writes nothing on a dry run', async () => {
		const plan = await backfillForYouCuration(db, storage, workspaceId, false)
		expect(plan).toMatchObject({ prompt: 'patch', skill: 'update', trigger: 'create' })
		const after = await stored()
		expect(after.prompt).toBe(OLD_PROMPT)
		expect(after.skill).toBe(OLD_SKILL)
		expect(after.trigs).toHaveLength(0)
		expect(putWorkspaceSkill).not.toHaveBeenCalled()
	})

	it('patches the prompt, updates the skill, adds the trigger, and logs events', async () => {
		await backfillForYouCuration(db, storage, workspaceId, true)
		const after = await stored()
		expect(after.prompt).toContain('# For You list')
		expect(after.prompt).toContain('# Questions from other agents')
		expect(after.prompt).toContain('A custom line the owner added.')
		expect(after.skill).toBe(FOR_YOU_FORMAT_SKILL.content)
		expect(putWorkspaceSkill).toHaveBeenCalledOnce()
		expect(after.trigs).toHaveLength(1)
		expect(after.trigs[0]?.name).toBe('For You — curate the list')
		expect(after.trigs[0]?.targetActorId).toBe(chiefId)

		const rows = await db.select().from(events).where(eq(events.workspaceId, workspaceId))
		const kinds = rows.map((e) => `${e.action}:${e.entityType}`)
		expect(kinds).toEqual(
			expect.arrayContaining(['updated:actor', 'updated:workspace_skill', 'created:trigger']),
		)
	})

	it('is a no-op the second time', async () => {
		await backfillForYouCuration(db, storage, workspaceId, true)
		putWorkspaceSkill.mockClear()
		const before = await db.select().from(events).where(eq(events.workspaceId, workspaceId))
		const plan = await backfillForYouCuration(db, storage, workspaceId, true)
		expect(plan).toMatchObject({ prompt: 'none', skill: 'none', trigger: 'exists' })
		expect(putWorkspaceSkill).not.toHaveBeenCalled()
		const after = await db.select().from(events).where(eq(events.workspaceId, workspaceId))
		expect(after).toHaveLength(before.length)
		expect((await stored()).trigs).toHaveLength(1)
	})

	it('leaves a hand-edited skill alone', async () => {
		await db
			.update(workspaceSkills)
			.set({ content: '# my own version' })
			.where(eq(workspaceSkills.id, skillId))
		const plan = await backfillForYouCuration(db, storage, workspaceId, true)
		expect(plan.skill).toBe('skipped-customised')
		expect((await stored()).skill).toBe('# my own version')
	})

	it('does not duplicate a trigger the workspace already has', async () => {
		await backfillForYouCuration(db, storage, workspaceId, true)
		await backfillForYouCuration(db, storage, workspaceId, true)
		const named = await db
			.select()
			.from(triggers)
			.where(
				and(eq(triggers.workspaceId, workspaceId), eq(triggers.name, 'For You — curate the list')),
			)
		expect(named).toHaveLength(1)
	})
})
