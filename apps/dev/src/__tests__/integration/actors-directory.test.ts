import {
	agentSkills,
	credentialAccessLog,
	integrations,
	workspaceMembers,
	workspaceSkills,
} from '@maskin/db/schema'
import { count, eq } from 'drizzle-orm'
import { buildIntegration, buildWorkspaceSkill, insertActor, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')

function createApp() {
	return createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
}

async function addMember(workspaceId: string, name: string, type: 'agent' | 'human' = 'agent') {
	const actor = await insertActor(db, { type, name })
	await db.insert(workspaceMembers).values({ workspaceId, actorId: actor.id, role: 'member' })
	return actor
}

async function addSkill(
	workspaceId: string,
	name: string,
	attachTo: string[],
	overrides: Record<string, unknown> = {},
) {
	const [skill] = await db
		.insert(workspaceSkills)
		.values(buildWorkspaceSkill({ workspaceId, name, createdBy: getTestActorId(), ...overrides }))
		.returning()
	for (const actorId of attachTo) {
		await db.insert(agentSkills).values({ actorId, workspaceSkillId: skill.id })
	}
	return skill
}

describe('Actors Integration — GET / include=skills', () => {
	it('adds sorted skill names to agents, omitted when empty and for humans', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const skilled = await addMember(ws.id, 'Skilled')
		const bare = await addMember(ws.id, 'Bare')
		const human = await addMember(ws.id, 'Hannah', 'human')
		await addSkill(ws.id, 'zebra-skill', [skilled.id, human.id])
		await addSkill(ws.id, 'alpha-skill', [skilled.id])

		const res = await app.request(
			jsonGet('/api/actors?include=skills', { 'X-Workspace-Id': ws.id }),
		)
		expect(res.status).toBe(200)
		const rows = (await res.json()) as Array<{ id: string; skills?: string[] }>
		const byId = new Map(rows.map((r) => [r.id, r]))
		expect(byId.get(skilled.id)?.skills).toEqual(['alpha-skill', 'zebra-skill'])
		expect(byId.get(bare.id)).not.toHaveProperty('skills')
		expect(byId.get(human.id)).not.toHaveProperty('skills')
	})

	it('leaves out invalid skills and skills that belong to another workspace', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const otherWs = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(ws.id, 'Picky')
		await addSkill(ws.id, 'good-skill', [agent.id])
		await addSkill(ws.id, 'broken-skill', [agent.id], { isValid: false })
		await addSkill(otherWs.id, 'elsewhere-skill', [agent.id])

		const res = await app.request(
			jsonGet('/api/actors?include=skills', { 'X-Workspace-Id': ws.id }),
		)
		const rows = (await res.json()) as Array<{ id: string; skills?: string[] }>
		expect(rows.find((r) => r.id === agent.id)?.skills).toEqual(['good-skill'])
	})

	it('leaves the default response without a skills key', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await addMember(ws.id, 'Plain')
		await addSkill(ws.id, 'some-skill', [agent.id])

		const res = await app.request(jsonGet('/api/actors', { 'X-Workspace-Id': ws.id }))
		expect(res.status).toBe(200)
		expect(await res.text()).not.toContain('some-skill')
	})

	it('answers 400 without X-Workspace-Id and for an unknown include value', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())

		const noWs = await app.request(jsonGet('/api/actors?include=skills'))
		expect(noWs.status).toBe(400)

		const unknown = await app.request(
			jsonGet('/api/actors?include=tools', { 'X-Workspace-Id': ws.id }),
		)
		expect(unknown.status).toBe(400)
	})
})

