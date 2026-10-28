import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
	LLM_ROUTE_API_KEY,
	LLM_ROUTE_CUSTOM,
	LLM_ROUTE_MASKIN_PLAN,
	LlmCredentialsUnavailableError,
	resolveChatCredentials,
	resolveLlmRoute,
} from '../../lib/llm-routing'
import type { WorkspaceSettings } from '../../lib/types'
import { SEALED_PREFIX, openSecret } from '../../lib/workspace-secrets'
import { insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

// POST /api/workspaces reports workspace_created; keep it off the live endpoint.
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

const { default: workspacesRoutes } = await import('../../routes/workspaces')

// Every value below is an obviously fake placeholder, never a real credential.
const KEY_A = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
const KEY_B = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
const ANTHROPIC = 'FAKE-anthropic-key-0001'
const OPENAI = 'FAKE-openai-key-0002'
const CUSTOM = 'FAKE-custom-endpoint-key-0003'
const CUSTOM_LLM = {
	enabled: true,
	base_url: 'https://llm.example.test',
	api_key: CUSTOM,
	model: 'model-a',
}

const app = createIntegrationApp({ path: '/api/workspaces', module: workspacesRoutes })

const ORIGINAL_FALLBACK_KEY = process.env.MASKIN_FALLBACK_OPENROUTER_KEY

function restore(name: string, value: string | undefined) {
	if (value === undefined) Reflect.deleteProperty(process.env, name)
	else process.env[name] = value
}

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = KEY_A
})

afterEach(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = KEY_A
	restore('MASKIN_FALLBACK_OPENROUTER_KEY', ORIGINAL_FALLBACK_KEY)
})

type Stored = {
	llm_keys?: Record<string, string | null>
	custom_llm?: Record<string, unknown>
	[key: string]: unknown
}

async function storedSettings(id: string): Promise<Stored> {
	const [row] = await db.select().from(workspaces).where(eq(workspaces.id, id))
	return row.settings as Stored
}

/** An entitled workspace owned by the test actor (the factory default). */
async function newWorkspace(settings?: Record<string, unknown>) {
	const ws = await insertWorkspace(db, getTestActorId())
	if (settings) {
		await db
			.update(workspaces)
			.set({ settings: { ...(ws.settings as object), ...settings } })
			.where(eq(workspaces.id, ws.id))
	}
	return ws
}

function patch(id: string, settings: Record<string, unknown>) {
	return app.request(jsonRequest('PATCH', `/api/workspaces/${id}`, { settings }))
}

async function eventsMentioning(workspaceId: string, needle: string): Promise<number> {
	const [row] = await sql`
		SELECT count(*)::int AS n FROM events e
		WHERE e.workspace_id = ${workspaceId} AND to_jsonb(e)::text LIKE ${`%${needle}%`}
	`
	return row.n
}

describe('LLM keys are stored sealed', () => {
	it('PATCH seals llm_keys and custom_llm.api_key; the row holds no plaintext', async () => {
		const ws = await newWorkspace()

		const res = await patch(ws.id, {
			llm_keys: { anthropic: ANTHROPIC, openai: OPENAI },
			custom_llm: CUSTOM_LLM,
		})
		expect(res.status).toBe(200)

		const settings = await storedSettings(ws.id)
		const raw = JSON.stringify(settings)
		for (const secret of [ANTHROPIC, OPENAI, CUSTOM]) expect(raw).not.toContain(secret)
		expect(settings.llm_keys?.anthropic).toMatch(new RegExp(`^${SEALED_PREFIX}[0-9a-f]+:`))
		expect(settings.llm_keys?.openai?.startsWith(SEALED_PREFIX)).toBe(true)
		expect((settings.custom_llm?.api_key as string).startsWith(SEALED_PREFIX)).toBe(true)
		expect(openSecret(settings.llm_keys?.anthropic as string)).toBe(ANTHROPIC)
		expect(openSecret(settings.custom_llm?.api_key as string)).toBe(CUSTOM)
		// The non-secret parts of custom_llm are stored as sent.
		expect(settings.custom_llm).toMatchObject({ base_url: CUSTOM_LLM.base_url, model: 'model-a' })
	})

	it('POST create seals keys sent with the new workspace', async () => {
		const res = await app.request(
			jsonRequest('POST', '/api/workspaces', {
				name: 'Sealed On Create',
				settings: { llm_keys: { anthropic: ANTHROPIC }, custom_llm: CUSTOM_LLM },
			}),
		)
		expect(res.status).toBe(201)
		const body = await res.json()

		const settings = await storedSettings(body.id)
		expect(JSON.stringify(settings)).not.toContain(ANTHROPIC)
		expect(JSON.stringify(settings)).not.toContain(CUSTOM)
		expect(openSecret(settings.llm_keys?.anthropic as string)).toBe(ANTHROPIC)
		expect(openSecret(settings.custom_llm?.api_key as string)).toBe(CUSTOM)
	})

	it('leaves the admin response unchanged: the owner still gets the plain keys back', async () => {
		const ws = await newWorkspace()
		const res = await patch(ws.id, { llm_keys: { anthropic: ANTHROPIC }, custom_llm: CUSTOM_LLM })
		const body = await res.json()
		expect(body.settings.llm_keys.anthropic).toBe(ANTHROPIC)
		expect(body.settings.custom_llm.api_key).toBe(CUSTOM)

		const list = await (await app.request(jsonGet('/api/workspaces'))).json()
		const listed = list.find((w: { id: string }) => w.id === ws.id)
		expect(listed.settings.llm_keys.anthropic).toBe(ANTHROPIC)
		expect(listed.settings.custom_llm.api_key).toBe(CUSTOM)
		expect(listed.llm_configured).toEqual({ anthropic: true, openai: false, custom_llm: true })
	})

	it('writes no events row that carries a key', async () => {
		const ws = await newWorkspace()
		await patch(ws.id, { llm_keys: { anthropic: ANTHROPIC }, custom_llm: CUSTOM_LLM })
		const stored = await storedSettings(ws.id)

		expect(await eventsMentioning(ws.id, ANTHROPIC)).toBe(0)
		expect(await eventsMentioning(ws.id, CUSTOM)).toBe(0)
		expect(await eventsMentioning(ws.id, stored.llm_keys?.anthropic as string)).toBe(0)
	})
})

