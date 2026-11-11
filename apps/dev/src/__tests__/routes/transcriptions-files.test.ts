import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanCapExceededError } from '../../lib/llm-routing'
import { ViewerReadOnlyError } from '../../lib/workspace-auth'
import transcriptionsRoutes from '../../routes/transcriptions'
import { FileTranscriptionError, transcribeStoredFile } from '../../services/file-transcription'
import { buildFile, buildWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createMockStorageProvider, createTestContext } from '../setup'

vi.mock('../../services/file-transcription', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/file-transcription')>()),
	transcribeStoredFile: vi.fn(),
}))
vi.mock('../../lib/llm-routing', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/llm-routing')>()),
	checkPlanCap: vi.fn(),
}))

import { checkPlanCap } from '../../lib/llm-routing'

const workspaceId = randomUUID()

function setup(role: string | undefined = 'member') {
	const { db, mockResults } = createTestContext()
	const storageProvider = createMockStorageProvider()
	const app = new OpenAPIHono()
	// What authMiddleware leaves on the context for a header-scoped route.
	app.use('*', async (c, next) => {
		c.set('db' as never, db as never)
		c.set('actorId' as never, 'test-actor-id' as never)
		c.set('storageProvider' as never, storageProvider as never)
		if (role) c.set('workspaceRole' as never, role as never)
		await next()
	})
	// The statuses app-factory's onError gives these two errors.
	app.onError((err, c) => {
		if (err instanceof PlanCapExceededError) return c.json({ error: { code: err.name } }, 402)
		if (err instanceof ViewerReadOnlyError) return c.json({ error: { code: err.name } }, 403)
		return c.json({ error: { message: err.message } }, 500)
	})
	app.route('/api/transcriptions', transcriptionsRoutes)
	return { app, mockResults, storageProvider }
}

function post(fileId: string, body: unknown = {}, headers: Record<string, string> = {}) {
	return jsonRequest('POST', `/api/transcriptions/files/${fileId}`, body, {
		'X-Workspace-Id': workspaceId,
		...headers,
	})
}

const video = () => buildFile({ workspaceId, name: 'standup.mp4', mimeType: 'video/mp4' })
const planWorkspace = (overrides?: Record<string, unknown>) =>
	buildWorkspace({ id: workspaceId, enterpriseGranted: false, billingOwnerId: null, ...overrides })

describe('POST /api/transcriptions/files/:id', () => {
	beforeEach(() => {
		vi.mocked(transcribeStoredFile).mockReset()
		vi.mocked(checkPlanCap).mockReset()
	})

	it('transcribes the file and returns the text with its audio length', async () => {
		const { app, mockResults } = setup()
		const file = video()
		mockResults.selectQueue = [[file], [planWorkspace()]]
		vi.mocked(transcribeStoredFile).mockResolvedValue({
			text: 'Good morning everyone.',
			audioSeconds: 12.504,
			chunks: 1,
			model: 'mistralai/voxtral-small-transcribe-3-0',
		})

		const res = await app.request(post(file.id, { language: 'en' }))

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({
			file_id: file.id,
			name: 'standup.mp4',
			text: 'Good morning everyone.',
			audio_seconds: 12.5,
			chunks: 1,
			model: 'mistralai/voxtral-small-transcribe-3-0',
		})
		expect(transcribeStoredFile).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId,
				actorId: 'test-actor-id',
				file: { id: file.id, storageKey: file.storageKey },
				language: 'en',
			}),
		)
	})

	it('checks the plan cap before doing any work', async () => {
		const { app, mockResults } = setup()
		const file = video()
		mockResults.selectQueue = [[file], [planWorkspace({ settings: { billing: { plan: 'pro' } } })]]
		vi.mocked(checkPlanCap).mockRejectedValue(
			new PlanCapExceededError({ plan: 'pro', used: 1000, cap: 1000, periodEnd: null }),
		)

		const res = await app.request(post(file.id))

		expect(res.status).toBe(402)
		expect(checkPlanCap).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceId, enterprise: false }),
		)
		expect(transcribeStoredFile).not.toHaveBeenCalled()
	})

	it('refuses an enterprise workspace, which has no Maskin plan to charge', async () => {
		const { app, mockResults } = setup()
		const file = video()
		mockResults.selectQueue = [[file], [planWorkspace({ enterpriseGranted: true })]]

		const res = await app.request(post(file.id))

		expect(res.status).toBe(403)
		expect(transcribeStoredFile).not.toHaveBeenCalled()
	})

	it('returns 404 for a file that is not in the header workspace', async () => {
		const { app, mockResults } = setup()
		mockResults.selectQueue = [[]]

		const res = await app.request(post(randomUUID()))

		expect(res.status).toBe(404)
		expect(transcribeStoredFile).not.toHaveBeenCalled()
	})

	it('returns 400 for a file that is not audio or video, before downloading it', async () => {
		const { app, mockResults, storageProvider } = setup()
		const file = buildFile({ workspaceId, mimeType: 'application/pdf' })
		mockResults.selectQueue = [[file]]

		const res = await app.request(post(file.id))

		expect(res.status).toBe(400)
		expect(transcribeStoredFile).not.toHaveBeenCalled()
		expect(storageProvider.getStream).not.toHaveBeenCalled()
	})

	it('refuses a viewer, because the call spends plan usage', async () => {
		const { app } = setup('viewer')

		const res = await app.request(post(randomUUID()))

		expect(res.status).toBe(403)
		expect(transcribeStoredFile).not.toHaveBeenCalled()
	})

	it('returns 400 when X-Workspace-Id is missing', async () => {
		const { app } = setup(undefined)

		const res = await app.request(post(randomUUID(), {}, { 'X-Workspace-Id': '' }))

		expect(res.status).toBe(400)
	})

	it('returns 400 for a malformed language hint', async () => {
		const { app } = setup()

		const res = await app.request(post(randomUUID(), { language: 'English please' }))

		expect(res.status).toBe(400)
	})

	it.each([
		['too_long', 400],
		['not_transcribable', 400],
		['busy', 429],
		['provider_refused', 503],
		['tooling_unavailable', 503],
		['provider_error', 502],
		['timeout', 504],
		['not_configured', 500],
		['storage_error', 500],
	] as const)('maps a %s failure to HTTP %i with its message', async (code, status) => {
		const { app, mockResults } = setup()
		const file = video()
		mockResults.selectQueue = [[file], [planWorkspace()]]
		vi.mocked(transcribeStoredFile).mockRejectedValue(
			new FileTranscriptionError(code, `because ${code}`),
		)

		const res = await app.request(post(file.id))

		expect(res.status).toBe(status)
		const body = (await res.json()) as { error: { message: string } }
		expect(body.error.message).toBe(`because ${code}`)
	})
})
