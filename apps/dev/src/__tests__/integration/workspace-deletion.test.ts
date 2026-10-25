import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import {
	events,
	actors,
	agentFiles,
	fileComments,
	files,
	installedLoops,
	marketplaceLoops,
	messages,
	notifications,
	objects,
	relationships,
	sessionLogs,
	sessions,
	subscriptions,
	webhookDeliveries,
	workspaceCreditLedger,
	workspaceMembers,
	workspaceSkills,
	workspaces,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, inArray } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKSPACE_PURGE_CASCADE, WORKSPACE_PURGE_EXPLICIT } from '../../lib/workspace-purge'
import {
	insertActor,
	insertConversation,
	insertNotification,
	insertObject,
	insertRelationship,
	insertSession,
	insertSessionLog,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, sql } from './global-setup'

const { default: workspaceRoutes } = await import('../../routes/workspaces')

type Actor = Awaited<ReturnType<typeof insertActor>>

function fakeStorage(keys: string[] = []): StorageProvider & { deleted: string[] } {
	const deleted: string[] = []
	return {
		deleted,
		put: vi.fn(),
		get: vi.fn(),
		exists: vi.fn(),
		ensureBucket: vi.fn(),
		listWithMetadata: vi.fn(),
		list: vi.fn(async (prefix: string) => keys.filter((k) => k.startsWith(prefix))),
		delete: vi.fn(async (key: string) => {
			deleted.push(key)
		}),
	}
}

function appFor(
	actorId: string,
	actorType = 'human',
	storageProvider?: StorageProvider,
	sessionManager?: unknown,
) {
	const a = new OpenAPIHono()
	a.use('*', async (c, next) => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal context for the route under test
		const ctx = c as any
		ctx.set('db', db)
		ctx.set('actorId', actorId)
		ctx.set('actorType', actorType)
		if (storageProvider) ctx.set('storageProvider', storageProvider)
		if (sessionManager) ctx.set('sessionManager', sessionManager)
		await next()
	})
	a.route('/api/workspaces', workspaceRoutes)
	return a
}

/** Every table that has a column naming a workspace (FK or not), found from the catalog. */
async function workspaceKeyedColumns(): Promise<{ table: string; column: string }[]> {
	const rows = await sql<{ table: string; column: string }[]>`
		SELECT table_name AS "table", column_name AS "column"
		FROM information_schema.columns
		WHERE table_schema = 'public' AND column_name IN ('workspace_id', 'default_workspace_id')
		ORDER BY 1`
	return [...rows]
}