describe('Actors Integration — GET / name and name_prefix', () => {
	it('matches an exact name case-insensitively and returns every match', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		await addMember(ws.id, 'CPO')
		await addMember(ws.id, 'cpo')
		await addMember(ws.id, 'CPO Assistant')

		const res = await app.request(jsonGet('/api/actors?name=Cpo', { 'X-Workspace-Id': ws.id }))
		expect(res.status).toBe(200)
		const rows = (await res.json()) as Array<{ name: string }>
		expect(rows.map((r) => r.name).sort()).toEqual(['CPO', 'cpo'])
	})

	it('matches a prefix case-insensitively', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		await addMember(ws.id, 'Sales Rep')
		await addMember(ws.id, 'Sales Coach')
		await addMember(ws.id, 'Presales')

		const res = await app.request(
			jsonGet('/api/actors?name_prefix=sales', { 'X-Workspace-Id': ws.id }),
		)
		const rows = (await res.json()) as Array<{ name: string }>
		expect(rows.map((r) => r.name).sort()).toEqual(['Sales Coach', 'Sales Rep'])
	})

	it('treats percent, underscore and backslash in name_prefix as literal text', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		await addMember(ws.id, '100% Agent')
		await addMember(ws.id, '100x Agent')
		await addMember(ws.id, 'a_b')
		await addMember(ws.id, 'axb')
		await addMember(ws.id, 'back\\slash')

		const names = async (prefix: string) => {
			const res = await app.request(
				jsonGet(`/api/actors?name_prefix=${encodeURIComponent(prefix)}`, {
					'X-Workspace-Id': ws.id,
				}),
			)
			return ((await res.json()) as Array<{ name: string }>).map((r) => r.name)
		}

		expect(await names('100%')).toEqual(['100% Agent'])
		expect(await names('a_')).toEqual(['a_b'])
		expect(await names('back\\')).toEqual(['back\\slash'])
		expect(await names('%')).toEqual([])
	})

	it('returns an empty list, not an error, when nothing matches', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		await addMember(ws.id, 'Someone')

		const res = await app.request(jsonGet('/api/actors?name=Nobody', { 'X-Workspace-Id': ws.id }))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
		expect(res.headers.get('X-Total-Count')).toBe('0')
	})

	it('makes X-Total-Count the filtered total, with and without a limit', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		for (const n of ['Dev One', 'Dev Two', 'Dev Three', 'Ops One']) await addMember(ws.id, n)

		const paged = await app.request(
			jsonGet('/api/actors?name_prefix=dev&limit=2', { 'X-Workspace-Id': ws.id }),
		)
		expect(((await paged.json()) as unknown[]).length).toBe(2)
		expect(paged.headers.get('X-Total-Count')).toBe('3')

		const all = await app.request(
			jsonGet('/api/actors?name_prefix=dev', { 'X-Workspace-Id': ws.id }),
		)
		expect(all.headers.get('X-Total-Count')).toBe('3')
	})

	it('answers 400 for both filters together and for a filter without a workspace', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())

		const both = await app.request(
			jsonGet('/api/actors?name=a&name_prefix=a', { 'X-Workspace-Id': ws.id }),
		)
		expect(both.status).toBe(400)
		expect(await both.text()).toContain('Pass name or name_prefix, not both')

		const noWs = await app.request(jsonGet('/api/actors?name=a'))
		expect(noWs.status).toBe(400)
	})

	it('rejects an empty name and a name_prefix over 64 characters', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())

		const empty = await app.request(jsonGet('/api/actors?name=', { 'X-Workspace-Id': ws.id }))
		expect(empty.status).toBe(400)

		const long = await app.request(
			jsonGet(`/api/actors?name_prefix=${'a'.repeat(65)}`, { 'X-Workspace-Id': ws.id }),
		)
		expect(long.status).toBe(400)
	})
})

describe('Actors Integration — directory path reads no tool config or credentials', () => {
	const SECRETS = [
		'SEEDED_URL_TOKEN',
		'SEEDED_ARGS_TOKEN',
		'SEEDED_HEADER_TOKEN',
		'SEEDED_ENV_TOKEN',
		'SEEDED_CREDENTIAL_BLOB',
		'x-seeded-header-name',
		'SEEDED_ENV_NAME',
	]

	async function seedAgentWithSecrets(workspaceId: string) {
		const agent = await insertActor(db, {
			type: 'agent',
			name: 'Secret Holder',
			tools: {
				mcpServers: {
					'seeded-http': {
						type: 'http',
						url: 'https://mcp.example.invalid/mcp?token=SEEDED_URL_TOKEN',
						headers: { 'x-seeded-header-name': 'Bearer SEEDED_HEADER_TOKEN' },
					},
					'seeded-stdio': {
						type: 'stdio',
						command: 'npx',
						args: ['-y', 'some-server', '--token', 'SEEDED_ARGS_TOKEN'],
						env: { SEEDED_ENV_NAME: 'SEEDED_ENV_TOKEN' },
					},
				},
			},
		})
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })
		await db.insert(integrations).values(
			buildIntegration({
				workspaceId,
				provider: 'slack',
				status: 'active',
				credentials: 'SEEDED_CREDENTIAL_BLOB',
				createdBy: getTestActorId(),
			}),
		)
		await addSkill(workspaceId, 'visible-skill', [agent.id])
		return agent
	}

	async function auditRows(workspaceId: string) {
		const [row] = await db
			.select({ value: count() })
			.from(credentialAccessLog)
			.where(eq(credentialAccessLog.workspaceId, workspaceId))
		return row?.value ?? 0
	}

	it.each([
		['workspace owner', 'owner'],
		['plain member', 'member'],
	])(
		'puts no tool config or credential in the body for a %s, and writes no audit row',
		async (_label, role) => {
			const app = createApp()
			const ws = await insertWorkspace(db, getTestActorId())
			if (role !== 'owner') {
				await db
					.update(workspaceMembers)
					.set({ role })
					.where(eq(workspaceMembers.workspaceId, ws.id))
			}
			await seedAgentWithSecrets(ws.id)
			const before = await auditRows(ws.id)

			for (const path of ['/api/actors?include=skills', '/api/actors?name_prefix=secret']) {
				const res = await app.request(jsonGet(path, { 'X-Workspace-Id': ws.id }))
				expect(res.status).toBe(200)
				const text = await res.text()
				expect(text).toContain('Secret Holder')
				for (const secret of SECRETS) expect(text).not.toContain(secret)
				for (const key of [
					'"tools"',
					'"mcpServers"',
					'"args"',
					'"env"',
					'"headers"',
					'"command"',
				]) {
					expect(text).not.toContain(key)
				}
			}

			expect(await auditRows(ws.id)).toBe(before)
		},
	)
})
