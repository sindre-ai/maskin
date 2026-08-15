// Snapshot-consistent cursor pagination — per-resource proof for the five
// list tools T3.1 extends the pattern to. Mirrors the shape of the T3
// `cursor pagination — snapshot consistency (AC-T3)` block in
// `objects.test.ts`: seed rows with strictly increasing `createdAt`, page 1
// under a snapshot, SQL-insert a row past the snapshot boundary, page 2 via
// keyset + same snapshot, assert no skip and no duplicate against the
// snapshot taken at first call.

import {
	files,
	relationships,
	triggers,
	workspaceMembers,
	workspaceSkills,
} from '@maskin/db/schema'
import {
	buildFile,
	buildRelationship,
	buildTrigger,
	buildWorkspaceSkill,
	insertActor,
	insertObject,
	insertWorkspace,
} from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: relationshipsRoutes } = await import('../../routes/relationships')
const { default: triggersRoutes } = await import('../../routes/triggers')
const { default: filesRoutes } = await import('../../routes/files')
const { default: workspaceSkillsRoutes } = await import('../../routes/workspace-skills')

describe('Cursor pagination — snapshot consistency (AC-T3, T3.1 follow-up)', () => {
	describe('list_actors', () => {
		it('excludes a mid-pagination insert from the same walk', async () => {
			const app = createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
			const ws = await insertWorkspace(db, getTestActorId())

			// Seed 6 workspace members with strictly increasing createdAt.
			// The workspace-scoped path sorts by (createdAt desc, id asc) when
			// snapshot_at is set — walk newest→oldest.
			const baseMs = new Date('2026-03-01T00:00:00.000Z').getTime()
			const seeded: Array<{ id: string; createdAt: Date }> = []
			for (let i = 0; i < 6; i++) {
				const actor = await insertActor(db, {
					type: 'agent',
					name: `Cursor Actor ${String(i).padStart(2, '0')}`,
					createdAt: new Date(baseMs + i * 60_000),
				})
				await db.insert(workspaceMembers).values({
					workspaceId: ws.id,
					actorId: actor.id,
					role: 'member',
				})
				seeded.push({ id: actor.id, createdAt: actor.createdAt as Date })
			}
			const snapshotAt = seeded[seeded.length - 1].createdAt.toISOString()

			// Page 1: 4 rows in (createdAt desc, id asc) order.
			const page1Res = await app.request(
				jsonGet(`/api/actors?limit=4&order=desc&snapshot_at=${encodeURIComponent(snapshotAt)}`, {
					'x-workspace-id': ws.id,
				}),
			)
			expect(page1Res.status).toBe(200)
			const page1 = (await page1Res.json()) as Array<{ id: string; createdAt: string }>
			expect(page1).toHaveLength(4)

			// Intruder — inserted with a createdAt past the snapshot upper bound.
			const intruder = await insertActor(db, {
				type: 'agent',
				name: 'Intruder actor',
				createdAt: new Date(baseMs + 999 * 60_000),
			})
			await db.insert(workspaceMembers).values({
				workspaceId: ws.id,
				actorId: intruder.id,
				role: 'member',
			})

			const lastPage1 = page1[page1.length - 1]
			const page2Url = `/api/actors?limit=4&order=desc&snapshot_at=${encodeURIComponent(snapshotAt)}&cursor_created_at=${encodeURIComponent(lastPage1.createdAt)}&cursor_id=${encodeURIComponent(lastPage1.id)}`
			const page2Res = await app.request(jsonGet(page2Url, { 'x-workspace-id': ws.id }))
			expect(page2Res.status).toBe(200)
			const page2 = (await page2Res.json()) as Array<{ id: string }>
			// The test actor is added as owner by `insertWorkspace` but its
			// `createdAt` is set at `beforeAll` time (system now), which is
			// long after the snapshot boundary (2026-03-01). So the snapshot
			// upper bound filters the test actor out of the walk entirely —
			// leaving only the 6 seeded members. Page 1 returned 4; page 2
			// must return the remaining 2.
			expect(page2).toHaveLength(2)

			const page1Ids = new Set(page1.map((row) => row.id))
			for (const row of page2) {
				expect(page1Ids.has(row.id)).toBe(false)
			}
			const walked = [...page1.map((r) => r.id), ...page2.map((r) => r.id)]
			expect([...walked].sort()).toEqual(seeded.map((r) => r.id).sort())
			expect(walked).not.toContain(intruder.id)
		})
	})

	describe('list_relationships', () => {
		it('excludes a mid-pagination insert from the same walk', async () => {
			const app = createIntegrationApp({
				path: '/api/relationships',
				module: relationshipsRoutes,
			})
			const ws = await insertWorkspace(db, getTestActorId())
			const src = await insertObject(db, ws.id, getTestActorId(), {
				type: 'insight',
				status: 'new',
			})
			const tgt = await insertObject(db, ws.id, getTestActorId(), { type: 'bet', status: 'signal' })

			const baseMs = new Date('2026-03-02T00:00:00.000Z').getTime()
			const seeded: Array<{ id: string; createdAt: Date }> = []
			for (let i = 0; i < 6; i++) {
				const rel = buildRelationship({
					sourceType: 'object',
					sourceId: src.id,
					targetType: 'object',
					targetId: tgt.id,
					type: `informs-${i}`,
					createdBy: getTestActorId(),
					createdAt: new Date(baseMs + i * 60_000),
				})
				const [inserted] = await db.insert(relationships).values(rel).returning()
				seeded.push({ id: inserted.id, createdAt: inserted.createdAt as Date })
			}
			const snapshotAt = seeded[seeded.length - 1].createdAt.toISOString()

			const page1Res = await app.request(
				jsonGet(
					`/api/relationships?limit=4&order=desc&snapshot_at=${encodeURIComponent(snapshotAt)}`,
					{ 'x-workspace-id': ws.id },
				),
			)
			expect(page1Res.status).toBe(200)
			const page1 = (await page1Res.json()) as Array<{ id: string; createdAt: string }>
			expect(page1).toHaveLength(4)

			const intruder = buildRelationship({
				sourceType: 'object',
				sourceId: src.id,
				targetType: 'object',
				targetId: tgt.id,
				type: 'intruder',
				createdBy: getTestActorId(),
				createdAt: new Date(baseMs + 999 * 60_000),
			})
			const [intruderRow] = await db.insert(relationships).values(intruder).returning()

			const lastPage1 = page1[page1.length - 1]
			const page2Url = `/api/relationships?limit=4&order=desc&snapshot_at=${encodeURIComponent(snapshotAt)}&cursor_created_at=${encodeURIComponent(lastPage1.createdAt)}&cursor_id=${encodeURIComponent(lastPage1.id)}`
			const page2Res = await app.request(jsonGet(page2Url, { 'x-workspace-id': ws.id }))
			expect(page2Res.status).toBe(200)
			const page2 = (await page2Res.json()) as Array<{ id: string }>
			expect(page2).toHaveLength(2)

			const page1Ids = new Set(page1.map((row) => row.id))
			for (const row of page2) expect(page1Ids.has(row.id)).toBe(false)
			const walked = [...page1.map((r) => r.id), ...page2.map((r) => r.id)]
			expect([...walked].sort()).toEqual(seeded.map((r) => r.id).sort())
			expect(walked).not.toContain(intruderRow.id)
		})
	})

	describe('list_triggers', () => {
		it('excludes a mid-pagination insert from the same walk', async () => {
			const app = createIntegrationApp({ path: '/api/triggers', module: triggersRoutes })
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertActor(db, { type: 'agent', name: 'Trigger agent' })

			const baseMs = new Date('2026-03-03T00:00:00.000Z').getTime()
			const seeded: Array<{ id: string; createdAt: Date }> = []
			for (let i = 0; i < 6; i++) {
				const t = buildTrigger({
					workspaceId: ws.id,
					targetActorId: agent.id,
					createdBy: getTestActorId(),
					name: `Cursor trigger ${i}`,
					createdAt: new Date(baseMs + i * 60_000),
					updatedAt: new Date(baseMs + i * 60_000),
				})
				const [inserted] = await db.insert(triggers).values(t).returning()
				seeded.push({ id: inserted.id, createdAt: inserted.createdAt as Date })
			}
			const snapshotAt = seeded[seeded.length - 1].createdAt.toISOString()

			const page1Res = await app.request(
				jsonGet(`/api/triggers?limit=4&order=desc&snapshot_at=${encodeURIComponent(snapshotAt)}`, {
					'x-workspace-id': ws.id,
				}),
			)
			expect(page1Res.status).toBe(200)
			const page1 = (await page1Res.json()) as Array<{ id: string; createdAt: string }>
			expect(page1).toHaveLength(4)

			const intruder = buildTrigger({
				workspaceId: ws.id,
				targetActorId: agent.id,
				createdBy: getTestActorId(),
				name: 'Intruder trigger',
				createdAt: new Date(baseMs + 999 * 60_000),
				updatedAt: new Date(baseMs + 999 * 60_000),
			})
			const [intruderRow] = await db.insert(triggers).values(intruder).returning()

			const lastPage1 = page1[page1.length - 1]
			const page2Url = `/api/triggers?limit=4&order=desc&snapshot_at=${encodeURIComponent(snapshotAt)}&cursor_created_at=${encodeURIComponent(lastPage1.createdAt)}&cursor_id=${encodeURIComponent(lastPage1.id)}`
			const page2Res = await app.request(jsonGet(page2Url, { 'x-workspace-id': ws.id }))
			expect(page2Res.status).toBe(200)
			const page2 = (await page2Res.json()) as Array<{ id: string }>
			expect(page2).toHaveLength(2)

			const page1Ids = new Set(page1.map((row) => row.id))
			for (const row of page2) expect(page1Ids.has(row.id)).toBe(false)
			const walked = [...page1.map((r) => r.id), ...page2.map((r) => r.id)]
			expect([...walked].sort()).toEqual(seeded.map((r) => r.id).sort())
			expect(walked).not.toContain(intruderRow.id)
		})
	})

	describe('list_files', () => {
		it('excludes a mid-pagination insert from the same walk', async () => {
			const app = createIntegrationApp({ path: '/api/files', module: filesRoutes })
			const ws = await insertWorkspace(db, getTestActorId())

			const baseMs = new Date('2026-03-04T00:00:00.000Z').getTime()
			const seeded: Array<{ id: string; createdAt: Date }> = []
			for (let i = 0; i < 6; i++) {
				const f = buildFile({
					workspaceId: ws.id,
					createdBy: getTestActorId(),
					name: `cursor-file-${i}.md`,
					createdAt: new Date(baseMs + i * 60_000),
					updatedAt: new Date(baseMs + i * 60_000),
				})
				const [inserted] = await db.insert(files).values(f).returning()
				seeded.push({ id: inserted.id, createdAt: inserted.createdAt })
			}
			const snapshotAt = seeded[seeded.length - 1].createdAt.toISOString()

			const page1Res = await app.request(
				jsonGet(`/api/files?limit=4&order=desc&snapshot_at=${encodeURIComponent(snapshotAt)}`, {
					'x-workspace-id': ws.id,
				}),
			)
			expect(page1Res.status).toBe(200)
			const page1 = (await page1Res.json()) as Array<{ id: string; createdAt: string }>
			expect(page1).toHaveLength(4)

			const intruder = buildFile({
				workspaceId: ws.id,
				createdBy: getTestActorId(),
				name: 'intruder.md',
				createdAt: new Date(baseMs + 999 * 60_000),
				updatedAt: new Date(baseMs + 999 * 60_000),
			})
			const [intruderRow] = await db.insert(files).values(intruder).returning()

			const lastPage1 = page1[page1.length - 1]
			const page2Url = `/api/files?limit=4&order=desc&snapshot_at=${encodeURIComponent(snapshotAt)}&cursor_created_at=${encodeURIComponent(lastPage1.createdAt)}&cursor_id=${encodeURIComponent(lastPage1.id)}`
			const page2Res = await app.request(jsonGet(page2Url, { 'x-workspace-id': ws.id }))
			expect(page2Res.status).toBe(200)
			const page2 = (await page2Res.json()) as Array<{ id: string }>
			expect(page2).toHaveLength(2)

			const page1Ids = new Set(page1.map((row) => row.id))
			for (const row of page2) expect(page1Ids.has(row.id)).toBe(false)
			const walked = [...page1.map((r) => r.id), ...page2.map((r) => r.id)]
			expect([...walked].sort()).toEqual(seeded.map((r) => r.id).sort())
			expect(walked).not.toContain(intruderRow.id)
		})
	})

	describe('list_workspace_skills', () => {
		it('excludes a mid-pagination insert from the same walk', async () => {
			const app = createIntegrationApp({
				path: '/api/workspaces',
				module: workspaceSkillsRoutes,
			})
			const ws = await insertWorkspace(db, getTestActorId())

			const baseMs = new Date('2026-03-05T00:00:00.000Z').getTime()
			const seeded: Array<{ id: string; createdAt: Date }> = []
			for (let i = 0; i < 6; i++) {
				const skill = buildWorkspaceSkill({
					workspaceId: ws.id,
					name: `cursor-skill-${String(i).padStart(2, '0')}`,
					createdBy: getTestActorId(),
					createdAt: new Date(baseMs + i * 60_000),
					updatedAt: new Date(baseMs + i * 60_000),
				})
				const [inserted] = await db.insert(workspaceSkills).values(skill).returning()
				seeded.push({ id: inserted.id, createdAt: inserted.createdAt })
			}
			const snapshotAt = seeded[seeded.length - 1].createdAt.toISOString()

			const page1Res = await app.request(
				jsonGet(
					`/api/workspaces/${ws.id}/skills?limit=4&order=desc&snapshot_at=${encodeURIComponent(snapshotAt)}`,
				),
			)
			expect(page1Res.status).toBe(200)
			const page1 = (await page1Res.json()) as Array<{ id: string; createdAt: string }>
			expect(page1).toHaveLength(4)

			const intruder = buildWorkspaceSkill({
				workspaceId: ws.id,
				name: 'cursor-skill-intruder',
				createdBy: getTestActorId(),
				createdAt: new Date(baseMs + 999 * 60_000),
				updatedAt: new Date(baseMs + 999 * 60_000),
			})
			const [intruderRow] = await db.insert(workspaceSkills).values(intruder).returning()

			const lastPage1 = page1[page1.length - 1]
			const page2Url = `/api/workspaces/${ws.id}/skills?limit=4&order=desc&snapshot_at=${encodeURIComponent(snapshotAt)}&cursor_created_at=${encodeURIComponent(lastPage1.createdAt)}&cursor_id=${encodeURIComponent(lastPage1.id)}`
			const page2Res = await app.request(jsonGet(page2Url))
			expect(page2Res.status).toBe(200)
			const page2 = (await page2Res.json()) as Array<{ id: string }>
			expect(page2).toHaveLength(2)

			const page1Ids = new Set(page1.map((row) => row.id))
			for (const row of page2) expect(page1Ids.has(row.id)).toBe(false)
			const walked = [...page1.map((r) => r.id), ...page2.map((r) => r.id)]
			expect([...walked].sort()).toEqual(seeded.map((r) => r.id).sort())
			expect(walked).not.toContain(intruderRow.id)
		})

		it('ignores a lone cursor_id without cursor_created_at', async () => {
			const app = createIntegrationApp({
				path: '/api/workspaces',
				module: workspaceSkillsRoutes,
			})
			const ws = await insertWorkspace(db, getTestActorId())

			const baseMs = new Date('2026-03-06T00:00:00.000Z').getTime()
			for (let i = 0; i < 3; i++) {
				const skill = buildWorkspaceSkill({
					workspaceId: ws.id,
					name: `probe-${i}`,
					createdBy: getTestActorId(),
					createdAt: new Date(baseMs + i * 60_000),
					updatedAt: new Date(baseMs + i * 60_000),
				})
				await db.insert(workspaceSkills).values(skill)
			}
			const snapshotAt = new Date(baseMs + 999 * 60_000).toISOString()
			const nilId = '00000000-0000-0000-0000-000000000000'
			const res = await app.request(
				jsonGet(
					`/api/workspaces/${ws.id}/skills?limit=10&order=desc&snapshot_at=${encodeURIComponent(snapshotAt)}&cursor_id=${encodeURIComponent(nilId)}`,
				),
			)
			expect(res.status).toBe(200)
			const rows = (await res.json()) as Array<{ id: string }>
			expect(rows).toHaveLength(3)
		})
	})
})
