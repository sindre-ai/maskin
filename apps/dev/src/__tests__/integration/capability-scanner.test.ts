import { randomBytes } from 'node:crypto'
import {
	actors,
	agentGrants,
	events,
	integrations,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, asc, eq, inArray, like } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProbeFn, ProbeResult } from '../../lib/capabilities/probe'
import { encrypt } from '../../lib/crypto'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { getProvider } from '../../lib/integrations/registry'
import { integrationScopeGaps } from '../../lib/integrations/scope-drift'
import { CapabilityScanner } from '../../services/capability-scanner'
import { buildIntegration, insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The scan must be a pure server job: no model, no session. These spies stand
// in for the only two doors a model call or a session start could go through.
const spies = vi.hoisted(() => ({ createLLMAdapter: vi.fn(), startSession: vi.fn() }))
vi.mock('../../lib/llm', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/llm')>()),
	createLLMAdapter: spies.createLLMAdapter,
}))
vi.mock('../../services/session-lifecycle', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/session-lifecycle')>()),
	startSession: spies.startSession,
}))

// Stub probe harness: tests set the tool list each source answers with, or make
// it throw. Source keys are maskin:builtin and integration:slack:{id}.
type Answer = ProbeResult | Error

describe('CapabilityScanner (integration)', () => {
	let workspaceId: string
	let chiefOfStaffId: string
	let agentIds: string[]
	let slackIntegrationId: string
	let answers: Map<string, Answer>
	let probe: ProbeFn
	let previousFlagEnv: string | undefined
	let previousEncryptionKey: string | undefined

	const BUILTIN = 'maskin:builtin'
	const slackKey = () => `integration:slack:${slackIntegrationId}`

	function tools(map: Record<string, string>): ProbeResult {
		return { tools: map, specHash: null }
	}

	async function seedWorkspace(opts: { chiefOfStaff?: boolean } = {}) {
		const humanId = getTestActorId()
		const ws = await insertWorkspace(db, humanId)
		const ids: string[] = []
		let cos = ''
		if (opts.chiefOfStaff !== false) {
			const cosAgent = await insertActor(db, { type: 'agent', name: 'Chief of Staff' })
			await db.insert(workspaceMembers).values({
				workspaceId: ws.id,
				actorId: cosAgent.id,
				role: 'member',
			})
			cos = cosAgent.id
			ids.push(cosAgent.id)
		}
		for (const name of ['Sales Rep', 'Researcher']) {
			const agent = await insertActor(db, { type: 'agent', name })
			await db
				.insert(workspaceMembers)
				.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
			ids.push(agent.id)
		}
		const [slack] = await db
			.insert(integrations)
			.values(
				buildIntegration({
					workspaceId: ws.id,
					provider: 'slack',
					status: 'active',
					createdBy: humanId,
				}) as never,
			)
			.returning()
		return { workspaceId: ws.id, chiefOfStaffId: cos, agentIds: ids, slackId: slack.id }
	}

	/** A hand-added tool server on the workspace, granted to one agent. */
	async function addCustomServer(agentId: string) {
		const [custom] = await db
			.insert(integrations)
			.values(
				buildIntegration({
					workspaceId,
					provider: 'custom-mcp',
					status: 'active',
					createdBy: getTestActorId(),
					displayName: 'Hand-added server',
					defaultAgentAccess: 'none',
				}) as never,
			)
			.returning()
		await db.insert(agentGrants).values({
			workspaceId,
			integrationId: custom.id,
			actorId: agentId,
			access: 'read_write',
		})
	}

	function flagOn(id: string) {
		process.env.FF_WORKSPACE_FEATURES = `${id}:capability-scan`
		_resetFeatureFlagConfig()
	}

	function scanner() {
		return new CapabilityScanner(db, { probe })
	}

	async function eventsFor(action: string, ws = workspaceId) {
		return db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws), eq(events.action, action)))
			.orderBy(asc(events.id))
	}

	async function capabilityEventCount(ws = workspaceId) {
		const rows = await db
			.select({ id: events.id })
			.from(events)
			.where(and(eq(events.workspaceId, ws), like(events.action, 'capability_%')))
		return rows.length
	}

	beforeEach(async () => {
		previousFlagEnv = process.env.FF_WORKSPACE_FEATURES
		previousEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY
		process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString('hex')
		spies.createLLMAdapter.mockClear()
		spies.startSession.mockClear()
		const seeded = await seedWorkspace()
		workspaceId = seeded.workspaceId
		chiefOfStaffId = seeded.chiefOfStaffId
		agentIds = seeded.agentIds
		slackIntegrationId = seeded.slackId
		flagOn(workspaceId)
		answers = new Map<string, Answer>([
			[BUILTIN, tools({ create_objects: 'h-create', get_objects: 'h-get' })],
			[slackKey(), tools({ slack_send_message: 'h-send' })],
		])
		probe = vi.fn(async (_db, _ws, source) => {
			const answer = answers.get(source.key)
			if (!answer) throw new Error(`no stub for ${source.key}`)
			if (answer instanceof Error) throw answer
			return answer
		})
	})

	afterEach(() => {
		process.env.FF_WORKSPACE_FEATURES = previousFlagEnv ?? undefined
		process.env.INTEGRATION_ENCRYPTION_KEY = previousEncryptionKey ?? undefined
		_resetFeatureFlagConfig()
	})

	it('tick 1 writes a baseline and no findings', async () => {
		const result = await scanner().scanWorkspace(workspaceId)
		expect(result).toEqual({ status: 'scanned', mode: 'baseline', findingsWritten: 0 })

		const snapshots = await eventsFor('capability_snapshot')
		expect(snapshots.map((e) => (e.data as { source: string }).source).sort()).toEqual(
			[BUILTIN, slackKey()].sort(),
		)
		expect(await eventsFor('capability_changed')).toHaveLength(0)

		const [scan] = await eventsFor('capability_scan_completed')
		expect(scan.actorId).toBe(chiefOfStaffId)
		expect(scan.entityType).toBe('workspace')
		expect(scan.entityId).toBe(workspaceId)
		expect(scan.data).toMatchObject({
			workspace_id: workspaceId,
			mode: 'baseline',
			sources_total: 2,
			sources_failed: 0,
			unscanned_servers: 0,
			tools_total: 3,
			tools_added: 0,
			tools_removed: 0,
			schema_changed: 0,
			findings_eligible: 0,
			model_calls: 0,
		})
		expect(typeof (scan.data as { duration_ms: number }).duration_ms).toBe('number')
	})

	it('snapshots hold names and hashes only, written as Chief of Staff', async () => {
		await scanner().scanWorkspace(workspaceId)
		const [builtin] = (await eventsFor('capability_snapshot')).filter(
			(e) => (e.data as { source: string }).source === BUILTIN,
		)
		expect(builtin.actorId).toBe(chiefOfStaffId)
		expect(builtin.entityType).toBe('capability_source')
		expect(builtin.entityId).toBe(workspaceId)
		expect(builtin.data).toEqual({
			v: 1,
			source: BUILTIN,
			scanned_at: expect.any(String),
			tools: { create_objects: 'h-create', get_objects: 'h-get' },
			spec_hash: null,
			removed: {},
		})
	})

	it('tick 2 with no change writes only the scan event', async () => {
		await scanner().scanWorkspace(workspaceId)
		const before = await capabilityEventCount()
		const result = await scanner().scanWorkspace(workspaceId)
		expect(result).toEqual({ status: 'scanned', mode: 'diff', findingsWritten: 0 })
		expect(await capabilityEventCount()).toBe(before + 1)
		expect(await eventsFor('capability_scan_completed')).toHaveLength(2)
		expect(await eventsFor('capability_snapshot')).toHaveLength(2)
	})

	it('tick 3 with one new tool writes one snapshot and one finding with the right holders', async () => {
		await scanner().scanWorkspace(workspaceId)
		answers.set(
			BUILTIN,
			tools({ create_objects: 'h-create', get_objects: 'h-get', send_chat: 'h-chat' }),
		)
		const result = await scanner().scanWorkspace(workspaceId)
		expect(result).toEqual({ status: 'scanned', mode: 'diff', findingsWritten: 1 })

		const builtinSnapshots = (await eventsFor('capability_snapshot')).filter(
			(e) => (e.data as { source: string }).source === BUILTIN,
		)
		expect(builtinSnapshots).toHaveLength(2)
		const newest = builtinSnapshots[1]

		const changed = await eventsFor('capability_changed')
		expect(changed).toHaveLength(1)
		expect(changed[0].actorId).toBe(chiefOfStaffId)
		expect(changed[0].entityType).toBe('capability_source')
		expect(changed[0].entityId).toBe(workspaceId)
		expect(changed[0].data).toEqual({
			source: BUILTIN,
			kind: 'tool_added',
			tools: ['send_chat'],
			holders: [...agentIds].sort(),
			dedupe_key: expect.stringMatching(/^[0-9a-f]{64}$/),
			snapshot_event_id: newest.id,
		})

		const scans = await eventsFor('capability_scan_completed')
		expect(scans[1].data).toMatchObject({
			mode: 'diff',
			tools_added: 1,
			findings_eligible: 1,
			tools_total: 4,
		})
	})

	it('a tool added to a source nobody holds is stored and never flagged', async () => {
		// google-meet declares a server; with the workspace default off and no grant, no agent can use it.
		const humanId = getTestActorId()
		const [meet] = await db
			.insert(integrations)
			.values(
				buildIntegration({
					workspaceId,
					provider: 'google-meet',
					status: 'active',
					createdBy: humanId,
					defaultAgentAccess: 'none',
				}) as never,
			)
			.returning()
		const meetKey = `integration:google-meet:${meet.id}`
		answers.set(meetKey, tools({ meet_list: 'h1' }))
		await scanner().scanWorkspace(workspaceId)

		answers.set(meetKey, tools({ meet_list: 'h1', meet_new: 'h2' }))
		const result = await scanner().scanWorkspace(workspaceId)
		expect(result).toMatchObject({ status: 'scanned', findingsWritten: 0 })
		// The only finding is the connection-level one from the first scan: the new
		// tool itself is stored and never flagged.
		const changed = await eventsFor('capability_changed')
		expect(changed.map((e) => (e.data as { kind: string }).kind)).toEqual([
			'available_not_attached',
		])
		const meetSnapshots = (await eventsFor('capability_snapshot')).filter(
			(e) => (e.data as { source: string }).source === meetKey,
		)
		expect(meetSnapshots).toHaveLength(2)
		expect((meetSnapshots[1].data as { tools: Record<string, string> }).tools).toHaveProperty(
			'meet_new',
		)
	})

	it('a throwing probe leaves the snapshot alone and is never a removal', async () => {
		await scanner().scanWorkspace(workspaceId)
		answers.set(BUILTIN, new Error('boom'))
		const result = await scanner().scanWorkspace(workspaceId)
		expect(result).toMatchObject({ status: 'scanned', findingsWritten: 0 })

		const builtinSnapshots = (await eventsFor('capability_snapshot')).filter(
			(e) => (e.data as { source: string }).source === BUILTIN,
		)
		expect(builtinSnapshots).toHaveLength(1)
		expect(await eventsFor('capability_changed')).toHaveLength(0)
		expect(await eventsFor('capability_probe_missed')).toHaveLength(1)
		const scans = await eventsFor('capability_scan_completed')
		expect(scans[1].data).toMatchObject({ sources_failed: 1, tools_removed: 0 })

		// The tool list comes back unchanged: nothing was removed, nothing is new.
		answers.set(BUILTIN, tools({ create_objects: 'h-create', get_objects: 'h-get' }))
		await scanner().scanWorkspace(workspaceId)
		expect(await eventsFor('capability_changed')).toHaveLength(0)
		expect(await eventsFor('capability_probe_recovered')).toHaveLength(1)
	})

	it('reports source_unreachable once, after three failures in a row', async () => {
		await scanner().scanWorkspace(workspaceId)
		answers.set(BUILTIN, new Error('down'))
		for (let i = 0; i < 4; i++) await scanner().scanWorkspace(workspaceId)
		const changed = await eventsFor('capability_changed')
		expect(changed).toHaveLength(1)
		expect(changed[0].data).toMatchObject({ source: BUILTIN, kind: 'source_unreachable' })
		expect(await eventsFor('capability_probe_missed')).toHaveLength(4)
	})

	it('two concurrent ticks produce exactly one snapshot per source', async () => {
		const results = await Promise.all([
			scanner().scanWorkspace(workspaceId),
			scanner().scanWorkspace(workspaceId),
		])
		expect(results.filter((r) => r.status === 'scanned').length).toBeGreaterThanOrEqual(1)
		const snapshots = await eventsFor('capability_snapshot')
		expect(snapshots).toHaveLength(2)
		const sourcesSeen = snapshots.map((e) => (e.data as { source: string }).source).sort()
		expect(sourcesSeen).toEqual([BUILTIN, slackKey()].sort())
		expect(await eventsFor('capability_changed')).toHaveLength(0)
	})

	it('flag off: no scanner work and no capability event', async () => {
		process.env.FF_WORKSPACE_FEATURES = ''
		_resetFeatureFlagConfig()
		const result = await scanner().scanWorkspace(workspaceId)
		expect(result).toEqual({ status: 'skipped', reason: 'flag_off' })
		await scanner().tick()
		expect(probe).not.toHaveBeenCalled()
		expect(await capabilityEventCount()).toBe(0)
	})

	it('a workspace without a Chief of Staff is skipped', async () => {
		const bare = await seedWorkspace({ chiefOfStaff: false })
		flagOn(bare.workspaceId)
		const result = await scanner().scanWorkspace(bare.workspaceId)
		expect(result).toEqual({ status: 'skipped', reason: 'no_chief_of_staff' })
		expect(await capabilityEventCount(bare.workspaceId)).toBe(0)
	})

	it('the boot tick skips a workspace scanned within the last 20 hours', async () => {
		const first = await scanner().scanWorkspace(workspaceId, { boot: true })
		expect(first.status).toBe('scanned')
		const second = await scanner().scanWorkspace(workspaceId, { boot: true })
		expect(second).toEqual({ status: 'skipped', reason: 'recent_scan' })
		expect(await eventsFor('capability_scan_completed')).toHaveLength(1)
		// The daily tick is not a boot tick and always scans.
		const daily = await scanner().scanWorkspace(workspaceId)
		expect(daily.status).toBe('scanned')
	})

	it('tick() only processes workspaces with the flag on', async () => {
		const other = await seedWorkspace()
		await scanner().tick()
		expect(await eventsFor('capability_scan_completed')).toHaveLength(1)
		expect(await capabilityEventCount(other.workspaceId)).toBe(0)
	})

	it('a full tick starts no session and makes no model call', async () => {
		await scanner().scanWorkspace(workspaceId)
		answers.set(BUILTIN, tools({ create_objects: 'h-create', brand_new: 'h-new' }))
		await scanner().scanWorkspace(workspaceId)
		await scanner().tick()

		expect(spies.createLLMAdapter).not.toHaveBeenCalled()
		expect(spies.startSession).not.toHaveBeenCalled()
		const rows = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.workspaceId, workspaceId))
		expect(rows).toHaveLength(0)
	})

	it('suggesting is not granting: agent tools and integrations are unchanged by a full tick', async () => {
		// Give one agent a grant on a hand-added server so the config is non-trivial.
		await addCustomServer(agentIds[1])

		const snapshotOf = async () => ({
			actorTools: await db
				.select({ id: actors.id, tools: actors.tools })
				.from(actors)
				.where(inArray(actors.id, agentIds))
				.orderBy(asc(actors.id)),
			integrations: await db
				.select()
				.from(integrations)
				.where(eq(integrations.workspaceId, workspaceId))
				.orderBy(asc(integrations.id)),
			grants: await db
				.select()
				.from(agentGrants)
				.where(eq(agentGrants.workspaceId, workspaceId))
				.orderBy(asc(agentGrants.id)),
		})

		const before = JSON.stringify(await snapshotOf())
		await scanner().scanWorkspace(workspaceId)
		answers.set(BUILTIN, tools({ create_objects: 'h-create', brand_new: 'h-new' }))
		await scanner().scanWorkspace(workspaceId)
		expect(JSON.stringify(await snapshotOf())).toBe(before)
	})

	describe('connection-level findings', () => {
		const credentialsOf = (scope: string) => encrypt(JSON.stringify({ scope }))

		async function insertGmail() {
			const [gmail] = await db
				.insert(integrations)
				.values(
					buildIntegration({
						workspaceId,
						provider: 'gmail',
						status: 'active',
						createdBy: getTestActorId(),
						defaultAgentAccess: 'none',
					}) as never,
				)
				.returning()
			// Gmail is a probed source too: answer it so only the connection-level finding appears.
			answers.set(`integration:gmail:${gmail.id}`, tools({ gmail_send: 'h-gs' }))
			return gmail
		}

		it('writes needs_reconnect and available_not_attached once each, and changes nothing else', async () => {
			const gmail = await insertGmail()
			const gmailKey = `integration:gmail:${gmail.id}`
			// Slack is auto-injected, so every agent holds it; its token predates most of today's scopes.
			await db
				.update(integrations)
				.set({ credentials: credentialsOf('chat:write') })
				.where(eq(integrations.id, slackIntegrationId))
			const missing = integrationScopeGaps(getProvider('slack').config, {
				scope: 'chat:write',
			}).missing
			expect(missing.length).toBeGreaterThan(0)

			const snapshotOf = async () => ({
				actorTools: await db
					.select({ id: actors.id, tools: actors.tools })
					.from(actors)
					.where(inArray(actors.id, agentIds))
					.orderBy(asc(actors.id)),
				integrations: await db
					.select()
					.from(integrations)
					.where(eq(integrations.workspaceId, workspaceId))
					.orderBy(asc(integrations.id)),
			})
			const before = JSON.stringify(await snapshotOf())

			// Tick 1: baseline. Gmail declares a server, its default is off and nobody holds it.
			const first = await scanner().scanWorkspace(workspaceId)
			expect(first).toEqual({ status: 'scanned', mode: 'baseline', findingsWritten: 1 })

			// Tick 2: Slack gains a tool the stored token cannot use yet.
			answers.set(slackKey(), tools({ slack_send_message: 'h-send', slack_search: 'h-search' }))
			const second = await scanner().scanWorkspace(workspaceId)
			expect(second).toEqual({ status: 'scanned', mode: 'diff', findingsWritten: 1 })

			// Tick 3: nothing changed, so nothing new, including the unattached gmail.
			const third = await scanner().scanWorkspace(workspaceId)
			expect(third).toEqual({ status: 'scanned', mode: 'diff', findingsWritten: 0 })

			const changed = await eventsFor('capability_changed')
			expect(changed).toHaveLength(2)
			const [notAttached, needsReconnect] = changed
			const slackSnapshots = (await eventsFor('capability_snapshot')).filter(
				(e) => (e.data as { source: string }).source === slackKey(),
			)

			expect(notAttached.actorId).toBe(chiefOfStaffId)
			expect(notAttached.entityType).toBe('capability_source')
			expect(notAttached.entityId).toBe(gmail.id)
			expect(notAttached.data).toEqual({
				source: gmailKey,
				kind: 'available_not_attached',
				tools: [],
				holders: [],
				dedupe_key: expect.stringMatching(/^[0-9a-f]{64}$/),
				snapshot_event_id: null,
				provider: 'gmail',
			})

			expect(needsReconnect.actorId).toBe(chiefOfStaffId)
			expect(needsReconnect.entityId).toBe(slackIntegrationId)
			expect(needsReconnect.data).toEqual({
				source: slackKey(),
				kind: 'needs_reconnect',
				tools: ['slack_search'],
				holders: [...agentIds].sort(),
				dedupe_key: expect.stringMatching(/^[0-9a-f]{64}$/),
				snapshot_event_id: slackSnapshots[slackSnapshots.length - 1].id,
				provider: 'slack',
				missing_scopes: missing,
			})

			const scans = await eventsFor('capability_scan_completed')
			const eligible = scans.map((e) => (e.data as Record<string, number>).findings_eligible)
			expect(eligible).toEqual([1, 1, 0])

			expect(spies.createLLMAdapter).not.toHaveBeenCalled()
			expect(spies.startSession).not.toHaveBeenCalled()
			const sessionRows = await db
				.select({ id: sessions.id })
				.from(sessions)
				.where(eq(sessions.workspaceId, workspaceId))
			expect(sessionRows).toHaveLength(0)
			expect(JSON.stringify(await snapshotOf())).toBe(before)
		})

		it('a token with every required scope stays tool_added, and an attached gmail is not reported', async () => {
			const gmail = await insertGmail()
			const slackAuth = getProvider('slack').config.auth
			if (slackAuth.type !== 'oauth2') throw new Error('slack is expected to be oauth2')
			const everyScope = JSON.stringify({
				scope: slackAuth.config.scopes.join(','),
				userScope: slackAuth.config.extraAuthParams?.user_scope,
			})
			await db
				.update(integrations)
				.set({ credentials: encrypt(everyScope) })
				.where(eq(integrations.id, slackIntegrationId))
			// One agent is granted Gmail.
			await db.insert(agentGrants).values({
				workspaceId,
				integrationId: gmail.id,
				actorId: agentIds[1],
				access: 'read',
			})

			await scanner().scanWorkspace(workspaceId)
			answers.set(slackKey(), tools({ slack_send_message: 'h-send', slack_search: 'h-search' }))
			await scanner().scanWorkspace(workspaceId)

			const changed = await eventsFor('capability_changed')
			expect(changed.map((e) => (e.data as { kind: string }).kind)).toEqual(['tool_added'])
			expect(changed.some((e) => e.entityId === gmail.id)).toBe(false)
		})
	})

	it('counts hand-added servers no provider covers as unscanned_servers', async () => {
		await addCustomServer(agentIds[1])
		await scanner().scanWorkspace(workspaceId)
		const [scan] = await eventsFor('capability_scan_completed')
		expect(scan.data).toMatchObject({ unscanned_servers: 1 })
	})
})