async function countRows(table: string, column: string, workspaceId: string): Promise<number> {
	const [row] = await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = $1`,
		[workspaceId],
	)
	return (row as { n: number }).n
}

/** Puts at least one row in every kind of table the purge has to reach. */
async function seedWorkspace(owner: Actor, opts: { name?: string; settings?: unknown } = {}) {
	const ws = await insertWorkspace(db, owner.id, {
		name: opts.name ?? `WS ${randomUUID().slice(0, 8)}`,
		...(opts.settings ? { settings: opts.settings } : {}),
	})
	const agent = await insertActor(db, { type: 'agent', name: 'Seed agent', systemPrompt: 'secret' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })

	const a = await insertObject(db, ws.id, owner.id, { type: 'bet', title: 'A' })
	const b = await insertObject(db, ws.id, owner.id, { type: 'task', title: 'B' })
	await insertRelationship(db, owner.id, {
		sourceId: a.id,
		sourceType: 'object',
		targetId: b.id,
		targetType: 'object',
	})

	const trigger = await insertTrigger(db, ws.id, owner.id, agent.id)
	const first = await insertSession(db, ws.id, agent.id, owner.id, {
		status: 'completed',
		triggerId: trigger.id,
		initiatedFromObjectId: a.id,
		snapshotPath: `session-workspaces/${randomUUID()}.tar.gz`,
	})
	// Self-referencing retry chain: NO ACTION FKs between rows deleted in the same statement.
	const retry = await insertSession(db, ws.id, agent.id, owner.id, {
		status: 'completed',
		retryOf: first.id,
	})
	await db.update(sessions).set({ retriedSessionId: retry.id }).where(eq(sessions.id, first.id))
	await insertSessionLog(db, first.id)

	const convo = await insertConversation(db, ws.id, owner.id)
	await db
		.insert(messages)
		.values({ conversationId: convo.id, actorId: owner.id, content: 'hi', sessionId: first.id })

	await insertNotification(db, ws.id, owner.id, {
		targetActorId: owner.id,
		objectId: a.id,
		sessionId: first.id,
	})
	await db.insert(subscriptions).values({
		workspaceId: ws.id,
		actorId: owner.id,
		entityType: 'object',
		entityId: a.id,
		source: 'manual',
	})
	await db.insert(events).values({
		workspaceId: ws.id,
		actorId: owner.id,
		action: 'created',
		entityType: 'object',
		entityId: a.id,
	})
	await db.insert(webhookDeliveries).values({
		provider: 'slack',
		externalId: randomUUID(),
		workspaceId: ws.id,
	})
	await sql`
		INSERT INTO linkedin_actions (workspace_id, integration_id, actor_id, tool, kind, outcome)
		VALUES (${ws.id}, ${randomUUID()}, ${agent.id}, 'get_profile', 'read', 'ok')`
	await db.insert(workspaceCreditLedger).values({
		workspaceId: ws.id,
		type: 'topup',
		amountCents: 100,
		balanceAfterCents: 100,
		sessionId: first.id,
	})

	const fileKey = `files/${ws.id}/${randomUUID()}`
	const [file] = await db
		.insert(files)
		.values({
			workspaceId: ws.id,
			name: 'doc.md',
			mimeType: 'text/markdown',
			sizeBytes: 3,
			storageKey: fileKey,
			createdBy: owner.id,
		})
		.returning()
	await insertRelationship(db, owner.id, {
		sourceId: a.id,
		sourceType: 'object',
		targetId: file?.id as string,
		targetType: 'file',
		type: 'references',
	})
	await db.insert(fileComments).values({
		fileId: file?.id as string,
		positionDoc: {},
		authorId: owner.id,
		body: 'note',
	})
	await db.insert(workspaceSkills).values({
		workspaceId: ws.id,
		name: `skill-${randomUUID().slice(0, 6)}`,
		content: 'x',
		storageKey: `workspaces/${ws.id}/skills/s/SKILL.md`,
		sizeBytes: 1,
	})
	await db.insert(agentFiles).values({
		actorId: agent.id,
		workspaceId: ws.id,
		fileType: 'memory',
		path: 'm.md',
		storageKey: `agents/${ws.id}/${agent.id}/m.md`,
	})

	// installed_loops -> objects is NO ACTION, so objects cannot go first.
	const [loop] = await db
		.insert(marketplaceLoops)
		.values({ name: 'Loop', slug: `loop-${randomUUID()}`, description: 'd', version: '1' })
		.returning()
	await db.insert(installedLoops).values({
		workspaceId: ws.id,
		sourceLoopId: loop?.id as string,
		installedVersion: '1',
		objectId: a.id,
	})

	// The Keychain audit trail: an insert-only log and an append-only snapshot table (a trigger
	// rejects DELETE on it). Deleting the workspace has to remove both.
	await sql`
		INSERT INTO credential_access_log (workspace_id, integration_id, actor_id, request_id)
		VALUES (${ws.id}, ${randomUUID()}, ${agent.id}, ${randomUUID()})`
	await sql`
		INSERT INTO credential_chain_snapshots (workspace_id, snapshot_date, max_id, row_hash)
		VALUES (${ws.id}, CURRENT_DATE, 1, 'h')`

	return { ws, agent, objectA: a, objectB: b, first, fileKey }
}

describe('workspace deletion (integration)', () => {
	let me: Actor
	let app: OpenAPIHono

	beforeEach(async () => {
		me = await insertActor(db, { type: 'human' })
		app = appFor(me.id)
	})

	const del = (id: string, confirm_name: string, a = app) =>
		a.request(jsonRequest('POST', `/api/workspaces/${id}/delete`, { confirm_name }))

	describe('guard: the purge knows every table that hangs off a workspace', () => {
		it('covers every NO ACTION/RESTRICT foreign key and every workspace column', async () => {
			const fks = await sql<{ child: string; parent: string; action: string; col: string }[]>`
				SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
					c.confdeltype AS action, a.attname AS col
				FROM pg_constraint c
				JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
				WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`

			// Everything reachable from workspaces by foreign keys that OWN the child. A SET NULL edge
			// (actors.default_workspace_id, slack_user_links.default_workspace_id) only unlinks a row
			// that outlives the workspace, so it must not drag that row's own children in: following
			// it would make every table that references actors look like workspace data.
			const reach = new Set(['workspaces'])
			for (let grew = true; grew; ) {
				grew = false
				for (const f of fks) {
					if (f.action === 'n') continue
					if (reach.has(f.parent) && !reach.has(f.child)) {
						reach.add(f.child)
						grew = true
					}
				}
			}

			const explicit = new Set<string>(WORKSPACE_PURGE_EXPLICIT)
			const cascade = new Set<string>(WORKSPACE_PURGE_CASCADE)
			const unhandled: string[] = []

			for (const f of fks) {
				if (!reach.has(f.parent)) continue
				const handled = explicit.has(f.child) || (f.action === 'c' && cascade.has(f.child))
				// SET NULL only unlinks a row that may belong to another workspace: nothing to purge.
				if (f.action === 'n') continue
				if (!handled) unhandled.push(`${f.child}.${f.col} -> ${f.parent} (${f.action})`)
			}

			// Columns that name a workspace without a foreign key at all.
			for (const { table, column } of await workspaceKeyedColumns()) {
				const hasFk = fks.some((f) => f.child === table && f.col === column)
				if (!hasFk && !explicit.has(table)) unhandled.push(`${table}.${column} (no FK)`)
			}

			expect(
				unhandled,
				'a table references workspaces (directly or through objects/sessions/…) but workspace-purge.ts does not handle it: add it to purgeWorkspace and to WORKSPACE_PURGE_EXPLICIT / WORKSPACE_PURGE_CASCADE',
			).toEqual([])

			// And the lists name real tables, so a rename cannot leave a stale entry behind.
			const tables = new Set(
				(
					await sql<{ t: string }[]>`
					SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`
				).map((r) => r.t),
			)
			for (const t of [...explicit, ...cascade]) expect(tables.has(t), `${t} exists`).toBe(true)
		})
	})

	it('purges every row of the workspace and leaves another workspace untouched', async () => {
		const other = await insertActor(db, { type: 'human' })
		const target = await seedWorkspace(me, { name: 'Doomed' })
		const bystander = await seedWorkspace(other, { name: 'Bystander' })

		// Cross-workspace links that must be severed, not left dangling or blocking the delete.
		await insertNotification(db, bystander.ws.id, other.id, {
			targetActorId: other.id,
			sessionId: target.first.id,
		})
		await insertRelationship(db, other.id, {
			sourceId: bystander.objectA.id,
			sourceType: 'object',
			targetId: target.objectA.id,
			targetType: 'object',
		})

		const keyed = await workspaceKeyedColumns()
		const before = new Map<string, number>()
		for (const { table, column } of keyed) {
			before.set(`${table}.${column}`, await countRows(table, column, bystander.ws.id))
		}
		const [targetMessagesBefore] = await sql`
			SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
			WHERE c.workspace_id = ${target.ws.id}`
		expect((targetMessagesBefore as { n: number }).n).toBe(1)

		const storage = fakeStorage([
			`agents/${target.ws.id}/${target.agent.id}/extra.md`,
			`workspaces/${target.ws.id}/skills/s/SKILL.md`,
			`agents/${bystander.ws.id}/${bystander.agent.id}/keep.md`,
		])
		const res = await del(target.ws.id, 'Doomed', appFor(me.id, 'human', storage))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ deleted: true })

		// Nothing keyed to the workspace remains, in any table.
		for (const { table, column } of keyed) {
			if (table === 'slack_user_links') continue
			expect(await countRows(table, column, target.ws.id), `${table}.${column}`).toBe(0)
		}
		expect(await db.select().from(workspaces).where(eq(workspaces.id, target.ws.id))).toEqual([])
		expect(
			await db.select().from(sessionLogs).where(eq(sessionLogs.sessionId, target.first.id)),
		).toEqual([])
		expect(
			await db
				.select()
				.from(relationships)
				.where(inArray(relationships.targetId, [target.objectA.id, target.objectB.id])),
		).toEqual([])
		expect(
			await sql`SELECT 1 FROM relationships WHERE source_id = ${target.objectA.id} OR target_id = ${target.objectA.id}`,
		).toHaveLength(0)
		expect(await db.select().from(objects).where(eq(objects.id, target.objectA.id))).toEqual([])
		expect(await db.select().from(sessions).where(eq(sessions.id, target.first.id))).toEqual([])

		// The other workspace is exactly as it was, including its own cross-links to deleted rows
		// being unlinked rather than removed.
		for (const { table, column } of keyed) {
			expect(await countRows(table, column, bystander.ws.id), `bystander ${table}.${column}`).toBe(
				before.get(`${table}.${column}`),
			)
		}
		const kept = await db
			.select()
			.from(notifications)
			.where(eq(notifications.workspaceId, bystander.ws.id))
		expect(kept.length).toBeGreaterThan(0)
		expect(kept.some((n) => n.sessionId === null)).toBe(true)

		// Storage: rows' keys plus anything under the workspace prefixes, never the neighbour's.
		expect(storage.deleted).toEqual(
			expect.arrayContaining([
				target.fileKey,
				`agents/${target.ws.id}/${target.agent.id}/extra.md`,
				`workspaces/${target.ws.id}/skills/s/SKILL.md`,
			]),
		)
		expect(storage.deleted.some((k) => k.includes(bystander.ws.id))).toBe(false)
	})

	it('leaves the audit-chain snapshots append-only outside a purge', async () => {
		const target = await seedWorkspace(me)
		await expect(
			sql`DELETE FROM credential_chain_snapshots WHERE workspace_id = ${target.ws.id}`,
		).rejects.toThrow(/append-only/)
	})

	it('keeps the people, and scrubs an agent that only lived in this workspace', async () => {
		const target = await seedWorkspace(me, { name: 'Agents' })
		const sharedAgent = await insertActor(db, { type: 'agent', systemPrompt: 'keep me' })
		const neighbour = await insertWorkspace(db, me.id)
		for (const wsId of [target.ws.id, neighbour.id]) {
			await db
				.insert(workspaceMembers)
				.values({ workspaceId: wsId, actorId: sharedAgent.id, role: 'member' })
		}
		const soleKey = target.agent.apiKey

		expect((await del(target.ws.id, 'Agents')).status).toBe(200)

		const [human] = await db.select().from(actors).where(eq(actors.id, me.id))
		expect(human?.apiKey).toBe(me.apiKey)

		const [scrubbed] = await db.select().from(actors).where(eq(actors.id, target.agent.id))
		expect(scrubbed?.name).toBe('Deleted agent')
		expect(scrubbed?.systemPrompt).toBeNull()
		expect(scrubbed?.apiKey).not.toBe(soleKey)

		const [shared] = await db.select().from(actors).where(eq(actors.id, sharedAgent.id))
		expect(shared?.systemPrompt).toBe('keep me')
		const memberships = await db
			.select()
			.from(workspaceMembers)
			.where(eq(workspaceMembers.actorId, sharedAgent.id))
		expect(memberships.map((m) => m.workspaceId)).toEqual([neighbour.id])
	})

	it('still deletes when the storage provider fails, since the rows are already gone', async () => {
		const target = await seedWorkspace(me, { name: 'Storage down' })
		const storage = fakeStorage()
		storage.delete = vi.fn(async () => {
			throw new Error('s3 down')
		})
		storage.list = vi.fn(async () => {
			throw new Error('s3 down')
		})
		const res = await del(target.ws.id, 'Storage down', appFor(me.id, 'human', storage))
		expect(res.status).toBe(200)
		expect(await db.select().from(workspaces).where(eq(workspaces.id, target.ws.id))).toEqual([])
	})

	it('refuses a name that is not exactly the workspace name and deletes nothing', async () => {
		const { ws } = await seedWorkspace(me, { name: 'Exact Name' })
		for (const wrong of ['exact name', 'Exact Name ', 'Other']) {
			const res = await del(ws.id, wrong)
			expect(res.status).toBe(400)
		}
		expect(await db.select().from(workspaces).where(eq(workspaces.id, ws.id))).toHaveLength(1)
		expect(await countRows('objects', 'workspace_id', ws.id)).toBeGreaterThan(0)
	})

	it('refuses a member who is not the billing owner', async () => {
		const { ws } = await seedWorkspace(me, { name: 'Not yours' })
		const member = await insertActor(db, { type: 'human' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: member.id, role: 'admin' })

		const res = await del(ws.id, 'Not yours', appFor(member.id))
		expect(res.status).toBe(403)
		expect(await db.select().from(workspaces).where(eq(workspaces.id, ws.id))).toHaveLength(1)
	})

	it('refuses a viewer even when they hold billing ownership', async () => {
		const { ws } = await seedWorkspace(me, { name: 'Read only' })
		await db
			.update(workspaceMembers)
			.set({ role: 'viewer' })
			.where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.actorId, me.id)))

		// The route throws ViewerReadOnlyError; app.onError turns it into a 403 in the real app.
		const withOnError = appFor(me.id)
		withOnError.onError((err, c) =>
			c.json({ error: err.message }, (err as { status?: number }).status === 403 ? 403 : 500),
		)
		const res = await del(ws.id, 'Read only', withOnError)
		expect(res.status).toBe(403)
		expect(await db.select().from(workspaces).where(eq(workspaces.id, ws.id))).toHaveLength(1)
	})

	it('refuses an agent key even for the billing owner row', async () => {
		const { ws } = await seedWorkspace(me, { name: 'Agent attempt' })
		const res = await del(ws.id, 'Agent attempt', appFor(me.id, 'agent'))
		expect(res.status).toBe(403)
		expect(await db.select().from(workspaces).where(eq(workspaces.id, ws.id))).toHaveLength(1)
	})

	it('returns 404 to someone who is not a member, without revealing the workspace', async () => {
		const { ws } = await seedWorkspace(me, { name: 'Private' })
		const stranger = await insertActor(db, { type: 'human' })
		const res = await del(ws.id, 'Private', appFor(stranger.id))
		expect(res.status).toBe(404)
		const preview = await appFor(stranger.id).request(
			jsonGet(`/api/workspaces/${ws.id}/deletion-preview`),
		)
		expect(preview.status).toBe(404)
		expect(await db.select().from(workspaces).where(eq(workspaces.id, ws.id))).toHaveLength(1)
	})

	it('is blocked while a plan is live, and allowed once it is cancelled', async () => {
		const { ws } = await seedWorkspace(me, {
			name: 'Paid',
			settings: { billing: { plan: 'pro', stripe_subscription_id: 'sub_1', status: 'active' } },
		})
		const blocked = await del(ws.id, 'Paid')
		expect(blocked.status).toBe(409)
		expect(await db.select().from(workspaces).where(eq(workspaces.id, ws.id))).toHaveLength(1)

		await db
			.update(workspaces)
			.set({
				settings: { billing: { plan: 'pro', stripe_subscription_id: 'sub_1', status: 'canceled' } },
			})
			.where(eq(workspaces.id, ws.id))
		expect((await del(ws.id, 'Paid')).status).toBe(200)
	})

	it('treats a dead incomplete_expired subscription as not blocking, and unpaid as blocking', async () => {
		const billing = (status: string) => ({
			billing: { plan: 'pro', stripe_subscription_id: 'sub_1', status },
		})
		const { ws } = await seedWorkspace(me, { name: 'Dead plan', settings: billing('unpaid') })
		expect((await del(ws.id, 'Dead plan')).status).toBe(409)
		await db
			.update(workspaces)
			.set({ settings: billing('incomplete_expired') })
			.where(eq(workspaces.id, ws.id))
		expect((await del(ws.id, 'Dead plan')).status).toBe(200)
	})

	it('stops the sandboxes of unfinished sessions after commit, and only those', async () => {
		const { ws, agent } = await seedWorkspace(me, { name: 'Live sessions' })
		const live = await insertSession(db, ws.id, agent.id, me.id, { status: 'running' })
		await db.update(sessions).set({ containerId: 'container-live' }).where(eq(sessions.id, live.id))
		const noSandbox = await insertSession(db, ws.id, agent.id, me.id, { status: 'running' })
		await db.update(sessions).set({ containerId: null }).where(eq(sessions.id, noSandbox.id))
		const done = await insertSession(db, ws.id, agent.id, me.id, { status: 'completed' })
		await db.update(sessions).set({ containerId: 'container-done' }).where(eq(sessions.id, done.id))

		// A session in another workspace must never be touched.
		const other = await seedWorkspace(me, { name: 'Other' })
		const otherLive = await insertSession(db, other.ws.id, other.agent.id, me.id, {
			status: 'running',
		})
		await db
			.update(sessions)
			.set({ containerId: 'container-other' })
			.where(eq(sessions.id, otherLive.id))

		const stopped: { id: string; containerId: string | null }[] = []
		const stopper = {
			stopSandboxesForPurge: vi.fn(async (rows: typeof stopped) => {
				// The rows are already gone when this runs: the purge committed first.
				expect(await db.select().from(sessions).where(eq(sessions.id, live.id))).toEqual([])
				stopped.push(...rows)
			}),
		}
		const res = await del(ws.id, 'Live sessions', appFor(me.id, 'human', undefined, stopper))
		expect(res.status).toBe(200)
		expect(stopped.map((r) => r.id)).toEqual([live.id])
		expect(stopped[0]?.containerId).toBe('container-live')
		expect(stopped.some((r) => r.id === noSandbox.id || r.id === otherLive.id)).toBe(false)
		expect(await db.select().from(sessions).where(eq(sessions.id, otherLive.id))).toHaveLength(1)
	})

	it('still answers 200 when stopping the sandboxes throws', async () => {
		const { ws, agent } = await seedWorkspace(me, { name: 'Stop fails' })
		const live = await insertSession(db, ws.id, agent.id, me.id, { status: 'running' })
		await db.update(sessions).set({ containerId: 'c' }).where(eq(sessions.id, live.id))
		const stopper = {
			stopSandboxesForPurge: vi.fn(async () => {
				throw new Error('docker down')
			}),
		}
		const res = await del(ws.id, 'Stop fails', appFor(me.id, 'human', undefined, stopper))
		expect(res.status).toBe(200)
		expect(stopper.stopSandboxesForPurge).toHaveBeenCalled()
	})

	it('previews who loses access and what blocks deletion', async () => {
		const { ws } = await seedWorkspace(me, { name: 'Preview' })
		const colleague = await insertActor(db, { type: 'human' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws.id, actorId: colleague.id, role: 'member' })

		const own = await app.request(jsonGet(`/api/workspaces/${ws.id}/deletion-preview`))
		expect(own.status).toBe(200)
		expect(await own.json()).toEqual({
			workspace_id: ws.id,
			workspace_name: 'Preview',
			can_delete: true,
			blockers: [],
			other_members: 1,
		})

		const theirs = await appFor(colleague.id).request(
			jsonGet(`/api/workspaces/${ws.id}/deletion-preview`),
		)
		const body = (await theirs.json()) as { can_delete: boolean; blockers: { code: string }[] }
		expect(body.can_delete).toBe(false)
		expect(body.blockers.map((b) => b.code)).toEqual(['not_billing_owner'])
	})

	it('is gone afterwards: a second delete is a 404 and the name is free again', async () => {
		const { ws } = await seedWorkspace(me, { name: 'Once' })
		expect((await del(ws.id, 'Once')).status).toBe(200)
		expect((await del(ws.id, 'Once')).status).toBe(404)
		const again = await insertWorkspace(db, me.id, { name: 'Once' })
		expect(again.name).toBe('Once')
	})

	it('erases the Keychain audit trail with the workspace, but only through the cascade', async () => {
		const other = await insertActor(db, { type: 'human' })
		const target = await seedWorkspace(me, { name: 'Audited' })
		const bystander = await seedWorkspace(other, { name: 'Audited bystander' })

		for (const ws of [target.ws, bystander.ws]) {
			// The insert trigger assigns id/hashes/read_at; the log has no FK on actor or integration.
			await sql`
				INSERT INTO credential_access_log (workspace_id, integration_id, actor_id, request_id)
				VALUES (${ws.id}, ${randomUUID()}, ${me.id}, 'req-1')`
			await sql`
				INSERT INTO credential_chain_snapshots (workspace_id, snapshot_date, max_id, row_hash)
				VALUES (${ws.id}, '2026-01-01', 1, 'hash')`
		}

		// The snapshot table is still append-only for anything that is not the workspace cascade.
		await expect(
			sql`DELETE FROM credential_chain_snapshots WHERE workspace_id = ${target.ws.id}`,
		).rejects.toThrow(/append-only/)
		await expect(
			sql`UPDATE credential_chain_snapshots SET row_hash = 'x' WHERE workspace_id = ${target.ws.id}`,
		).rejects.toThrow(/append-only/)

		expect((await del(target.ws.id, 'Audited')).status).toBe(200)

		for (const table of ['credential_access_log', 'credential_chain_snapshots']) {
			const rows = await sql.unsafe(`SELECT workspace_id FROM ${table}`)
			// seedWorkspace gives every workspace a row of its own, so the bystander keeps more than one.
			expect(rows.length, table).toBeGreaterThan(0)
			expect(new Set(rows.map((r) => r.workspace_id)), table).toEqual(new Set([bystander.ws.id]))
		}
	})
})