describe('saving, replacing and clearing', () => {
	it('re-sending the same plain keys leaves the stored values untouched', async () => {
		const ws = await newWorkspace()
		await patch(ws.id, { llm_keys: { anthropic: ANTHROPIC }, custom_llm: CUSTOM_LLM })
		const before = await storedSettings(ws.id)

		// What the current settings screen does: the whole object read from GET, plus an edit.
		const res = await patch(ws.id, {
			llm_keys: { anthropic: ANTHROPIC },
			custom_llm: CUSTOM_LLM,
			max_concurrent_sessions: 5,
		})
		expect(res.status).toBe(200)

		const after = await storedSettings(ws.id)
		expect(after.llm_keys).toEqual(before.llm_keys)
		expect(after.custom_llm).toEqual(before.custom_llm)
		expect(after.max_concurrent_sessions).toBe(5)
	})

	it('replaces a key with a new sealed value and clears it with null', async () => {
		const ws = await newWorkspace()
		await patch(ws.id, { llm_keys: { anthropic: ANTHROPIC, openai: OPENAI } })

		await patch(ws.id, { llm_keys: { anthropic: 'FAKE-anthropic-key-NEW' } })
		const replaced = await storedSettings(ws.id)
		expect(JSON.stringify(replaced)).not.toContain('FAKE-anthropic-key-NEW')
		expect(openSecret(replaced.llm_keys?.anthropic as string)).toBe('FAKE-anthropic-key-NEW')
		expect(openSecret(replaced.llm_keys?.openai as string)).toBe(OPENAI)

		await patch(ws.id, { llm_keys: { anthropic: null } })
		const cleared = await storedSettings(ws.id)
		expect(cleared.llm_keys?.anthropic).toBeUndefined()
		expect(openSecret(cleared.llm_keys?.openai as string)).toBe(OPENAI)
	})

	it('replaces and clears custom_llm.api_key', async () => {
		const ws = await newWorkspace()
		await patch(ws.id, { custom_llm: CUSTOM_LLM })

		await patch(ws.id, { custom_llm: { ...CUSTOM_LLM, api_key: 'FAKE-custom-key-NEW' } })
		const replaced = await storedSettings(ws.id)
		expect(JSON.stringify(replaced)).not.toContain('FAKE-custom-key-NEW')
		expect(openSecret(replaced.custom_llm?.api_key as string)).toBe('FAKE-custom-key-NEW')

		await patch(ws.id, { custom_llm: { ...CUSTOM_LLM, api_key: null } })
		const cleared = await storedSettings(ws.id)
		expect(cleared.custom_llm?.api_key).toBeNull()
	})
})

