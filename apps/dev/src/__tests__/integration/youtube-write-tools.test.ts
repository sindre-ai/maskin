import { createHash } from 'node:crypto'
import {
	events,
	files,
	integrations,
	youtubePendingActions,
	youtubeQuotaUsage,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { YoutubeError } from '../../lib/integrations/providers/youtube/errors'
import { decideYoutubeAction } from '../../lib/youtube/actions'
import { COMMENTS_PER_DAY, COMMENTS_PER_VIDEO_PER_DAY, LIKES_PER_DAY } from '../../lib/youtube/caps'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The write client is mocked so nothing reaches Google. The real executor runs around it.
vi.mock('../../lib/youtube/google-write-client', () => ({
	googleWriteClient: { execute: vi.fn() },
}))
// Reads go through the YouTube client; here they are answered by the test.
const youtubeRead = vi.fn()
vi.mock('../../lib/integrations/providers/youtube/client', () => ({
	youtubeRead: (...args: unknown[]) => youtubeRead(...args),
}))
let integrationId = ''
vi.mock('../../lib/integrations/providers/youtube/token', () => ({
	getYoutubeIntegrationId: async () => integrationId,
}))

const { googleWriteClient } = await import('../../lib/youtube/google-write-client')
const { executeApprovedYoutubeAction, YOUTUBE_WRITE_UNITS } = await import(
	'../../lib/youtube/executor'
)
const { proposeYoutubeWrite } = await import('../../lib/youtube/propose')

const execute = vi.mocked(googleWriteClient.execute)

const OWN_CHANNEL = { items: [{ id: 'UC_own', snippet: { title: 'Maskin channel' } }] }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

describe('YouTube write tools', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string
	let objectId: string

	const ctx = () => ({ db, workspaceId, actorId: agentId })
	const common = () => ({ object_id: objectId })
	const rowOf = async (id: string) =>
		(await db.select().from(youtubePendingActions).where(eq(youtubePendingActions.id, id)))[0]
	const comment = (video_id: string, text: string) =>
		proposeYoutubeWrite(ctx(), common(), { tool: 'post_comment', args: { video_id, text } })
	const like = (video_id: string) =>
		proposeYoutubeWrite(ctx(), common(), { tool: 'like', args: { video_id } })
	const approve = async (actionId: string) => {
		const result = await decideYoutubeAction(db, {
			workspaceId,
			actionId,
			actor: { id: humanId, type: 'human' },
			decision: 'approve',
		})
		expect(result.ok).toBe(true)
	}
	const run = (actionId: string, extra: Record<string, unknown> = {}) =>
		executeApprovedYoutubeAction(db, actionId, {
			client: googleWriteClient,
			getAccessToken: async () => 'token',
			...extra,
		})

	beforeEach(async () => {
		execute.mockReset()
		execute.mockResolvedValue({ ok: true, code: 'ok' })
		youtubeRead.mockReset()
		youtubeRead.mockResolvedValue(OWN_CHANNEL)
		humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
		agentId = (
			await insertActor(db, {
				type: 'agent',
				name: 'Video agent',
				email: null,
				apiKey: `ank_yt_${Date.now()}_${Math.random()}`,
			})
		).id
		const [integration] = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: 'youtube',
				status: 'active',
				credentials: 'x',
				createdBy: humanId,
			})
			.returning()
		integrationId = (integration as { id: string }).id
		objectId = (await insertObject(db, workspaceId, humanId, { type: 'task', status: 'todo' })).id
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('asking', () => {
		it('stores the exact request, puts a card on the object and never calls Google', async () => {
			const held = await comment('vid1', 'Thanks for watching!')

			expect(held.status).toBe('pending')
			const row = await rowOf(held.action_id)
			expect(row?.kind).toBe('post_comment')
			expect(row?.payload).toEqual({
				snippet: {
					videoId: 'vid1',
					topLevelComment: { snippet: { textOriginal: 'Thanks for watching!' } },
				},
			})
			expect(row?.targetVideoId).toBe('vid1')
			expect(row?.channelLabel).toBe('Maskin channel')
			expect(row?.requestedByActor).toBe(agentId)
			const [card] = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, objectId), eq(events.action, 'commented')))
			expect((card?.data as { youtube_action_id?: string }).youtube_action_id).toBe(held.action_id)
			expect(execute).not.toHaveBeenCalled()
		})

		it('refuses an object that is not in this workspace', async () => {
			await expect(
				proposeYoutubeWrite(
					ctx(),
					{ object_id: crypto.randomUUID() },
					{ tool: 'like', args: { video_id: 'vid1' } },
				),
			).rejects.toMatchObject({ code: 'INVALID_INPUT' })
			expect(await db.select().from(youtubePendingActions)).toHaveLength(0)
		})

		it('builds each playlist and reply request as Google expects it', async () => {
			const playlist = await proposeYoutubeWrite(ctx(), common(), {
				tool: 'create_playlist',
				args: { title: 'Best of', privacy_status: 'private' },
			})
			expect((await rowOf(playlist.action_id))?.payload).toEqual({
				snippet: { title: 'Best of' },
				status: { privacyStatus: 'private' },
			})
			const added = await proposeYoutubeWrite(ctx(), common(), {
				tool: 'add_to_playlist',
				args: { playlist_id: 'PL1', video_id: 'vid1', position: 2 },
			})
			expect((await rowOf(added.action_id))?.payload).toEqual({
				snippet: {
					playlistId: 'PL1',
					resourceId: { kind: 'youtube#video', videoId: 'vid1' },
					position: 2,
				},
			})
			const reply = await proposeYoutubeWrite(ctx(), common(), {
				tool: 'reply_to_comment',
				args: { video_id: 'vid1', comment_id: 'c1', text: 'Thanks' },
			})
			expect((await rowOf(reply.action_id))?.payload).toEqual({
				snippet: { parentId: 'c1', textOriginal: 'Thanks' },
			})
			const liked = await like('vid1')
			expect((await rowOf(liked.action_id))?.payload).toEqual({ id: 'vid1', rating: 'like' })
		})
	})

	describe('video details', () => {
		const current = {
			channelId: 'UC_own',
			title: 'Old title',
			description: 'Old description',
			tags: ['a', 'b'],
			categoryId: '22',
			defaultLanguage: 'en',
		}
		const readsVideo = (snippet: object | null) =>
			youtubeRead.mockImplementation(async (_ctx: unknown, read: { path: string }) =>
				read.path === 'videos' ? { items: snippet ? [{ snippet }] : [] } : OWN_CHANNEL,
			)
		const edit = (args: Record<string, unknown>) =>
			proposeYoutubeWrite(ctx(), common(), {
				tool: 'update_video_metadata',
				args: { video_id: 'vid1', ...args },
			})

		it('sends the whole snippet with the change applied, so nothing else is dropped', async () => {
			readsVideo(current)
			const held = await edit({ title: 'New title' })
			expect((await rowOf(held.action_id))?.payload).toEqual({
				id: 'vid1',
				snippet: {
					title: 'New title',
					description: 'Old description',
					categoryId: '22',
					tags: ['a', 'b'],
					defaultLanguage: 'en',
				},
			})
		})

		it('refuses a video on another channel, a missing video and a change that changes nothing', async () => {
			readsVideo({ ...current, channelId: 'UC_other' })
			await expect(edit({ title: 'x' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
			readsVideo(null)
			await expect(edit({ title: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
			readsVideo(current)
			await expect(edit({ title: 'Old title' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
			await expect(edit({})).rejects.toMatchObject({ code: 'INVALID_INPUT' })
			expect(await db.select().from(youtubePendingActions)).toHaveLength(0)
		})
	})

	describe('caps on comments and likes', () => {
		it('allows 10 comments a day for the workspace and holds the 11th', async () => {
			for (let i = 0; i < COMMENTS_PER_DAY; i++) await comment(`vid${i}`, `Comment number ${i}`)
			await expect(comment('vid99', 'One more')).rejects.toMatchObject({ code: 'CAP_REACHED' })
		})

		it('counts replies with comments', async () => {
			for (let i = 0; i < COMMENTS_PER_DAY - 1; i++) await comment(`vid${i}`, `Comment number ${i}`)
			await proposeYoutubeWrite(ctx(), common(), {
				tool: 'reply_to_comment',
				args: { video_id: 'vid50', comment_id: 'c1', text: 'A reply' },
			})
			await expect(comment('vid99', 'One more')).rejects.toMatchObject({ code: 'CAP_REACHED' })
		})

		it('allows 3 comments a day on one video and holds the 4th', async () => {
			for (let i = 0; i < COMMENTS_PER_VIDEO_PER_DAY; i++) await comment('vid1', `Comment ${i}`)
			await expect(comment('vid1', 'Comment 3')).rejects.toMatchObject({ code: 'CAP_REACHED' })
			await expect(comment('vid2', 'Comment 3')).resolves.toBeDefined()
		})

		it('allows 20 likes a day and holds the 21st', async () => {
			for (let i = 0; i < LIKES_PER_DAY; i++) await like(`vid${i}`)
			await expect(like('vid99')).rejects.toMatchObject({ code: 'CAP_REACHED' })
		})

		it('never takes the same text twice, whatever its case or spacing, on any video', async () => {
			await comment('vid1', 'Great video, thanks!')
			await expect(comment('vid2', '  great   VIDEO, thanks! ')).rejects.toMatchObject({
				code: 'CAP_REACHED',
			})
		})

		it('still refuses the same text after the first one ran and its payload was cleared', async () => {
			const first = await comment('vid1', 'Great video, thanks!')
			await approve(first.action_id)
			await run(first.action_id)
			expect((await rowOf(first.action_id))?.payload).toBeNull()
			await expect(comment('vid2', 'Great video, thanks!')).rejects.toMatchObject({
				code: 'CAP_REACHED',
			})
		})

		it('gives the place back when a person rejects the request', async () => {
			const first = await comment('vid1', 'Great video, thanks!')
			await decideYoutubeAction(db, {
				workspaceId,
				actionId: first.action_id,
				actor: { id: humanId, type: 'human' },
				decision: 'reject',
			})
			await expect(comment('vid1', 'Great video, thanks!')).resolves.toBeDefined()
		})

		it('holds under parallel calls', async () => {
			const results = await Promise.allSettled(
				Array.from({ length: 6 }, (_, i) => comment('vid1', `Parallel ${i}`)),
			)
			expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
				COMMENTS_PER_VIDEO_PER_DAY,
			)
			const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
			expect(refused.every((r) => r.reason instanceof YoutubeError)).toBe(true)
		})

		it('does not count one workspace against another', async () => {
			for (let i = 0; i < LIKES_PER_DAY; i++) await like(`vid${i}`)
			const other = (await insertWorkspace(db, humanId)).id
			const [otherIntegration] = await db
				.insert(integrations)
				.values({
					workspaceId: other,
					provider: 'youtube',
					status: 'active',
					credentials: 'x',
					createdBy: humanId,
				})
				.returning()
			integrationId = (otherIntegration as { id: string }).id
			const otherObject = (await insertObject(db, other, humanId, { type: 'task', status: 'todo' }))
				.id
			await expect(
				proposeYoutubeWrite(
					{ db, workspaceId: other, actorId: agentId },
					{ object_id: otherObject },
					{ tool: 'like', args: { video_id: 'vid1' } },
				),
			).resolves.toBeDefined()
		})
	})

	describe('running an approved change', () => {
		const quotaOf = async () =>
			(await db.select().from(youtubeQuotaUsage).where(eq(youtubeQuotaUsage.scope, workspaceId)))[0]
				?.unitsUsed ?? 0

		it('charges 50 quota units when it runs, not when it is asked for or approved', async () => {
			const held = await like('vid1')
			expect(await quotaOf()).toBe(0)
			await approve(held.action_id)
			expect(await quotaOf()).toBe(0)

			expect(await run(held.action_id)).toEqual({ ran: true, status: 'executed', resultCode: 'ok' })
			expect(await quotaOf()).toBe(YOUTUBE_WRITE_UNITS)
			expect(YOUTUBE_WRITE_UNITS).toBe(50)
		})

		it('does not call Google when the quota is used up', async () => {
			const held = await like('vid1')
			await approve(held.action_id)
			const chargeQuota = vi
				.fn()
				.mockRejectedValue(
					new YoutubeError({ code: 'WORKSPACE_QUOTA_EXHAUSTED', message: 'used up' }),
				)

			expect(await run(held.action_id, { chargeQuota })).toEqual({
				ran: true,
				status: 'failed',
				resultCode: 'quota_exhausted',
			})
			expect(execute).not.toHaveBeenCalled()
		})
	})

	describe('thumbnails', () => {
		const hashOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
		let fileId: string

		async function addFile(overrides: Record<string, unknown> = {}) {
			const [file] = await db
				.insert(files)
				.values({
					workspaceId,
					name: 'cover.png',
					mimeType: 'image/png',
					sizeBytes: PNG.length,
					storageKey: `test/${crypto.randomUUID()}`,
					contentHash: hashOf(PNG),
					createdBy: humanId,
					...overrides,
				})
				.returning()
			return (file as { id: string }).id
		}
		const ask = (id = fileId) =>
			proposeYoutubeWrite(ctx(), common(), {
				tool: 'set_thumbnail',
				args: { video_id: 'vid1', file_id: id },
			})
		const storageWith = (bytes: Buffer) => ({ get: vi.fn().mockResolvedValue(bytes) }) as never

		beforeEach(async () => {
			fileId = await addFile()
		})

		it('holds the file id and the hash of its bytes, so the card shows what will be sent', async () => {
			const held = await ask()
			expect((await rowOf(held.action_id))?.payload).toEqual({
				videoId: 'vid1',
				fileId,
				fileName: 'cover.png',
				contentHash: hashOf(PNG),
			})
		})

		it('refuses a file that is not an image, too large, unhashed or from another workspace', async () => {
			await expect(ask(await addFile({ mimeType: 'application/pdf' }))).rejects.toMatchObject({
				code: 'INVALID_INPUT',
			})
			await expect(ask(await addFile({ sizeBytes: 3 * 1024 * 1024 }))).rejects.toMatchObject({
				code: 'INVALID_INPUT',
			})
			await expect(ask(await addFile({ contentHash: null }))).rejects.toMatchObject({
				code: 'INVALID_INPUT',
			})
			await expect(ask(crypto.randomUUID())).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		})

		it('sends the approved image and nothing else', async () => {
			const held = await ask()
			await approve(held.action_id)

			expect(await run(held.action_id, { storage: storageWith(PNG) })).toMatchObject({
				status: 'executed',
			})
			const request = execute.mock.calls[0]?.[0]
			expect(request?.kind).toBe('set_thumbnail')
			expect(request?.image?.mimeType).toBe('image/png')
			expect(Buffer.from(request?.image?.bytes ?? []).equals(PNG)).toBe(true)
		})

		it('does not send a file whose bytes changed after the request was made', async () => {
			const held = await ask()
			await approve(held.action_id)

			const changed = Buffer.concat([PNG, Buffer.from([9])])
			expect(await run(held.action_id, { storage: storageWith(changed) })).toEqual({
				ran: true,
				status: 'failed',
				resultCode: 'file_changed',
			})
			expect(execute).not.toHaveBeenCalled()
		})

		it('fails cleanly when file storage is not available', async () => {
			const held = await ask()
			await approve(held.action_id)
			expect(await run(held.action_id)).toMatchObject({
				status: 'failed',
				resultCode: 'storage_unavailable',
			})
			expect(execute).not.toHaveBeenCalled()
		})
	})
})
