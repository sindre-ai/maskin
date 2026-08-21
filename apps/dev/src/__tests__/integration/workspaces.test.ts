import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	actors,
	agentSkills,
	objects,
	triggers,
	workspaceMembers,
	workspaceSkills,
	workspaces as workspacesTable,
} from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

// POST /api/workspaces kicks off the Chief of Staff welcome session
// fire-and-forget (.catch(), not awaited) right after the create transaction
// commits, so the route needs a sessionManager in context even though these
// tests don't assert on session creation itself. It also needs an agentStorage:
// provisionWorkspace() skips skills, triggers and loops entirely when that is
// absent, which would leave the route's own post-commit phase untested.
type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: { createSession: (...args: unknown[]) => Promise<unknown> }
		agentStorage: InstanceType<typeof AgentStorageManager>
	}
}

// PostHog is invoked as `void capturePosthogEvent(...)` from the create route.
// Spy on the module so we can assert emit-once on success and no-emit on
// rollback without hitting the live ingestion endpoint.
const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

// Failure injection for the partial-seed rollback test. provisionWorkspace()
// calls seedDefaultAgentActors() module-internally, so mocking that export
// wouldn't intercept it — instead we mock the `@maskin/auth` boundary it really
// crosses and make one generateApiKey() call throw. That runs the *real* seed
// code, so the test covers production rollback behaviour rather than a
// hand-rolled stand-in. Defaults to the genuine implementation; only the
// rollback test arms a failure via mockImplementationOnce.
const { generateApiKeyMock } = vi.hoisted(() => ({ generateApiKeyMock: vi.fn() }))
vi.mock('@maskin/auth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@maskin/auth')>()
	generateApiKeyMock.mockImplementation(actual.generateApiKey)
	return { ...actual, generateApiKey: generateApiKeyMock }
})

const { default: workspacesRoutes } = await import('../../routes/workspaces')
const { bootstrapDefaultAgents } = await import('../../services/workspace-bootstrap')
const { AgentStorageManager } = await import('../../services/agent-storage')

function createMemoryStorage(): StorageProvider {
	const store = new Map<string, Buffer>()
	return {
		async put(key, data) {
			store.set(key, Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array))
		},
		async get(key) {
			const buf = store.get(key)
			if (!buf) throw new Error(`Not found: ${key}`)
			return buf
		},
		async list(prefix) {
			return [...store.keys()].filter((k) => k.startsWith(prefix))
		},
		async listWithMetadata(prefix) {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, buf]) => ({ key, size: buf.length }))
		},
		async delete(key) {
			store.delete(key)
		},
		async exists(key) {
			return store.has(key)
		},
		async ensureBucket() {
			// no-op
		},
	}
}

const DEFAULT_AGENT_NAMES = [
	'Workspace Coach',
	'Chief of Staff',
	'Driver',
	'Strategist',
	'Signal Analyst',
	'Researcher',
	'Knowledge Curator',
]

function createApp(agentStorage = new AgentStorageManager(createMemoryStorage(), db)) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', { createSession: vi.fn().mockResolvedValue({}) })
		c.set('agentStorage', agentStorage)
		await next()
	})

	app.route('/api/workspaces', workspacesRoutes)
	return app
}

async function agentNamesFor(workspaceId: string): Promise<string[]> {
	const rows = await db
		.select({ name: actors.name })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(eq(workspaceMembers.workspaceId, workspaceId))
	return rows
		.map((r) => r.name)
		.filter((n) => DEFAULT_AGENT_NAMES.includes(n))
		.sort()
}

async function memberActorIdsFor(workspaceId: string): Promise<string[]> {
	const rows = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.where(eq(workspaceMembers.workspaceId, workspaceId))
	return rows.map((r) => r.actorId).sort()
}

