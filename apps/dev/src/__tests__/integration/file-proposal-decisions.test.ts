import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { authMiddleware } from '@maskin/auth'
import { fileProposalChanges, fileProposals, files, workspaceMembers } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, mapStatusToCode } from '../../lib/errors'
import { sha256Hex } from '../../lib/file-save'
import { fileStorageKey } from '../../lib/file-urls'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId, sql } from './global-setup'

const capture = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capture,
	warnIfPosthogKeyUnset: vi.fn(),
}))

const { default: fileProposalsRoutes } = await import('../../routes/file-proposals')

const DOC = '# Plan\n\nWe ship on Friday.\n\nThe budget is small.\n\nWe ship on Monday.\n'

/** Storage that keeps bytes in memory and lets a test break the upload. */
function createMemoryStorage() {
	const objects = new Map<string, Buffer>()
	const hooks: { put?: (key: string, data: Buffer) => Promise<void> | void } = {}
	const storage = {
		put: async (key: string, data: Buffer) => {
			await hooks.put?.(key, data)
			objects.set(key, Buffer.from(data))
		},
		get: async (key: string) => {
			const bytes = objects.get(key)
			if (!bytes) throw new Error(`missing ${key}`)
			return bytes
		},
	} as unknown as StorageProvider
	return { storage, objects, hooks }
}

