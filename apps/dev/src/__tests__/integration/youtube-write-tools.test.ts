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
import {
	COMMENTS_PER_DAY,
	COMMENTS_PER_VIDEO_PER_DAY,
	DELETES_PER_DAY,
	LIKES_PER_DAY,
} from '../../lib/youtube/caps'
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

	describe('deleting', () => {
		const OWN = { channelId: 'UC_own' }
		/** Answers each read by its path, like Google would. */
		const reads = (answers: Partial<Record<string, unknown>>) =>
			youtubeRead.mockImplementation(async (_ctx: unknown, read: { path: string }) =>
				read.path === 'channels' ? OWN_CHANNEL : (answers[read.path] ?? { items: [] }),
			)
		const ask = (request: Parameters<typeof proposeYoutubeWrite>[2]) =>
			proposeYoutubeWrite(ctx(), common(), request)
		const deleteVideo = (video_id = 'vid1') => ask({ tool: 'delete_video', args: { video_id } })

		it('holds a video delete with the title read from YouTube, and sends exactly that id once approved', async () => {
			reads({ videos: { items: [{ snippet: { ...OWN, title: 'Launch day' } }] } })
			const held = await deleteVideo()

			const row = await rowOf(held.action_id)
			expect(row?.kind).toBe('delete_video')
			expect(row?.payload).toEqual({ id: 'vid1', title: 'Launch day' })
			expect(row?.targetVideoId).toBe('vid1')
			// The title is read fresh, not from the cache, so it is the title the video has now.
			const read = youtubeRead.mock.calls.find(([, r]) => r.path === 'videos')?.[1]
			expect(read).toMatchObject({ params: { id: 'vid1' }, cache: false })
			expect(execute).not.toHaveBeenCalled()

			await approve(held.action_id)
			expect(await run(held.action_id)).toEqual({ ran: true, status: 'executed', resultCode: 'ok' })
			expect(execute).toHaveBeenCalledOnce()
			expect(execute.mock.calls[0]?.[0]).toMatchObject({
				kind: 'delete_video',
				payload: row?.payload,
			})
			const [card] = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, objectId), eq(events.action, 'commented')))
			expect(JSON.stringify(card?.data)).toContain('PERMANENT')
		})

		it('refuses a video on another channel and a video that is not there', async () => {
			reads({ videos: { items: [{ snippet: { channelId: 'UC_other', title: 'Theirs' } }] } })
			await expect(deleteVideo()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
			reads({ videos: { items: [] } })
			await expect(deleteVideo()).rejects.toMatchObject({ code: 'NOT_FOUND' })
			expect(await db.select().from(youtubePendingActions)).toHaveLength(0)
		})

		it('refuses a video delete when the connected channel cannot be read', async () => {
			youtubeRead.mockRejectedValue(new YoutubeError({ code: 'PROVIDER_ERROR', message: 'x' }))
			await expect(deleteVideo()).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
			expect(await db.select().from(youtubePendingActions)).toHaveLength(0)
		})

		it('holds a comment delete with the author and text read from YouTube', async () => {
			reads({
				comments: {
					items: [
						{ snippet: { videoId: 'vid1', authorDisplayName: 'Ann', textOriginal: 'Great video' } },
					],
				},
			})
			const held = await ask({ tool: 'delete_comment', args: { comment_id: 'c1' } })
			const row = await rowOf(held.action_id)
			expect(row?.kind).toBe('delete_comment')
			expect(row?.payload).toEqual({ id: 'c1', author: 'Ann', text: 'Great video' })
			expect(row?.targetVideoId).toBe('vid1')

			await approve(held.action_id)
			await run(held.action_id)
			expect(execute.mock.calls[0]?.[0]).toMatchObject({
				kind: 'delete_comment',
				payload: { id: 'c1' },
			})
		})

		it('refuses a comment that is not there', async () => {
			reads({ comments: { items: [] } })
			await expect(
				ask({ tool: 'delete_comment', args: { comment_id: 'c1' } }),
			).rejects.toMatchObject({ code: 'NOT_FOUND' })
		})

		it('holds a playlist delete with its real title, only for one of our playlists', async () => {
			reads({ playlists: { items: [{ snippet: { ...OWN, title: 'Best of' } }] } })
			const held = await ask({ tool: 'delete_playlist', args: { playlist_id: 'PL1' } })
			expect((await rowOf(held.action_id))?.payload).toEqual({ id: 'PL1', title: 'Best of' })

			await approve(held.action_id)
			await run(held.action_id)
			expect(execute.mock.calls[0]?.[0]).toMatchObject({
				kind: 'delete_playlist',
				payload: { id: 'PL1', title: 'Best of' },
			})

			reads({ playlists: { items: [{ snippet: { channelId: 'UC_other', title: 'Theirs' } }] } })
			await expect(
				ask({ tool: 'delete_playlist', args: { playlist_id: 'PL2' } }),
			).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
		})

		it('finds the playlist entry itself, so the request carries the entry id and not the video id', async () => {
			reads({
				playlists: { items: [{ snippet: { ...OWN, title: 'Best of' } }] },
				playlistItems: { items: [{ id: 'entry9', snippet: { title: 'Launch day' } }] },
			})
			const held = await ask({
				tool: 'remove_from_playlist',
				args: { playlist_id: 'PL1', video_id: 'vid1' },
			})
			const row = await rowOf(held.action_id)
			expect(row?.payload).toEqual({
				id: 'entry9',
				playlistId: 'PL1',
				playlistTitle: 'Best of',
				videoId: 'vid1',
				videoTitle: 'Launch day',
			})
			const lookup = youtubeRead.mock.calls.find(([, r]) => r.path === 'playlistItems')?.[1]
			expect(lookup.params).toMatchObject({ playlistId: 'PL1', videoId: 'vid1' })

			await approve(held.action_id)
			await run(held.action_id)
			expect(execute.mock.calls[0]?.[0]).toMatchObject({
				kind: 'remove_from_playlist',
				payload: row?.payload,
			})
		})

		it('refuses to remove a video that is not in the playlist', async () => {
			reads({
				playlists: { items: [{ snippet: { ...OWN, title: 'Best of' } }] },
				playlistItems: { items: [] },
			})
			await expect(
				ask({ tool: 'remove_from_playlist', args: { playlist_id: 'PL1', video_id: 'vid1' } }),
			).rejects.toMatchObject({ code: 'NOT_FOUND' })
		})

		it('allows 3 video deletes a day and holds the 4th', async () => {
			reads({ videos: { items: [{ snippet: { ...OWN, title: 'A video' } }] } })
			for (let i = 0; i < DELETES_PER_DAY.delete_video; i++) await deleteVideo(`vid${i}`)
			await expect(deleteVideo('vid99')).rejects.toMatchObject({ code: 'CAP_REACHED' })
		})

		it('counts each kind of delete on its own', async () => {
			reads({
				videos: { items: [{ snippet: { ...OWN, title: 'A video' } }] },
				playlists: { items: [{ snippet: { ...OWN, title: 'A playlist' } }] },
			})
			for (let i = 0; i < DELETES_PER_DAY.delete_playlist; i++) {
				await ask({ tool: 'delete_playlist', args: { playlist_id: `PL${i}` } })
			}
			await expect(
				ask({ tool: 'delete_playlist', args: { playlist_id: 'PL99' } }),
			).rejects.toMatchObject({ code: 'CAP_REACHED' })
			await expect(deleteVideo()).resolves.toBeDefined()
		})

		it('gives the place back when a person rejects a delete', async () => {
			reads({ videos: { items: [{ snippet: { ...OWN, title: 'A video' } }] } })
			const held: string[] = []
			for (let i = 0; i < DELETES_PER_DAY.delete_video; i++) {
				held.push((await deleteVideo(`vid${i}`)).action_id)
			}
			await decideYoutubeAction(db, {
				workspaceId,
				actionId: held[0] as string,
				actor: { id: humanId, type: 'human' },
				decision: 'reject',
			})
			await expect(deleteVideo('vid99')).resolves.toBeDefined()
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
	describe('captions', () => {
		const SRT = Buffer.from('1\n00:00:00,000 --> 00:00:01,000\nHello\n')
		const hashOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
		const TRACK = { id: 'cap1', snippet: { language: 'en', name: 'English', isDraft: false } }
		let fileId: string

		async function addFile(overrides: Record<string, unknown> = {}) {
			const [file] = await db
				.insert(files)
				.values({
					workspaceId,
					name: 'talk.srt',
					mimeType: 'application/x-subrip',
					sizeBytes: SRT.length,
					storageKey: `test/${crypto.randomUUID()}`,
					contentHash: hashOf(SRT),
					createdBy: humanId,
					...overrides,
				})
				.returning()
			return (file as { id: string }).id
		}
		/** The channel, the video's owner and the video's caption list, as Google would answer. */
		const readsCaptions = (opts: { owner?: string | null; tracks?: object[] } = {}) =>
			youtubeRead.mockImplementation(async (_ctx: unknown, read: { path: string }) => {
				if (read.path === 'videos') {
					const owner = opts.owner === undefined ? 'UC_own' : opts.owner
					return { items: owner ? [{ snippet: { channelId: owner } }] : [] }
				}
				if (read.path === 'captions') return { items: opts.tracks ?? [TRACK] }
				return OWN_CHANNEL
			})
		const upload = (extra: Record<string, unknown> = {}, id = fileId) =>
			proposeYoutubeWrite(ctx(), common(), {
				tool: 'upload_caption',
				args: { video_id: 'vid12345', file_id: id, language: 'en', name: 'English', ...extra },
			})
		const replace = (extra: Record<string, unknown> = {}) =>
			proposeYoutubeWrite(ctx(), common(), {
				tool: 'replace_caption',
				args: { video_id: 'vid12345', caption_id: 'cap1', file_id: fileId, ...extra },
			})
		const remove = (captionId = 'cap1') =>
			proposeYoutubeWrite(ctx(), common(), {
				tool: 'delete_caption',
				args: { video_id: 'vid12345', caption_id: captionId },
			})
		const storageWith = (bytes: Buffer) => ({ get: vi.fn().mockResolvedValue(bytes) }) as never

		beforeEach(async () => {
			readsCaptions()
			fileId = await addFile()
		})

		it('holds an upload with the language, file name and file hash, and calls Google for nothing', async () => {
			const held = await upload()
			const row = await rowOf(held.action_id)
			expect(row?.kind).toBe('upload_caption')
			expect(row?.targetVideoId).toBe('vid12345')
			expect(row?.payload).toEqual({
				videoId: 'vid12345',
				language: 'en',
				name: 'English',
				isDraft: false,
				fileId,
				fileName: 'talk.srt',
				sizeBytes: SRT.length,
				contentHash: hashOf(SRT),
			})
			expect(execute).not.toHaveBeenCalled()
		})

		it('refuses a file that is not SRT or VTT, is unhashed, or is from another workspace', async () => {
			await expect(upload({}, await addFile({ name: 'talk.mp3' }))).rejects.toMatchObject({
				code: 'INVALID_INPUT',
			})
			await expect(upload({}, await addFile({ contentHash: null }))).rejects.toMatchObject({
				code: 'INVALID_INPUT',
			})
			await expect(upload({}, crypto.randomUUID())).rejects.toMatchObject({
				code: 'INVALID_INPUT',
			})
			expect(await db.select().from(youtubePendingActions)).toHaveLength(0)
		})

		it('refuses a video that is not on the connected channel, for all three', async () => {
			readsCaptions({ owner: 'UC_other' })
			for (const ask of [() => upload(), () => replace(), () => remove()]) {
				await expect(ask()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
			}
			expect(await db.select().from(youtubePendingActions)).toHaveLength(0)
		})

		it('holds a replace with the language and name read from YouTube, not from the agent', async () => {
			readsCaptions({
				tracks: [{ id: 'cap1', snippet: { language: 'nb', name: 'Norsk', isDraft: true } }],
			})
			const held = await replace()
			expect((await rowOf(held.action_id))?.payload).toMatchObject({
				captionId: 'cap1',
				language: 'nb',
				name: 'Norsk',
				isDraft: true,
				fileId,
			})
		})

		it('refuses a replace or delete for a track the video does not have', async () => {
			await expect(remove('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' })
			await expect(
				proposeYoutubeWrite(ctx(), common(), {
					tool: 'replace_caption',
					args: { video_id: 'vid12345', caption_id: 'nope', file_id: fileId },
				}),
			).rejects.toMatchObject({ code: 'NOT_FOUND' })
		})

		it('holds a delete that names the track and its language', async () => {
			const held = await remove()
			const row = await rowOf(held.action_id)
			expect(row?.kind).toBe('delete_caption')
			expect(row?.payload).toEqual({
				videoId: 'vid12345',
				captionId: 'cap1',
				language: 'en',
				name: 'English',
			})
		})

		it('sends the approved file and charges 400 units for an upload', async () => {
			const held = await upload()
			await approve(held.action_id)
			const chargeQuota = vi.fn().mockResolvedValue(undefined)

			expect(await run(held.action_id, { storage: storageWith(SRT), chargeQuota })).toMatchObject({
				status: 'executed',
			})
			const request = execute.mock.calls[0]?.[0]
			expect(request?.kind).toBe('upload_caption')
			expect(Buffer.from(request?.caption?.bytes ?? []).equals(SRT)).toBe(true)
			expect(chargeQuota).toHaveBeenCalledWith(expect.anything(), workspaceId, 400)
		})

		it('charges 450 units for a replace and 50 for a delete, which sends no file', async () => {
			const chargeQuota = vi.fn().mockResolvedValue(undefined)
			const replaced = await replace()
			await approve(replaced.action_id)
			await run(replaced.action_id, { storage: storageWith(SRT), chargeQuota })
			expect(chargeQuota).toHaveBeenLastCalledWith(expect.anything(), workspaceId, 450)

			const deleted = await remove()
			await approve(deleted.action_id)
			expect(await run(deleted.action_id, { chargeQuota })).toMatchObject({ status: 'executed' })
			expect(chargeQuota).toHaveBeenLastCalledWith(expect.anything(), workspaceId, 50)
			expect(execute.mock.calls[1]?.[0]?.caption).toBeUndefined()
		})

		it('does not send a caption file whose bytes changed after the request was made', async () => {
			const held = await upload()
			await approve(held.action_id)
			expect(
				await run(held.action_id, { storage: storageWith(Buffer.concat([SRT, Buffer.from('x')])) }),
			).toEqual({ ran: true, status: 'failed', resultCode: 'file_changed' })
			expect(execute).not.toHaveBeenCalled()
		})

		it('does not call Google when the quota is used up', async () => {
			const held = await remove()
			await approve(held.action_id)
			const chargeQuota = vi
				.fn()
				.mockRejectedValue(new YoutubeError({ code: 'QUOTA_EXHAUSTED', message: 'used up' }))
			expect(await run(held.action_id, { chargeQuota })).toMatchObject({
				status: 'failed',
				resultCode: 'quota_exhausted',
			})
			expect(chargeQuota).toHaveBeenCalledWith(expect.anything(), workspaceId, 50)
			expect(execute).not.toHaveBeenCalled()
		})
	})

	describe('moderating a comment', () => {
		const COMMENT = {
			items: [
				{
					snippet: {
						videoId: 'vid1',
						authorDisplayName: 'Some Viewer',
						textDisplay: 'Buy cheap followers now',
					},
				},
			],
		}
		const readsComment = (body: object = COMMENT) =>
			youtubeRead.mockImplementation(async (_ctx: unknown, read: { path: string }) =>
				read.path === 'comments' ? body : OWN_CHANNEL,
			)
		const moderate = (args: {
			status: 'published' | 'held_for_review' | 'rejected'
			ban_author?: boolean
		}) =>
			proposeYoutubeWrite(ctx(), common(), {
				tool: 'moderate_comment',
				args: { comment_id: 'c1', ...args },
			})

		it('stores the comment as YouTube has it, so the card shows its author and text', async () => {
			readsComment()
			const held = await moderate({ status: 'rejected', ban_author: true })

			const row = await rowOf(held.action_id)
			expect(row?.kind).toBe('moderate_comment')
			expect(row?.targetVideoId).toBe('vid1')
			expect(row?.payload).toEqual({
				id: 'c1',
				moderationStatus: 'rejected',
				banAuthor: true,
				commentAuthor: 'Some Viewer',
				commentText: 'Buy cheap followers now',
			})
			const [card] = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, objectId), eq(events.action, 'commented')))
			expect(JSON.stringify(card?.data)).toContain('Some Viewer')
			expect(JSON.stringify(card?.data)).toContain('Buy cheap followers now')
			expect(execute).not.toHaveBeenCalled()
		})

		it('maps the three statuses to the ones Google takes', async () => {
			readsComment()
			const statuses = {
				published: 'published',
				held_for_review: 'heldForReview',
				rejected: 'rejected',
			}
			for (const [input, google] of Object.entries(statuses)) {
				const held = await moderate({ status: input as keyof typeof statuses })
				expect((await rowOf(held.action_id))?.payload).toMatchObject({ moderationStatus: google })
			}
		})

		it('refuses ban_author with any status but rejected, and a comment that is not there', async () => {
			readsComment()
			await expect(moderate({ status: 'published', ban_author: true })).rejects.toMatchObject({
				code: 'INVALID_INPUT',
			})
			readsComment({ items: [] })
			await expect(moderate({ status: 'rejected' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
			expect(await db.select().from(youtubePendingActions)).toHaveLength(0)
		})

		it('does not count against the comment or like caps', async () => {
			readsComment()
			for (let i = 0; i < COMMENTS_PER_DAY; i++) await comment(`vid${i}`, `Comment number ${i}`)
			await expect(moderate({ status: 'rejected' })).resolves.toBeDefined()
		})

		it('runs exactly the stored request after a person approves, and charges 50 units', async () => {
			readsComment()
			const held = await moderate({ status: 'rejected', ban_author: true })
			await approve(held.action_id)
			const chargeQuota = vi.fn().mockResolvedValue(undefined)

			expect(await run(held.action_id, { chargeQuota })).toEqual({
				ran: true,
				status: 'executed',
				resultCode: 'ok',
			})
			expect(chargeQuota).toHaveBeenCalledWith(expect.anything(), workspaceId, YOUTUBE_WRITE_UNITS)
			expect(execute.mock.calls[0]?.[0]).toMatchObject({
				kind: 'moderate_comment',
				payload: { id: 'c1', moderationStatus: 'rejected', banAuthor: true },
			})
		})
	})
})
