import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { API_KEY_CREDIT_MARK_WINDOW_MS, markApiKeyOutOfCredit } from '../../lib/api-key-credit-mark'
import {
	LLM_ROUTE_API_KEY,
	LlmCredentialsUnavailableError,
	resolveLlmRoute,
} from '../../lib/llm-routing'
import type { WorkspaceSettings } from '../../lib/types'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// PATCH /api/workspaces reports workspace events; keep them off the live endpoint.
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

const { default: workspacesRoutes } = await import('../../routes/workspaces')

/**
 * The route picker leaves the workspace Anthropic key alone for 30 minutes
 * after a credit error. Real Postgres, because the mark is written by one
 * jsonb statement that a mocked DB cannot vouch for.
 */

// Obviously fake placeholders, never real credentials.
const KEY_A = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
const ANTHROPIC = 'FAKE-anthropic-key-0001'
const REPLACEMENT = 'FAKE-anthropic-key-0002'

const app = createIntegrationApp({ path: '/api/workspaces', module: workspacesRoutes })

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = KEY_A
})

afterEach(() => {
	vi.useRealTimers()
})

type Stored = Record<string, unknown> & { llm_keys?: Record<string, string | null> }

async function storedSettings(id: string): Promise<Stored> {
	const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id))
	return row?.settings as Stored
}

async function workspaceWithKey(extra: Record<string, unknown> = {}) {
	const ws = await insertWorkspace(db, getTestActorId())
	await db
		.update(workspaces)
		.set({ settings: { ...(ws.settings as object), llm_keys: { anthropic: ANTHROPIC }, ...extra } })
		.where(eq(workspaces.id, ws.id))
	return ws
}

/** What the session start does: read the settings row, then pick a route. */
async function pick(workspaceId: string) {
	return resolveLlmRoute({
		db,
		workspaceId,
		actorId: getTestActorId(),
		wsSettings: (await storedSettings(workspaceId)) as unknown as WorkspaceSettings,
		agent: {},
		enterprise: true,
	})
}

describe('workspace API key out-of-credit mark', () => {
	it('a credit error makes the next pick skip the key, and a pick after 30 minutes tries it again', async () => {
		const ws = await workspaceWithKey()
		expect((await pick(ws.id))?.route).toBe(LLM_ROUTE_API_KEY)

		vi.useFakeTimers({ toFake: ['Date'] })
		const start = new Date('2026-11-01T12:00:00Z')
		vi.setSystemTime(start)
		expect(await markApiKeyOutOfCredit({ db, workspaceId: ws.id })).toBe(true)

		// Inside the window the key is left out, and with nothing else to use the
		// start fails with the credit reason instead of launching.
		vi.setSystemTime(new Date(start.getTime() + API_KEY_CREDIT_MARK_WINDOW_MS - 1000))
		const skipped = await pick(ws.id).catch((err) => err)
		expect(skipped).toBeInstanceOf(LlmCredentialsUnavailableError)
		expect(skipped.apiKeyOutOfCredit).toBe(true)
		expect(skipped.toFailureReason()).toMatchObject({
			reason_code: 'credit_balance_low',
			provider: 'anthropic',
		})

		// After the window the key is tried again, and the old mark is cleared.
		vi.setSystemTime(new Date(start.getTime() + API_KEY_CREDIT_MARK_WINDOW_MS + 1000))
		expect((await pick(ws.id))?.route).toBe(LLM_ROUTE_API_KEY)
		await vi.waitFor(async () => {
			expect((await storedSettings(ws.id)).anthropic_key_out_of_credit).toBeUndefined()
		})
	})

	it('writes only its own field: every other setting is left as it was', async () => {
		const ws = await workspaceWithKey({ max_concurrent_sessions: 7, pinned_files: [] })
		const before = await storedSettings(ws.id)

		await markApiKeyOutOfCredit({ db, workspaceId: ws.id })

		const { anthropic_key_out_of_credit: mark, ...rest } = await storedSettings(ws.id)
		expect(mark).toMatchObject({
			at: expect.any(Number),
			key: expect.stringMatching(/^[0-9a-f]{64}$/),
		})
		expect(rest).toEqual(before)
	})

	it('does nothing when the workspace has no Anthropic key', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const before = await storedSettings(ws.id)

		expect(await markApiKeyOutOfCredit({ db, workspaceId: ws.id })).toBe(false)
		expect(await storedSettings(ws.id)).toEqual(before)
	})

	it('replacing the key through settings clears the mark at once', async () => {
		const ws = await workspaceWithKey()
		await markApiKeyOutOfCredit({ db, workspaceId: ws.id })
		await expect(pick(ws.id)).rejects.toBeInstanceOf(LlmCredentialsUnavailableError)

		const res = await app.request(
			jsonRequest('PATCH', `/api/workspaces/${ws.id}`, {
				settings: { llm_keys: { anthropic: REPLACEMENT } },
			}),
		)
		expect(res.status).toBe(200)

		const route = await pick(ws.id)
		expect(route?.route).toBe(LLM_ROUTE_API_KEY)
		expect(route?.envVars.ANTHROPIC_API_KEY).toBe(REPLACEMENT)
	})
})