// The real authMiddleware (the role comes from its membership lookup) in front of
// the real routes, the same arrangement as the viewer read-only test.
function createApp(storage: StorageProvider, opts: { sessionId?: string } = {}) {
	const app = new OpenAPIHono()
	app.use('*', authMiddleware(db, { cacheTtlMs: 0 }))
	app.use('*', async (c, next) => {
		c.set('db' as never, db as never)
		c.set('storageProvider' as never, storage as never)
		c.set('notifyBridge' as never, {} as never)
		if (opts.sessionId) c.set('maskinSessionId' as never, opts.sessionId as never)
		await next()
	})
	app.onError((err, c) => {
		if ('status' in err && typeof err.status === 'number') {
			return c.json(createApiError(mapStatusToCode(err.status), err.message), err.status as 400)
		}
		throw err
	})
	app.route('/api/files', fileProposalsRoutes as never)
	return app
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` })

describe('Deciding proposed changes (integration)', () => {
	let workspaceId: string
	let mem: ReturnType<typeof createMemoryStorage>
	let app: ReturnType<typeof createApp>
	let ownerKey: string
	let memberKey: string
	let memberId: string
	let viewerKey: string
	let agentKey: string
	let agentId: string
	let outsiderKey: string

	beforeAll(async () => {
		// Fires at COMMIT, so the accept has already uploaded and updated the row
		// when the transaction fails. Only rows named commit-fails.md are hit.
		await sql.unsafe(`
			CREATE OR REPLACE FUNCTION test_fail_at_commit() RETURNS trigger AS $$
			BEGIN RAISE EXCEPTION 'forced commit failure'; END;
			$$ LANGUAGE plpgsql
		`)
		await sql.unsafe(`
			CREATE CONSTRAINT TRIGGER test_fail_at_commit AFTER UPDATE ON files
			DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
			WHEN (NEW.name = 'commit-fails.md') EXECUTE FUNCTION test_fail_at_commit()
		`)
	})

	afterAll(async () => {
		await sql.unsafe('DROP TRIGGER IF EXISTS test_fail_at_commit ON files')
		await sql.unsafe('DROP FUNCTION IF EXISTS test_fail_at_commit()')
	})

	beforeEach(async () => {
		capture.mockClear()
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
		ownerKey = 'ank_testintegration'

		const member = await insertActor(db, { name: 'Member' })
		memberKey = member.apiKey
		memberId = member.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: member.id, role: 'member' })

		const viewer = await insertActor(db, { name: 'Viewer' })
		viewerKey = viewer.apiKey
		await db.insert(workspaceMembers).values({ workspaceId, actorId: viewer.id, role: 'viewer' })

		// An agent with the member role: the ordinary write guard lets it through,
		// deciding must not.
		const agent = await insertActor(db, { name: 'Agent', type: 'agent' })
		agentKey = agent.apiKey
		agentId = agent.id
		await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })

		outsiderKey = (await insertActor(db, { name: 'Outsider' })).apiKey

		mem = createMemoryStorage()
		app = createApp(mem.storage)
	})

	async function insertFile(overrides: { name?: string; text?: string } = {}) {
		const id = randomUUID()
		const bytes = Buffer.from(overrides.text ?? DOC)
		const storageKey = fileStorageKey(workspaceId, id)
		mem.objects.set(storageKey, bytes)
		const [row] = await db
			.insert(files)
			.values({
				id,
				workspaceId,
				name: overrides.name ?? 'plan.md',
				mimeType: 'text/markdown',
				sizeBytes: bytes.byteLength,
				storageKey,
				createdBy: getTestActorId(),
			})
			.returning()
		if (!row) throw new Error('file insert failed')
		return row
	}

	async function insertProposal(
		fileId: string,
		changes: { old: string; next: string }[],
		opts: { authorId?: string; sessionId?: string } = {},
	) {
		const [proposal] = await db
			.insert(fileProposals)
			.values({
				fileId,
				workspaceId,
				authorId: opts.authorId ?? agentId,
				sessionId: opts.sessionId ?? null,
				baseSha256: sha256Hex(Buffer.from(DOC)),
			})
			.returning()
		if (!proposal) throw new Error('proposal insert failed')
		const rows = await db
			.insert(fileProposalChanges)
			.values(
				changes.map((ch, i) => ({
					proposalId: proposal.id,
					ordinal: i,
					oldText: ch.old,
					newText: ch.next,
				})),
			)
			.returning()
		return { proposal, changes: rows.sort((a, b) => a.ordinal - b.ordinal) }
	}

	const accept = (
		fileId: string,
		pid: string,
		cid: string,
		key: string,
		body?: { applied_text?: string },
	) =>
		app.request(
			jsonRequest(
				'POST',
				`/api/files/${fileId}/proposals/${pid}/changes/${cid}/accept`,
				body,
				bearer(key),
			),
		)
	const reject = (fileId: string, pid: string, cid: string, key: string) =>
		app.request(
			jsonRequest(
				'POST',
				`/api/files/${fileId}/proposals/${pid}/changes/${cid}/reject`,
				undefined,
				bearer(key),
			),
		)
	const bulk = (
		verb: 'accept' | 'reject',
		fileId: string,
		pid: string,
		ids: string[],
		key: string,
	) =>
		app.request(
			jsonRequest(
				'POST',
				`/api/files/${fileId}/proposals/${pid}/changes/${verb}`,
				{ change_ids: ids },
				bearer(key),
			),
		)

	const stored = (file: { storageKey: string }) => mem.objects.get(file.storageKey)?.toString()
	const changeRow = async (id: string) => {
		const [row] = await db.select().from(fileProposalChanges).where(eq(fileProposalChanges.id, id))
		return row
	}
	const fileRow = async (id: string) => {
		const [row] = await db.select().from(files).where(eq(files.id, id))
		return row
	}
	const eventsNamed = (name: string) => capture.mock.calls.filter((c) => c[0] === name)

	describe('who may decide', () => {
		it('turns a viewer away with 403 and leaves the bytes and the change alone', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [{ old: 'small', next: 'tight' }])
			const [change] = changes

			const acceptRes = await accept(file.id, proposal.id, change?.id ?? '', viewerKey)
			expect(acceptRes.status).toBe(403)
			const rejectRes = await reject(file.id, proposal.id, change?.id ?? '', viewerKey)
			expect(rejectRes.status).toBe(403)
			expect(
				(await bulk('accept', file.id, proposal.id, [change?.id ?? ''], viewerKey)).status,
			).toBe(403)
			expect(
				(await bulk('reject', file.id, proposal.id, [change?.id ?? ''], viewerKey)).status,
			).toBe(403)

			expect(stored(file)).toBe(DOC)
			expect((await changeRow(change?.id ?? ''))?.status).toBe('pending')
			expect(capture).not.toHaveBeenCalled()
		})

		it('lets a human member and a human owner decide', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [
				{ old: 'small', next: 'tight' },
				{ old: 'on Friday', next: 'on Thursday' },
			])

			const asMember = await accept(file.id, proposal.id, changes[0]?.id ?? '', memberKey)
			expect(asMember.status).toBe(200)
			const asOwner = await accept(file.id, proposal.id, changes[1]?.id ?? '', ownerKey)
			expect(asOwner.status).toBe(200)
			expect(stored(file)).toBe(
				'# Plan\n\nWe ship on Thursday.\n\nThe budget is tight.\n\nWe ship on Monday.\n',
			)
		})

		it('turns an agent with the member role away with 403', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [{ old: 'small', next: 'tight' }])
			const id = changes[0]?.id ?? ''

			expect((await accept(file.id, proposal.id, id, agentKey)).status).toBe(403)
			expect((await reject(file.id, proposal.id, id, agentKey)).status).toBe(403)
			expect(stored(file)).toBe(DOC)
			expect((await changeRow(id))?.status).toBe('pending')
		})

		it('never lets the proposing actor decide, even a human member', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(
				file.id,
				[{ old: 'small', next: 'tight' }],
				{ authorId: memberId },
			)
			const id = changes[0]?.id ?? ''

			expect((await accept(file.id, proposal.id, id, memberKey)).status).toBe(403)
			expect((await reject(file.id, proposal.id, id, memberKey)).status).toBe(403)
			expect(stored(file)).toBe(DOC)
			expect((await changeRow(id))?.status).toBe('pending')
		})

		it('answers 404 to someone outside the workspace', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [{ old: 'small', next: 'tight' }])
			const res = await accept(file.id, proposal.id, changes[0]?.id ?? '', outsiderKey)
			expect(res.status).toBe(404)
		})

		it('keeps reading proposals at the plain member check, so a viewer can still read', async () => {
			const file = await insertFile()
			await insertProposal(file.id, [{ old: 'small', next: 'tight' }])
			const res = await app.request(jsonGet(`/api/files/${file.id}/proposals`, bearer(viewerKey)))
			expect(res.status).toBe(200)
		})

		it('answers 404 for a change that belongs to another proposal', async () => {
			const file = await insertFile()
			const first = await insertProposal(file.id, [{ old: 'small', next: 'tight' }])
			const second = await insertProposal(file.id, [{ old: 'on Friday', next: 'on Thursday' }])
			const res = await accept(file.id, first.proposal.id, second.changes[0]?.id ?? '', memberKey)
			expect(res.status).toBe(404)
		})
	})

	describe('accepting', () => {
		it('writes the change, updates size and hash, and returns the accepted change', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [
				{ old: 'The budget is small.', next: 'The budget is tight.' },
			])
			const id = changes[0]?.id ?? ''

			const res = await accept(file.id, proposal.id, id, memberKey)
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect(body).toMatchObject({
				id,
				status: 'accepted',
				appliedText: 'The budget is tight.',
				stale: false,
			})
			expect(body.decidedBy).toBeTruthy()
			expect(body.decidedAt).toBeTruthy()

			const expected = DOC.replace('The budget is small.', 'The budget is tight.')
			expect(stored(file)).toBe(expected)
			const row = await fileRow(file.id)
			expect(row?.contentHash).toBe(sha256Hex(Buffer.from(expected)))
			expect(row?.sizeBytes).toBe(Buffer.byteLength(expected))
			expect(row?.updatedAt.getTime()).toBeGreaterThan(file.updatedAt.getTime() - 1)
		})

		it('writes the edited text and records what was written', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [{ old: 'small', next: 'tight' }])
			const id = changes[0]?.id ?? ''

			const res = await accept(file.id, proposal.id, id, memberKey, { applied_text: 'modest' })
			expect(res.status).toBe(200)
			expect(stored(file)).toBe(DOC.replace('small', 'modest'))
			const row = await changeRow(id)
			expect(row).toMatchObject({ status: 'accepted', newText: 'tight', appliedText: 'modest' })
		})

		it('takes an accept with no body and writes new_text', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [{ old: 'small', next: 'tight' }])
			const res = await accept(file.id, proposal.id, changes[0]?.id ?? '', memberKey)
			expect(res.status).toBe(200)
			expect(stored(file)).toBe(DOC.replace('small', 'tight'))
		})

		it('answers 409 and changes nothing when the text moved on', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [{ old: 'small', next: 'tight' }])
			const id = changes[0]?.id ?? ''
			const edited = DOC.replace('small', 'huge')
			mem.objects.set(file.storageKey, Buffer.from(edited))

			const res = await accept(file.id, proposal.id, id, memberKey)
			expect(res.status).toBe(409)
			const body = (await res.json()) as { staleChangeIds: string[] }
			expect(body.staleChangeIds).toEqual([id])
			expect(stored(file)).toBe(edited)
			expect((await changeRow(id))?.status).toBe('pending')
			expect(capture).not.toHaveBeenCalled()
		})

		it('answers 409 for a change that was already decided', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [{ old: 'small', next: 'tight' }])
			const id = changes[0]?.id ?? ''
			expect((await accept(file.id, proposal.id, id, memberKey)).status).toBe(200)
			capture.mockClear()

			const again = await accept(file.id, proposal.id, id, memberKey)
			expect(again.status).toBe(409)
			expect(((await again.json()) as { staleChangeIds: string[] }).staleChangeIds).toEqual([])
			const afterReject = await reject(file.id, proposal.id, id, memberKey)
			expect(afterReject.status).toBe(409)
			expect(capture).not.toHaveBeenCalled()
		})

		it('uses the bytes stored now, not the text the proposal was made against', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [{ old: 'small', next: 'tight' }])
			// Someone fixed a different line after the proposal. The change still applies.
			const edited = DOC.replace('Friday', 'Thursday')
			mem.objects.set(file.storageKey, Buffer.from(edited))

			const res = await accept(file.id, proposal.id, changes[0]?.id ?? '', memberKey)
			expect(res.status).toBe(200)
			expect(stored(file)).toBe(edited.replace('small', 'tight'))
		})
	})

	describe('rejecting', () => {
		it('records the rejection and never touches the file', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [{ old: 'small', next: 'tight' }])
			const id = changes[0]?.id ?? ''

			const res = await reject(file.id, proposal.id, id, memberKey)
			expect(res.status).toBe(200)
			expect(await res.json()).toMatchObject({
				id,
				status: 'rejected',
				appliedText: null,
				stale: false,
			})
			expect(stored(file)).toBe(DOC)
			expect((await fileRow(file.id))?.contentHash).toBeNull()
			expect(await changeRow(id)).toMatchObject({ status: 'rejected', appliedText: null })
		})

		it('lets a stale change be rejected', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [{ old: 'gone text', next: 'x' }])
			const res = await reject(file.id, proposal.id, changes[0]?.id ?? '', memberKey)
			expect(res.status).toBe(200)
		})
	})

	describe('bulk', () => {
		it('accepts several changes in one write', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [
				{ old: 'The budget is small.', next: 'The budget is tight.' },
				{ old: 'We ship on Friday.', next: 'We ship on Thursday.' },
			])
			const res = await bulk(
				'accept',
				file.id,
				proposal.id,
				changes.map((c) => c.id),
				memberKey,
			)
			expect(res.status).toBe(200)
			const body = (await res.json()) as { changes: { status: string }[] }
			expect(body.changes.map((c) => c.status)).toEqual(['accepted', 'accepted'])
			expect(stored(file)).toBe(
				'# Plan\n\nWe ship on Thursday.\n\nThe budget is tight.\n\nWe ship on Monday.\n',
			)
		})

		it('applies nothing and lists the stale ids when one change is stale', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [
				{ old: 'The budget is small.', next: 'The budget is tight.' },
				{ old: 'text that is gone', next: 'x' },
			])
			const res = await bulk(
				'accept',
				file.id,
				proposal.id,
				changes.map((c) => c.id),
				memberKey,
			)
			expect(res.status).toBe(409)
			const body = (await res.json()) as { staleChangeIds: string[] }
			expect(body.staleChangeIds).toEqual([changes[1]?.id])
			expect(stored(file)).toBe(DOC)
			expect((await fileRow(file.id))?.contentHash).toBeNull()
			for (const ch of changes) expect((await changeRow(ch.id))?.status).toBe('pending')
			expect(capture).not.toHaveBeenCalled()
		})

		it('treats two changes that now overlap as stale instead of corrupting the text', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [
				{ old: 'We ship on Friday.\n\nThe budget', next: 'a' },
				{ old: 'The budget is small.', next: 'b' },
			])
			const res = await bulk(
				'accept',
				file.id,
				proposal.id,
				changes.map((c) => c.id),
				memberKey,
			)
			expect(res.status).toBe(409)
			expect(stored(file)).toBe(DOC)
		})

		it('rejects several changes, stale ones included, and answers 409 if one was decided', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [
				{ old: 'small', next: 'tight' },
				{ old: 'text that is gone', next: 'x' },
			])
			const ids = changes.map((c) => c.id)
			expect((await accept(file.id, proposal.id, ids[0] ?? '', memberKey)).status).toBe(200)

			const blocked = await bulk('reject', file.id, proposal.id, ids, memberKey)
			expect(blocked.status).toBe(409)
			expect((await changeRow(ids[1] ?? ''))?.status).toBe('pending')

			const ok = await bulk('reject', file.id, proposal.id, [ids[1] ?? ''], memberKey)
			expect(ok.status).toBe(200)
			expect((await changeRow(ids[1] ?? ''))?.status).toBe('rejected')
		})
	})

	describe('failing safely', () => {
		it('leaves the old bytes, the old hash and no accepted change when the commit fails after the upload', async () => {
			const file = await insertFile({ name: 'commit-fails.md' })
			const { proposal, changes } = await insertProposal(file.id, [{ old: 'small', next: 'tight' }])
			const id = changes[0]?.id ?? ''
			let uploads = 0
			mem.hooks.put = () => {
				uploads++
			}

			const res = await accept(file.id, proposal.id, id, memberKey)
			expect(res.status).toBe(500)
			// One upload for the new bytes, one to put the old bytes back.
			expect(uploads).toBe(2)
			expect(stored(file)).toBe(DOC)
			expect((await fileRow(file.id))?.contentHash).toBeNull()
			expect((await changeRow(id))?.status).toBe('pending')
			expect(capture).not.toHaveBeenCalled()
		})

		it('rolls back with nothing half applied when the upload fails', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [{ old: 'small', next: 'tight' }])
			const id = changes[0]?.id ?? ''
			mem.hooks.put = () => {
				throw new Error('storage down')
			}

			const res = await accept(file.id, proposal.id, id, memberKey)
			expect(res.status).toBe(500)
			expect(stored(file)).toBe(DOC)
			expect((await fileRow(file.id))?.contentHash).toBeNull()
			expect((await changeRow(id))?.status).toBe('pending')
			expect(capture).not.toHaveBeenCalled()
		})
	})

	describe('events', () => {
		it('sends file_saved tagged accepted_change as a human, with the proposal and its session', async () => {
			const file = await insertFile()
			const sessionId = randomUUID()
			const { proposal, changes } = await insertProposal(
				file.id,
				[
					{ old: 'small', next: 'tight' },
					{ old: 'on Friday', next: 'on Thursday' },
				],
				{ sessionId },
			)
			const res = await bulk(
				'accept',
				file.id,
				proposal.id,
				changes.map((c) => c.id),
				memberKey,
			)
			expect(res.status).toBe(200)

			const saved = eventsNamed('file_saved')
			expect(saved).toHaveLength(1)
			expect(saved[0]?.[2]).toMatchObject({
				workspace_id: workspaceId,
				file_id: file.id,
				actor_type: 'human',
				source: 'accepted_change',
				proposal_id: proposal.id,
				proposal_session_id: sessionId,
				accepted_count: 2,
				edited_count: 0,
			})
		})

		it('sends change_reviewed with accepted, edited_then_accepted and rejected', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [
				{ old: 'small', next: 'tight' },
				{ old: 'on Friday', next: 'on Thursday' },
				{ old: 'on Monday', next: 'on Tuesday' },
			])
			const [a, b, c] = changes.map((ch) => ch.id)
			await accept(file.id, proposal.id, a ?? '', memberKey)
			await accept(file.id, proposal.id, b ?? '', memberKey, { applied_text: 'on Wednesday' })
			await reject(file.id, proposal.id, c ?? '', memberKey)

			const reviewed = eventsNamed('change_reviewed')
			expect(reviewed).toHaveLength(3)
			expect(reviewed.map((call) => call[2])).toEqual([
				expect.objectContaining({
					workspace_id: workspaceId,
					actor_id: expect.any(String),
					file_name: 'plan.md',
					proposal_id: proposal.id,
					change_id: a,
					decision: 'accepted',
				}),
				expect.objectContaining({ change_id: b, decision: 'edited_then_accepted' }),
				expect.objectContaining({ change_id: c, decision: 'rejected' }),
			])
			// The edited accept also counts as edited in the save event.
			expect(eventsNamed('file_saved')[1]?.[2]).toMatchObject({ edited_count: 1 })
		})

		it('sends one change_reviewed per change in a bulk decision and none on a refusal', async () => {
			const file = await insertFile()
			const { proposal, changes } = await insertProposal(file.id, [
				{ old: 'small', next: 'tight' },
				{ old: 'on Friday', next: 'on Thursday' },
			])
			const ids = changes.map((ch) => ch.id)

			await bulk('accept', file.id, proposal.id, ids, viewerKey)
			await bulk('accept', file.id, proposal.id, ids, agentKey)
			expect(capture).not.toHaveBeenCalled()

			await bulk('reject', file.id, proposal.id, ids, memberKey)
			const reviewed = eventsNamed('change_reviewed')
			expect(reviewed).toHaveLength(2)
			expect(reviewed.map((call) => call[2]?.change_id).sort()).toEqual([...ids].sort())
			expect(eventsNamed('file_saved')).toHaveLength(0)
		})
	})
})