describe('sessions route through a saved key', () => {
	const params = (workspaceId: string, settings: WorkspaceSettings) => ({
		db,
		workspaceId,
		actorId: getTestActorId(),
		wsSettings: settings,
		agent: {},
		enterprise: true,
	})

	it('uses a sealed anthropic key and a sealed custom endpoint key', async () => {
		const ws = await newWorkspace()
		await patch(ws.id, { llm_keys: { anthropic: ANTHROPIC } })
		const anthropicOnly = (await storedSettings(ws.id)) as unknown as WorkspaceSettings
		const keyRoute = await resolveLlmRoute(params(ws.id, anthropicOnly))
		expect(keyRoute?.route).toBe(LLM_ROUTE_API_KEY)
		expect(keyRoute?.envVars.ANTHROPIC_API_KEY).toBe(ANTHROPIC)

		await patch(ws.id, { custom_llm: CUSTOM_LLM })
		const withCustom = (await storedSettings(ws.id)) as unknown as WorkspaceSettings
		const customRoute = await resolveLlmRoute(params(ws.id, withCustom))
		expect(customRoute?.route).toBe(LLM_ROUTE_CUSTOM)
		expect(customRoute?.envVars.ANTHROPIC_AUTH_TOKEN).toBe(CUSTOM)
	})

	it('still uses keys saved in plain text before sealing existed', async () => {
		const ws = await newWorkspace({
			llm_keys: { anthropic: ANTHROPIC },
			custom_llm: CUSTOM_LLM,
		})
		const legacy = (await storedSettings(ws.id)) as unknown as WorkspaceSettings
		expect(legacy.llm_keys?.anthropic).toBe(ANTHROPIC)

		const route = await resolveLlmRoute(params(ws.id, legacy))
		expect(route?.route).toBe(LLM_ROUTE_CUSTOM)
		expect(route?.envVars.ANTHROPIC_AUTH_TOKEN).toBe(CUSTOM)

		const chat = resolveChatCredentials({
			wsSettings: legacy,
			agent: { provider: null, apiKey: null, model: null },
			workspace: { enterpriseGranted: true, billingOwnerId: null },
		})
		expect(chat?.apiKey).toBe(CUSTOM)

		// A legacy plain value is readable without the encryption key.
		Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')
		const noKey = await resolveLlmRoute(params(ws.id, legacy))
		expect(noKey?.envVars.ANTHROPIC_AUTH_TOKEN).toBe(CUSTOM)
	})

	it('fails with a clear error, not another route, when the saved key cannot be opened', async () => {
		const ws = await newWorkspace()
		await patch(ws.id, { llm_keys: { anthropic: ANTHROPIC } })
		const sealed = (await storedSettings(ws.id)) as unknown as WorkspaceSettings

		process.env.INTEGRATION_ENCRYPTION_KEY = KEY_B

		const err = await resolveLlmRoute(params(ws.id, sealed)).catch((e: unknown) => e)
		expect(err).toBeInstanceOf(LlmCredentialsUnavailableError)
		const failure = err as LlmCredentialsUnavailableError
		expect(failure.transient).toBe(false)
		expect(failure.detail).toContain('llm_keys.anthropic')
		expect(failure.toFailureReason().human_message).toBe(
			LlmCredentialsUnavailableError.unreadableKeyHumanMessage,
		)
		expect(failure.toFailureReason().human_message).not.toContain('Claude subscription')

		// The best-effort chat path reports "unavailable" instead of throwing.
		expect(
			resolveChatCredentials({
				wsSettings: sealed,
				agent: { provider: null, apiKey: null, model: null },
				workspace: { enterpriseGranted: true, billingOwnerId: null },
			}),
		).toBeNull()

		// And the workspace still lists for its owner, with the key left out.
		const res = await app.request(jsonGet('/api/workspaces'))
		expect(res.status).toBe(200)
		const listed = (await res.json()).find((w: { id: string }) => w.id === ws.id)
		expect(listed.settings.llm_keys.anthropic).toBeUndefined()
		expect(listed.llm_configured.anthropic).toBe(true)
	})

	it('starts on the Maskin plan route when the encryption key is unset and no key is stored', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'FAKE-maskin-fallback-key'
		const ws = await newWorkspace()
		const settings = (await storedSettings(ws.id)) as unknown as WorkspaceSettings
		Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')

		const route = await resolveLlmRoute({
			...params(ws.id, { ...settings, billing: { plan: 'trial' } }),
			enterprise: false,
		})
		expect(route?.route).toBe(LLM_ROUTE_MASKIN_PLAN)
	})
})

describe('without the encryption key', () => {
	it('never stores a key in plain text: the save fails and the row is unchanged', async () => {
		const ws = await newWorkspace()
		const before = await storedSettings(ws.id)
		Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')

		const res = await patch(ws.id, { llm_keys: { anthropic: ANTHROPIC } })
		expect(res.status).toBe(500)
		expect(await storedSettings(ws.id)).toEqual(before)
	})

	it('still saves settings that carry no key', async () => {
		const ws = await newWorkspace()
		Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')

		const res = await patch(ws.id, { max_concurrent_sessions: 7 })
		expect(res.status).toBe(200)
		expect((await storedSettings(ws.id)).max_concurrent_sessions).toBe(7)
	})
})
