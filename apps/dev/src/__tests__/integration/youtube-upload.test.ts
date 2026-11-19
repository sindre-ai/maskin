import { Readable } from 'node:stream'
import {
	files,
	integrations,
	youtubeActionAudit,
	youtubePendingActions,
	youtubeQuotaUsage,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import {
	UPLOAD_GLOBAL_DAILY_CAP,
	UPLOAD_GLOBAL_SCOPE,
	UPLOAD_WORKSPACE_DAILY_CAP,
	chargeYoutubeUploadQuota,
	uploadWorkspaceScope,
} from '../../lib/integrations/providers/youtube/quota'
import { createPendingAction, decideYoutubeAction } from '../../lib/youtube/actions'
import {
	type ExecutorDeps,
	type UploadDeps,
	YOUTUBE_UPLOAD_MAX_RUNS,
	executeApprovedYoutubeAction,
	resumeInterruptedYoutubeUploads,
} from '../../lib/youtube/executor'
import { buildPublishPayload, buildUploadPayload } from '../../lib/youtube/upload'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/posthog', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/analytics/posthog')>()),
	capturePosthogEvent: vi.fn(),
}))

const HASH = 'a'.repeat(64)

describe('YouTube upload and publish', () => {
	let workspaceId: string
	let humanId: string
	let integrationId: string
	let cardObjectId: string
	let fileId: string
	let upload: Record<
		'startSession' | 'uploadFile' | 'publishVideo' | 'loadFile' | 'openFile' | 'chargeUpload',
		ReturnType<typeof vi.fn>
	>
	let chargeQuota: ReturnType<typeof vi.fn>
	let deps: ExecutorDeps

	beforeEach(async () => {
		humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
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
		cardObjectId = (await insertObject(db, workspaceId, humanId, { type: 'task', status: 'todo' }))
			.id
		const [file] = await db
			.insert(files)
			.values({
				workspaceId,
				name: 'launch.mp4',
				mimeType: 'video/mp4',
				sizeBytes: 5_000,
				storageKey: `test/${crypto.randomUUID()}.mp4`,
				contentHash: HASH,
				createdBy: humanId,
			})
			.returning()
		fileId = (file as { id: string }).id

		upload = {
			startSession: vi
				.fn()
				.mockResolvedValue({ ok: true, sessionUri: 'https://upload.example/s1' }),
			uploadFile: vi.fn().mockResolvedValue({ state: 'done', videoId: 'vidNEW12345' }),
			publishVideo: vi.fn().mockResolvedValue({ ok: true }),
			loadFile: vi.fn(async (_db, ws, id) => {
				const [row] = await db
					.select()
					.from(files)
					.where(and(eq(files.id, id), eq(files.workspaceId, ws)))
				return row ?? null
			}),
			openFile: vi.fn().mockImplementation(async () => Readable.from([])),
			chargeUpload: vi.fn().mockResolvedValue(undefined),
		}
		chargeQuota = vi.fn().mockResolvedValue(undefined)
		deps = {
			client: { execute: vi.fn() },
			getAccessToken: vi.fn().mockResolvedValue('token'),
			chargeQuota,
			upload: upload as unknown as ExecutorDeps['upload'],
		}
	})

	const file = () => ({
		id: fileId,
		name: 'launch.mp4',
		mimeType: 'video/mp4',
		sizeBytes: 5_000,
		contentHash: HASH,
	})

	async function holdUpload(over: { aiGenerated?: boolean } = {}) {
		const payload = buildUploadPayload(file(), { title: 'Launch day', ...over })
		return createPendingAction(db, {
			workspaceId,
			integrationId,
			kind: 'upload_video',
			payload: payload as unknown as Record<string, unknown>,
			channelLabel: 'Maskin channel',
			requestedByActor: humanId,
			cardEntityId: cardObjectId,
			approverIds: [humanId],
		})
	}

	async function holdPublish(publishAt?: string) {
		const payload = buildPublishPayload({
			videoId: 'vidNEW12345',
			visibility: 'public',
			publishAt,
		})
		return createPendingAction(db, {
			workspaceId,
			integrationId,
			kind: 'publish_video',
			payload: payload as unknown as Record<string, unknown>,
			targetVideoId: 'vidNEW12345',
			requestedByActor: humanId,
			cardEntityId: cardObjectId,
			approverIds: [humanId],
		})
	}

	const approve = async (actionId: string) => {
		const result = await decideYoutubeAction(db, {
			workspaceId,
			actionId,
			actor: { id: humanId, type: 'human' },
			decision: 'approve',
		})
		expect(result.ok).toBe(true)
	}
	const rowOf = async (id: string) =>
		(await db.select().from(youtubePendingActions).where(eq(youtubePendingActions.id, id)))[0]
	const auditOf = async (id: string) =>
		(await db.select().from(youtubeActionAudit).where(eq(youtubeActionAudit.pendingActionId, id)))
			.map((r) => r.decision)
			.sort()

	describe('an upload', () => {
		it('does nothing until a person approves it', async () => {
			const held = await holdUpload()
			expect(await executeApprovedYoutubeAction(db, held.id, deps)).toEqual({ ran: false })
			expect(upload.startSession).not.toHaveBeenCalled()
		})

		it('uploads as private, marks AI media, and keeps the video id and no session address', async () => {
			const held = await holdUpload({ aiGenerated: true })
			await approve(held.id)
			const outcome = await executeApprovedYoutubeAction(db, held.id, deps)
			expect(outcome).toEqual({ ran: true, status: 'executed', resultCode: 'ok' })

			expect(upload.chargeUpload).toHaveBeenCalledWith(db, workspaceId)
			const session = upload.startSession.mock.calls[0]?.[0] as {
				body: { status: Record<string, unknown> }
				sizeBytes: number
				mimeType: string
			}
			expect(session.body.status).toEqual({
				privacyStatus: 'private',
				containsSyntheticMedia: true,
			})
			expect(session.sizeBytes).toBe(5_000)

			const row = await rowOf(held.id)
			expect(row).toMatchObject({
				status: 'executed',
				targetVideoId: 'vidNEW12345',
				resultCode: 'ok',
			})
			expect(row?.payload).toBeNull()
			expect(row?.uploadSessionUri).toBeNull()
			expect(await auditOf(held.id)).toEqual(['approved', 'executed'])
		})

		it('refuses when the file is no longer the one that was approved', async () => {
			const held = await holdUpload()
			await approve(held.id)
			await db
				.update(files)
				.set({ contentHash: 'b'.repeat(64) })
				.where(eq(files.id, fileId))
			expect(await executeApprovedYoutubeAction(db, held.id, deps)).toMatchObject({
				status: 'failed',
				resultCode: 'file_changed',
			})
			expect(upload.startSession).not.toHaveBeenCalled()
		})

		it('fails when the file is gone, the quota is used up, or Google refuses the session', async () => {
			const gone = await holdUpload()
			await approve(gone.id)
			await db.delete(files).where(eq(files.id, fileId))
			expect(await executeApprovedYoutubeAction(db, gone.id, deps)).toMatchObject({
				resultCode: 'file_missing',
			})

			const [again] = await db
				.insert(files)
				.values({
					workspaceId,
					name: 'b.mp4',
					mimeType: 'video/mp4',
					sizeBytes: 5_000,
					storageKey: 'test/b.mp4',
					contentHash: HASH,
					createdBy: humanId,
				})
				.returning()
			fileId = (again as { id: string }).id

			const noQuota = await holdUpload()
			await approve(noQuota.id)
			upload.chargeUpload.mockRejectedValueOnce(new Error('cap'))
			expect(await executeApprovedYoutubeAction(db, noQuota.id, deps)).toMatchObject({
				resultCode: 'quota_exhausted',
			})
			expect(upload.startSession).not.toHaveBeenCalled()

			const refused = await holdUpload()
			await approve(refused.id)
			upload.startSession.mockResolvedValueOnce({ ok: false, code: 'http_403', retryable: false })
			expect(await executeApprovedYoutubeAction(db, refused.id, deps)).toMatchObject({
				status: 'failed',
				resultCode: 'http_403',
			})
		})

		it('keeps its progress when cut off and resumes from the stored session', async () => {
			const held = await holdUpload()
			await approve(held.id)
			upload.uploadFile.mockImplementationOnce(
				async (request: { onProgress: (n: number) => Promise<void> }) => {
					await request.onProgress(2_000)
					return { state: 'interrupted' }
				},
			)
			expect(await executeApprovedYoutubeAction(db, held.id, deps)).toMatchObject({
				status: 'interrupted',
			})
			const cut = await rowOf(held.id)
			expect(cut).toMatchObject({
				status: 'approved',
				uploadSessionUri: 'https://upload.example/s1',
				uploadBytesSent: 2_000,
				uploadAttempts: 1,
			})
			expect(cut?.claimedAt).not.toBeNull()

			// Too soon: the sweep leaves an upload that was alive a moment ago.
			expect(await resumeInterruptedYoutubeUploads(db, { deps, wait: true })).toBe(0)

			await db
				.update(youtubePendingActions)
				.set({ claimedAt: new Date(Date.now() - 20 * 60 * 1000) })
				.where(eq(youtubePendingActions.id, held.id))
			expect(await resumeInterruptedYoutubeUploads(db, { deps, wait: true })).toBe(1)

			expect(upload.startSession).toHaveBeenCalledTimes(1)
			expect(upload.chargeUpload).toHaveBeenCalledTimes(1)
			const resumed = upload.uploadFile.mock.calls[1]?.[0] as { sessionUri: string }
			expect(resumed.sessionUri).toBe('https://upload.example/s1')
			expect(await rowOf(held.id)).toMatchObject({
				status: 'executed',
				targetVideoId: 'vidNEW12345',
				uploadSessionUri: null,
				uploadAttempts: 2,
			})
		})

		it('lets only one sweep resume a cut-off upload', async () => {
			const held = await holdUpload()
			await approve(held.id)
			upload.uploadFile.mockResolvedValueOnce({ state: 'interrupted' })
			await executeApprovedYoutubeAction(db, held.id, deps)
			await db
				.update(youtubePendingActions)
				.set({ claimedAt: new Date(Date.now() - 20 * 60 * 1000) })
				.where(eq(youtubePendingActions.id, held.id))
			const counts = await Promise.all([
				resumeInterruptedYoutubeUploads(db, { deps, wait: true }),
				resumeInterruptedYoutubeUploads(db, { deps, wait: true }),
			])
			expect(counts.reduce((a, b) => a + b, 0)).toBe(1)
		})

		it('gives up after too many cut-offs', async () => {
			const held = await holdUpload()
			await approve(held.id)
			await db
				.update(youtubePendingActions)
				.set({ uploadAttempts: YOUTUBE_UPLOAD_MAX_RUNS - 1 })
				.where(eq(youtubePendingActions.id, held.id))
			upload.uploadFile.mockResolvedValue({ state: 'interrupted' })
			expect(await executeApprovedYoutubeAction(db, held.id, deps)).toMatchObject({
				status: 'failed',
				resultCode: 'upload_failed',
			})
			expect((await rowOf(held.id))?.uploadSessionUri).toBeNull()
		})
	})

	describe('making a video public or scheduling it', () => {
		it('is its own action: approving the upload does not approve it', async () => {
			const up = await holdUpload()
			const pub = await holdPublish()
			await approve(up.id)
			await executeApprovedYoutubeAction(db, up.id, deps)
			expect(await executeApprovedYoutubeAction(db, pub.id, deps)).toEqual({ ran: false })
			expect(upload.publishVideo).not.toHaveBeenCalled()

			await approve(pub.id)
			expect(await executeApprovedYoutubeAction(db, pub.id, deps)).toEqual({
				ran: true,
				status: 'executed',
				resultCode: 'ok',
			})
			expect(upload.publishVideo).toHaveBeenCalledWith({
				accessToken: 'token',
				payload: { videoId: 'vidNEW12345', privacyStatus: 'public' },
			})
			expect(chargeQuota).toHaveBeenCalledWith(db, workspaceId, 51)
		})

		it('refuses at run time a time that has passed', async () => {
			vi.useFakeTimers({ toFake: ['Date'] })
			try {
				vi.setSystemTime(new Date('2026-12-01T08:00:00Z'))
				const pub = await holdPublish('2026-12-01T09:00:00Z')
				await approve(pub.id)
				vi.setSystemTime(new Date('2026-12-01T09:30:00Z'))
				expect(await executeApprovedYoutubeAction(db, pub.id, deps)).toMatchObject({
					status: 'failed',
					resultCode: 'publish_time_passed',
				})
				expect(upload.publishVideo).not.toHaveBeenCalled()
				expect(chargeQuota).not.toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})
	})

	describe('the upload quota', () => {
		const DAY = new Date('2026-10-15T19:00:00Z')
		const used = async (scope: string) =>
			(
				await db
					.select({ n: youtubeQuotaUsage.unitsUsed })
					.from(youtubeQuotaUsage)
					.where(
						and(eq(youtubeQuotaUsage.scope, scope), eq(youtubeQuotaUsage.quotaDate, '2026-10-15')),
					)
			)[0]?.n

		it('allows 5 uploads a day in a workspace and counts them in the global bucket', async () => {
			const ws = crypto.randomUUID()
			await db.delete(youtubeQuotaUsage).where(eq(youtubeQuotaUsage.scope, UPLOAD_GLOBAL_SCOPE))
			for (let i = 0; i < UPLOAD_WORKSPACE_DAILY_CAP; i++)
				await chargeYoutubeUploadQuota(db, ws, DAY)
			await expect(chargeYoutubeUploadQuota(db, ws, DAY)).rejects.toMatchObject({
				code: 'WORKSPACE_QUOTA_EXHAUSTED',
			})
			expect(await used(uploadWorkspaceScope(ws))).toBe(UPLOAD_WORKSPACE_DAILY_CAP)
			expect(await used(UPLOAD_GLOBAL_SCOPE)).toBe(UPLOAD_WORKSPACE_DAILY_CAP)
		})

		it('stops at the global cap and rolls the workspace count back', async () => {
			const ws = crypto.randomUUID()
			await db.delete(youtubeQuotaUsage).where(eq(youtubeQuotaUsage.scope, UPLOAD_GLOBAL_SCOPE))
			await db.insert(youtubeQuotaUsage).values({
				quotaDate: '2026-10-15',
				scope: UPLOAD_GLOBAL_SCOPE,
				unitsUsed: UPLOAD_GLOBAL_DAILY_CAP,
			})
			await expect(chargeYoutubeUploadQuota(db, ws, DAY)).rejects.toMatchObject({
				code: 'QUOTA_EXHAUSTED',
			})
			expect(await used(uploadWorkspaceScope(ws))).toBeUndefined()
		})
	})
})