describe('Workspaces Integration', () => {
	beforeEach(() => {
		capturePosthogEventMock.mockClear()
	})

	describe('create and list', () => {
		it('creates a workspace with default settings', async () => {
			const app = createApp()

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Test Workspace' }),
			)

			expect(res.status).toBe(201)
			const body = await res.json()
			expect(body.name).toBe('Test Workspace')
			expect(body.settings).toBeDefined()
			expect(body.settings.statuses).toBeDefined()
			expect(body.settings.display_names).toBeDefined()
		})

		it('lists workspaces for the current actor', async () => {
			const app = createApp()

			// A trial-tier actor may only own one workspace (see
			// workspace-capacity.test.ts) — upgrade the first before creating a
			// second, so this test exercises listing rather than the ownership cap.
			const first = await app.request(jsonRequest('POST', '/api/workspaces', { name: 'WS 1' }))
			const ws1 = await first.json()
			await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws1.id}`, {
					settings: { billing: { plan: 'pro' } },
				}),
			)
			await app.request(jsonRequest('POST', '/api/workspaces', { name: 'WS 2' }))

			const res = await app.request(jsonGet('/api/workspaces'))
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(2)
		})
	})

	describe('update settings', () => {
		it('merges settings on update', async () => {
			const app = createApp()

			// Create workspace
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Merge Test' }),
			)
			const ws = await createRes.json()

			// Update with partial settings
			const updateRes = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { display_names: { insight: 'Signal' } },
				}),
			)

			expect(updateRes.status).toBe(200)
			const updated = await updateRes.json()
			// Should have merged: new display_names + original statuses
			expect(updated.settings.display_names.insight).toBe('Signal')
			expect(updated.settings.statuses).toBeDefined()
		})

		it('returns 404 for nonexistent workspace', async () => {
			const app = createApp()
			const id = randomUUID()

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${id}`, {
					settings: { display_names: { insight: 'Signal' } },
				}),
			)

			expect(res.status).toBe(404)
		})

		it('deep-merges llm_keys so a single-provider PATCH preserves siblings', async () => {
			const app = createApp()

			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'LLM Keys Merge' }),
			)
			const ws = await createRes.json()

			// New workspaces default to byollmAllowed: false — grant entitlement so
			// this test can exercise the llm_keys deep-merge itself, not the gate.
			await app.request(
				jsonRequest('PATCH', `/api/workspaces/admin/${ws.id}`, { byollm_allowed: true }),
			)

			await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { llm_keys: { anthropic: 'sk-ant-AAA' } },
				}),
			)
			const second = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { llm_keys: { openai: 'sk-oai-BBB' } },
				}),
			)
			const afterSet = await second.json()
			expect(afterSet.settings.llm_keys).toEqual({
				anthropic: 'sk-ant-AAA',
				openai: 'sk-oai-BBB',
			})

			// `null` inside llm_keys signals deletion; other providers stay.
			const third = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { llm_keys: { anthropic: null } },
				}),
			)
			const afterDelete = await third.json()
			expect(afterDelete.settings.llm_keys).toEqual({ openai: 'sk-oai-BBB' })
		})
	})

	describe('byollmAllowed entitlement gate', () => {
		it('defaults new workspaces to byollmAllowed: false', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Entitlement Default' }),
			)
			const ws = await createRes.json()
			expect(ws.byollmAllowed).toBe(false)
		})

		it('returns byollmAllowed on GET /api/workspaces so the settings UI can gate on it', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Entitlement In List' }),
			)
			const ws = await createRes.json()
			await app.request(
				jsonRequest('PATCH', `/api/workspaces/admin/${ws.id}`, { byollm_allowed: true }),
			)

			const listRes = await app.request(jsonGet('/api/workspaces'))
			expect(listRes.status).toBe(200)
			const list = (await listRes.json()) as Array<{ id: string; byollmAllowed: boolean }>
			const listed = list.find((w) => w.id === ws.id)
			expect(listed?.byollmAllowed).toBe(true)
		})

		it('blocks adding a BYO anthropic key when not entitled', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Blocked Anthropic Key' }),
			)
			const ws = await createRes.json()

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { llm_keys: { anthropic: 'sk-ant-blocked' } },
				}),
			)
			expect(res.status).toBe(403)

			const [row] = await db.select().from(workspacesTable).where(eq(workspacesTable.id, ws.id))
			const llmKeys = (row.settings as Record<string, unknown>).llm_keys as Record<string, unknown>
			expect(llmKeys.anthropic).toBeUndefined()
		})

		it('blocks adding a BYO openai key when not entitled', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Blocked OpenAI Key' }),
			)
			const ws = await createRes.json()

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { llm_keys: { openai: 'sk-oai-blocked' } },
				}),
			)
			expect(res.status).toBe(403)
		})

		it('blocks enabling custom_llm when not entitled', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Blocked Custom LLM' }),
			)
			const ws = await createRes.json()

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: {
						custom_llm: {
							enabled: true,
							base_url: 'https://openrouter.ai/api',
							api_key: 'sk-or-blocked',
							model: 'deepseek/deepseek-v4-flash',
						},
					},
				}),
			)
			expect(res.status).toBe(403)
		})

		it('allows adding BYO credentials once an admin flips byollm_allowed', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Allowed After Admin Flip' }),
			)
			const ws = await createRes.json()

			const adminRes = await app.request(
				jsonRequest('PATCH', `/api/workspaces/admin/${ws.id}`, { byollm_allowed: true }),
			)
			expect(adminRes.status).toBe(200)
			const adminBody = await adminRes.json()
			expect(adminBody.byollmAllowed).toBe(true)

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { llm_keys: { anthropic: 'sk-ant-allowed' } },
				}),
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.settings.llm_keys.anthropic).toBe('sk-ant-allowed')
		})

		it('does not block deleting an existing (pre-entitlement) BYO key', async () => {
			const app = createApp()
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Delete Still Allowed' }),
			)
			const ws = await createRes.json()

			// Grant, add a key, then revoke entitlement while the key is still set.
			await app.request(
				jsonRequest('PATCH', `/api/workspaces/admin/${ws.id}`, { byollm_allowed: true }),
			)
			await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { llm_keys: { anthropic: 'sk-ant-old' } },
				}),
			)
			await app.request(
				jsonRequest('PATCH', `/api/workspaces/admin/${ws.id}`, { byollm_allowed: false }),
			)

			const res = await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { llm_keys: { anthropic: null } },
				}),
			)
			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.settings.llm_keys).toEqual({})
		})
	})

	describe('members', () => {
		it('adds and lists members', async () => {
			const app = createApp()

			// Create workspace
			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Members Test' }),
			)
			const ws = await createRes.json()
			// Trial's seat cap is 1 (owner only) — bump to pro so a second member
			// can actually be added (see workspace-capacity.test.ts for cap coverage).
			await app.request(
				jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
					settings: { billing: { plan: 'pro' } },
				}),
			)

			// Create another actor to add as member
			const newActor = await insertActor(db, { name: 'New Member', email: 'member@test.com' })

			// Add member
			const addRes = await app.request(
				jsonRequest('POST', `/api/workspaces/${ws.id}/members`, {
					actor_id: newActor.id,
					role: 'member',
				}),
			)
			expect(addRes.status).toBe(201)

			// List members
			const listRes = await app.request(jsonGet(`/api/workspaces/${ws.id}/members`))
			expect(listRes.status).toBe(200)
			const members = await listRes.json()
			// Creator (owner) + all 7 default agents (seeded atomically inside the
			// create transaction) + the newly-added member = 9.
			expect(members).toHaveLength(9)
			const roles = members.map((m: { role: string }) => m.role).sort()
			expect(roles).toEqual([
				'member',
				'member',
				'member',
				'member',
				'member',
				'member',
				'member',
				'member',
				'owner',
			])
		})
	})

	describe('default agent seeding', () => {
		it('seeds all default agents atomically inside the create transaction', async () => {
			const app = createApp()

			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Default Agents' }),
			)
			expect(createRes.status).toBe(201)
			const ws = await createRes.json()

			expect(await agentNamesFor(ws.id)).toEqual([...DEFAULT_AGENT_NAMES].sort())
		})

		it('creates two workspaces for the same creator with default agents each and no cross-contamination', async () => {
			const app = createApp()

			// The ownership cap (trial tier: 1 owned workspace) would otherwise
			// block the second create below — bypass it via the enterprise
			// allowlist so this test can focus on its actual subject: agent-seed
			// isolation between two workspaces owned by the same creator.
			const ORIGINAL_ENV = process.env.MASKIN_ENTERPRISE_ACTOR_IDS
			process.env.MASKIN_ENTERPRISE_ACTOR_IDS = getTestActorId()
			try {
				const first = await (
					await app.request(jsonRequest('POST', '/api/workspaces', { name: 'Same Tenant A' }))
				).json()
				const second = await (
					await app.request(jsonRequest('POST', '/api/workspaces', { name: 'Same Tenant B' }))
				).json()

				expect(first.id).not.toBe(second.id)
				expect(await agentNamesFor(first.id)).toEqual([...DEFAULT_AGENT_NAMES].sort())
				expect(await agentNamesFor(second.id)).toEqual([...DEFAULT_AGENT_NAMES].sort())

				// Agent actor rows are distinct between workspaces — a workspace's
				// members must not overlap another workspace's, otherwise
				// permissions/skills would leak across tenants.
				const firstAgentIds = new Set(
					(
						await db
							.select({ actorId: workspaceMembers.actorId })
							.from(workspaceMembers)
							.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
							.where(eq(workspaceMembers.workspaceId, first.id))
					)
						.map((r) => r.actorId)
						.filter((id) => id !== getTestActorId()),
				)
				const secondAgentIds = (
					await db
						.select({ actorId: workspaceMembers.actorId })
						.from(workspaceMembers)
						.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
						.where(eq(workspaceMembers.workspaceId, second.id))
				)
					.map((r) => r.actorId)
					.filter((id) => id !== getTestActorId())
				for (const id of secondAgentIds) expect(firstAgentIds.has(id)).toBe(false)
			} finally {
				if (ORIGINAL_ENV === undefined) {
					// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
					delete process.env.MASKIN_ENTERPRISE_ACTOR_IDS
				} else {
					process.env.MASKIN_ENTERPRISE_ACTOR_IDS = ORIGINAL_ENV
				}
			}
		})

		it('re-invoking the seeding path against an already-seeded workspace inserts zero new agent rows', async () => {
			const app = createApp()

			const first = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Idempotent Seed' }),
			)
			const ws = await first.json()

			const initial = await db
				.select({ actorId: workspaceMembers.actorId })
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(eq(workspaceMembers.workspaceId, ws.id))
			const initialAgents = initial.filter(() => true)

			const { seedDefaultAgentActors } = await import('../../services/workspace-bootstrap')
			await seedDefaultAgentActors(db, ws.id, getTestActorId())

			const after = await db
				.select({ actorId: workspaceMembers.actorId })
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(eq(workspaceMembers.workspaceId, ws.id))

			expect(after.length).toBe(initialAgents.length)
		})

		it('attaches the continuous-onboarding and maskin-way-of-working workspace skills and creates all 15 triggers', async () => {
			const app = createApp()

			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Skills And Triggers' }),
			)
			const ws = await createRes.json()

			// No manual bootstrapDefaultAgents call: provisionWorkspace awaits it
			// post-commit, so everything below must already be queryable by the
			// time the 201 lands. That is the property under test — asserting it
			// here is what covers the route -> provisionWorkspace -> bootstrap
			// wiring rather than bootstrapDefaultAgents in isolation.
			const [chief] = await db
				.select({ id: actors.id })
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(and(eq(workspaceMembers.workspaceId, ws.id), eq(actors.name, 'Chief of Staff')))
				.limit(1)
			expect(chief).toBeDefined()

			const skillRows = await db
				.select({ id: workspaceSkills.id, name: workspaceSkills.name })
				.from(workspaceSkills)
				.where(
					and(
						eq(workspaceSkills.workspaceId, ws.id),
						eq(workspaceSkills.name, 'continuous-onboarding'),
					),
				)
			expect(skillRows).toHaveLength(1)

			const continuousOnboardingSkillId = skillRows[0]?.id
			if (!continuousOnboardingSkillId) throw new Error('continuous-onboarding skill not seeded')
			const attachRows = await db
				.select({ actorId: agentSkills.actorId })
				.from(agentSkills)
				.where(eq(agentSkills.workspaceSkillId, continuousOnboardingSkillId))
			expect(attachRows.map((r) => r.actorId)).toContain(chief?.id)

			// The shared "Maskin way of working" skill is attached to every default
			// agent (mirrored from the Template workspace) — Coach, Chief of Staff,
			// Driver, Strategist, Signal Analyst, Researcher, Knowledge Curator.
			const [wayOfWorkingSkill] = await db
				.select({ id: workspaceSkills.id })
				.from(workspaceSkills)
				.where(
					and(
						eq(workspaceSkills.workspaceId, ws.id),
						eq(workspaceSkills.name, 'maskin-way-of-working'),
					),
				)
				.limit(1)
			const wayOfWorkingSkillId = wayOfWorkingSkill?.id
			if (!wayOfWorkingSkillId) throw new Error('maskin-way-of-working skill not seeded')
			const wayOfWorkingAttachRows = await db
				.select({ actorId: agentSkills.actorId })
				.from(agentSkills)
				.where(eq(agentSkills.workspaceSkillId, wayOfWorkingSkillId))
			expect(wayOfWorkingAttachRows).toHaveLength(7)

			const triggerRows = await db
				.select({ name: triggers.name })
				.from(triggers)
				.where(eq(triggers.workspaceId, ws.id))
			expect(triggerRows).toHaveLength(15)
		})

		it('seeds the Bet discovery loop, Workspace improvements, Knowledge Wiki, and Competitor intelligence loops wired to their triggers', async () => {
			const app = createApp()

			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Loops Seeded' }),
			)
			const ws = await createRes.json()

			// Seeded by provisionWorkspace during the request — see above.
			const loopRows = await db
				.select({ id: objects.id, title: objects.title, metadata: objects.metadata })
				.from(objects)
				.where(and(eq(objects.workspaceId, ws.id), eq(objects.type, 'loop')))

			expect(loopRows.map((r) => r.title).sort()).toEqual([
				'Bet discovery loop',
				'Competitor intelligence',
				'Knowledge Wiki → digest',
				'Workspace improvements',
			])

			const triggerRows = await db
				.select({ id: triggers.id, name: triggers.name })
				.from(triggers)
				.where(eq(triggers.workspaceId, ws.id))
			const triggerIdByName = new Map(triggerRows.map((t) => [t.name, t.id]))

			const discoveryBetLoop = loopRows.find((r) => r.title === 'Bet discovery loop')
			const discoveryBetTriggerIds =
				(discoveryBetLoop?.metadata as { trigger_ids?: string[] } | null)?.trigger_ids ?? []
			expect(new Set(discoveryBetTriggerIds)).toEqual(
				new Set([
					triggerIdByName.get('Triage new insight'),
					triggerIdByName.get('Daily signal sweep'),
					triggerIdByName.get('Weekly deep revalidation'),
					triggerIdByName.get('Shape the bet'),
				]),
			)

			const workspaceImprovementsLoop = loopRows.find((r) => r.title === 'Workspace improvements')
			const workspaceImprovementsTriggerIds =
				(workspaceImprovementsLoop?.metadata as { trigger_ids?: string[] } | null)?.trigger_ids ??
				[]
			expect(new Set(workspaceImprovementsTriggerIds)).toEqual(
				new Set([
					triggerIdByName.get('Workspace Coach — daily sweep'),
					triggerIdByName.get('Workspace Coach — session completed (onboarding)'),
					triggerIdByName.get('Cluster & recommend'),
					triggerIdByName.get('Capture outcome'),
				]),
			)

			const knowledgeWikiLoop = loopRows.find((r) => r.title === 'Knowledge Wiki → digest')
			const knowledgeWikiTriggerIds =
				(knowledgeWikiLoop?.metadata as { trigger_ids?: string[] } | null)?.trigger_ids ?? []
			expect(new Set(knowledgeWikiTriggerIds)).toEqual(
				new Set([
					triggerIdByName.get('Fold new knowledge into the wiki'),
					triggerIdByName.get('Compile the twice-weekly digest'),
				]),
			)

			const competitorIntelligenceLoop = loopRows.find((r) => r.title === 'Competitor intelligence')
			const competitorIntelligenceTriggerIds =
				(competitorIntelligenceLoop?.metadata as { trigger_ids?: string[] } | null)?.trigger_ids ??
				[]
			expect(new Set(competitorIntelligenceTriggerIds)).toEqual(
				new Set([
					triggerIdByName.get('Weekly competitor sweep'),
					triggerIdByName.get('Monthly list revalidation'),
				]),
			)
		})

		it('re-invoking bootstrapDefaultAgents inserts zero new loop objects', async () => {
			const app = createApp()

			const createRes = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Idempotent Loop Seed' }),
			)
			const ws = await createRes.json()

			const agentStorage = new AgentStorageManager(createMemoryStorage(), db)
			await bootstrapDefaultAgents(db, agentStorage, ws.id, getTestActorId())
			await bootstrapDefaultAgents(db, agentStorage, ws.id, getTestActorId())

			const loopRows = await db
				.select({ id: objects.id })
				.from(objects)
				.where(and(eq(objects.workspaceId, ws.id), eq(objects.type, 'loop')))

			expect(loopRows).toHaveLength(4)
		})

		it('leaves three pre-existing workspaces byte-identical when a new workspace is seeded', async () => {
			// Create three workspaces with their own actor lists directly, bypassing
			// the seed path — these represent workspaces that existed before the T2
			// code path shipped.
			const preExistingIds: string[] = []
			const snapshots = new Map<string, string[]>()
			for (let i = 0; i < 3; i++) {
				const [ws] = await db
					.insert(workspacesTable)
					.values({ name: `Pre-existing ${i}`, createdBy: getTestActorId() })
					.returning()
				if (!ws) throw new Error('failed to insert pre-existing workspace')
				preExistingIds.push(ws.id)
				await db.insert(workspaceMembers).values({
					workspaceId: ws.id,
					actorId: getTestActorId(),
					role: 'owner',
				})
				// Attach a couple of arbitrary actors to make the snapshot non-trivial.
				for (let k = 0; k < 2; k++) {
					const extra = await insertActor(db, {
						name: `Legacy Actor ${i}-${k}`,
						email: `legacy-${i}-${k}@test.com`,
					})
					if (!extra) throw new Error('failed to insert legacy actor')
					await db.insert(workspaceMembers).values({
						workspaceId: ws.id,
						actorId: extra.id,
						role: 'member',
					})
				}
				snapshots.set(ws.id, await memberActorIdsFor(ws.id))
			}

			// Now create a fresh workspace via the route.
			const app = createApp()
			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Fresh Workspace' }),
			)
			expect(res.status).toBe(201)

			// Every pre-existing workspace's member list is byte-identical to its
			// snapshot — creating a new workspace didn't touch them.
			for (const id of preExistingIds) {
				const now = await memberActorIdsFor(id)
				expect(now).toEqual(snapshots.get(id))
			}
		})

		it('returns 500 naming the failed agent and rolls back workspace/member/actor rows when seeding fails on the 4th agent', async () => {
			// Agents seed in DEFAULT_AGENT_IDS order — Workspace Coach, Chief of
			// Staff, Driver, then Strategist. Each mints an API key first, so
			// throwing on the 4th generateApiKey() call fails strategist after
			// agents 1-3 are already written into the transaction. Everything —
			// including those three partial actor inserts — must roll back.
			const realGenerateApiKey = generateApiKeyMock.getMockImplementation()
			generateApiKeyMock
				.mockImplementationOnce(realGenerateApiKey)
				.mockImplementationOnce(realGenerateApiKey)
				.mockImplementationOnce(realGenerateApiKey)
				.mockImplementationOnce(() => {
					throw new Error('mock failure on 4th agent')
				})

			const workspacesBefore = await db.select({ id: workspacesTable.id }).from(workspacesTable)
			const membersBefore = await db
				.select({ actorId: workspaceMembers.actorId, workspaceId: workspaceMembers.workspaceId })
				.from(workspaceMembers)
			const actorsBefore = await db.select({ id: actors.id }).from(actors)

			const app = createApp()
			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'Should Rollback' }),
			)

			expect(res.status).toBe(500)
			const body = (await res.json()) as {
				error: { code: string; message: string; details?: { field: string; message: string }[] }
			}
			expect(body.error.code).toBe('INTERNAL_ERROR')
			expect(body.error.message).toContain('strategist')
			expect(body.error.details).toEqual(
				expect.arrayContaining([{ field: 'agent_id', message: 'strategist' }]),
			)

			// No workspace row, no member row, no actor row survived the aborted request.
			const workspacesAfter = await db.select({ id: workspacesTable.id }).from(workspacesTable)
			expect(workspacesAfter.length).toBe(workspacesBefore.length)

			const membersAfter = await db
				.select({ actorId: workspaceMembers.actorId, workspaceId: workspaceMembers.workspaceId })
				.from(workspaceMembers)
			expect(membersAfter.length).toBe(membersBefore.length)

			const actorsAfter = await db.select({ id: actors.id }).from(actors)
			expect(actorsAfter.length).toBe(actorsBefore.length)

			// PostHog `workspace_created` must NOT fire — the workspace never
			// committed. Emitting on the rollback path would poison the activation
			// cohort with phantom workspaces.
			expect(capturePosthogEventMock).not.toHaveBeenCalled()
		})

		it('emits the workspace_created PostHog event exactly once per successful creation with workspace_id in properties', async () => {
			const app = createApp()

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', { name: 'PostHog Emit' }),
			)
			expect(res.status).toBe(201)
			const ws = await res.json()

			expect(capturePosthogEventMock).toHaveBeenCalledOnce()
			const [event, distinctId, properties] = capturePosthogEventMock.mock.calls[0] as [
				string,
				string,
				Record<string, unknown>,
			]
			expect(event).toBe('workspace_created')
			expect(distinctId).toBe(ws.id)
			expect(properties.workspace_id).toBe(ws.id)
		})
	})

	describe('default chat agent', () => {
		async function chiefOfStaffIdFor(workspaceId: string): Promise<string | undefined> {
			const rows = await db
				.select({ actorId: actors.id, name: actors.name })
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(eq(workspaceMembers.workspaceId, workspaceId))
			return rows.find((r) => r.name === 'Chief of Staff')?.actorId
		}

		it('defaults a newly created workspace to its own Chief of Staff actor', async () => {
			const app = createApp()

			const res = await app.request(jsonRequest('POST', '/api/workspaces', { name: 'Default CoS' }))
			expect(res.status).toBe(201)
			const ws = await res.json()

			const chiefId = await chiefOfStaffIdFor(ws.id)
			expect(chiefId).toBeDefined()
			expect(ws.settings.default_agent_id).toBe(chiefId)
		})

		it('does not overwrite an explicit default_agent_id supplied at creation', async () => {
			const app = createApp()
			const explicitAgentId = randomUUID()

			const res = await app.request(
				jsonRequest('POST', '/api/workspaces', {
					name: 'Explicit Default',
					settings: { default_agent_id: explicitAgentId },
				}),
			)
			expect(res.status).toBe(201)
			const ws = await res.json()

			expect(ws.settings.default_agent_id).toBe(explicitAgentId)

			const [row] = await db
				.select({ settings: workspacesTable.settings })
				.from(workspacesTable)
				.where(eq(workspacesTable.id, ws.id))
			expect((row?.settings as { default_agent_id?: string })?.default_agent_id).toBe(
				explicitAgentId,
			)
		})
	})
})
