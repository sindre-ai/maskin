import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import type { Database } from '@maskin/db'
import type { LinkedInMcpInstanceConfig } from '@maskin/mcp/linkedin'
import {
	__resetLinkedInMcpRegistryForTests,
	instanceSlug,
	registerLinkedInMcpInstance,
} from '@maskin/mcp/linkedin'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../lib/workspace-auth', () => ({
	isWorkspaceMember: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../lib/integrations/providers/linkedin-unipile/enumeration', () => ({
	enumerateLinkedInIdentitiesAndRegister: vi.fn(),
}))

import { enumerateLinkedInIdentitiesAndRegister } from '../../lib/integrations/providers/linkedin-unipile/enumeration'
import { __resetLinkedInMcpSelfHealForTests } from '../../lib/integrations/providers/linkedin-unipile/mcp-registry-self-heal'

const mockedEnumerate = vi.mocked(enumerateLinkedInIdentitiesAndRegister)

/**
 * The per-identity route must never answer a request for an identity of an
 * ACTIVE credential with a silent empty tool list. Drives the real route and
 * real self-heal over HTTP; only the Unipile enumeration boundary is mocked.
 */

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_ID = 'cred-a'

function personal(integrationId: string): LinkedInMcpInstanceConfig {
	return {
		workspaceId: WORKSPACE_ID,
		actorId: ACTOR_ID,
		integrationId,
		unipileAccountId: `unipile-${integrationId}`,
		unipileAccSlug: 'test-acc',
		identityType: 'personal',
		identityUrn: `urn:li:person:${integrationId}`,
		identitySlug: 'personal',
		displayName: 'Test User',
		mailboxId: 'CLASSIC_PRIMARY',
		messagingEnabled: true,
	}
}

const VALID_SLUG = instanceSlug(personal(INTEGRATION_ID))

function enumerateOk(integrationId: string) {
	const cfg = personal(integrationId)
	registerLinkedInMcpInstance(cfg)
	return { unipileAccSlug: 'test-acc', instances: [cfg] }
}

function activeRow() {
	return {
		id: INTEGRATION_ID,
		workspaceId: WORKSPACE_ID,
		actorId: ACTOR_ID,
		createdBy: ACTOR_ID,
		externalId: `unipile-${INTEGRATION_ID}`,
		status: 'active',
	}
}

let rows: ReturnType<typeof activeRow>[] = []
const fakeDb = {
	select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
} as unknown as Database

describe('linkedin-unipile MCP route — explicit errors instead of an empty tool list', () => {
	let server: ReturnType<typeof serve>
	let baseUrl: string

	beforeAll(async () => {
		const { OpenAPIHono } = await import('@hono/zod-openapi')
		const { default: mcpRoutes } = await import('../integrations-linkedin-unipile-mcp')
		const app = new OpenAPIHono<{
			Variables: { db: Database; actorId: string; actorType: string }
		}>()
		app.use('*', async (c, next) => {
			c.set('db', fakeDb)
			c.set('actorId', ACTOR_ID)
			c.set('actorType', 'human')
			await next()
		})
		app.route('/', mcpRoutes)

		server = serve({ fetch: app.fetch, port: 0 })
		await new Promise<void>((resolveReady) => {
			server.on('listening', () => resolveReady())
			if (server.listening) resolveReady()
		})
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	})

	afterAll(async () => {
		await new Promise<void>((resolveClose, rejectClose) =>
			server.close((err) => (err ? rejectClose(err) : resolveClose())),
		)
	})

	beforeEach(() => {
		__resetLinkedInMcpRegistryForTests()
		__resetLinkedInMcpSelfHealForTests()
		mockedEnumerate.mockReset()
		rows = [activeRow()]
	})

	async function rpc(slug: string, method: string, params: unknown = {}) {
		const res = await fetch(`${baseUrl}/${slug}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				'X-Workspace-Id': WORKSPACE_ID,
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		})
		const text = await res.text()
		return {
			status: res.status,
			body: JSON.parse(text) as {
				result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] }
				error?: { code: number; message: string; data?: Record<string, unknown> }
			},
		}
	}

	it('AC1 — enumeration failure on an active credential gives a retryable LINKEDIN_UNAVAILABLE error on tools/list, not zero tools', async () => {
		mockedEnumerate.mockRejectedValue(new Error('RATE_LIMITED_LINKEDIN'))

		const { status, body } = await rpc(VALID_SLUG, 'tools/list')

		expect(status).toBe(200)
		expect(body.result).toBeUndefined()
		expect(body.error?.message).toContain('LINKEDIN_UNAVAILABLE')
		expect(body.error?.message).toContain('retryable: true')
		expect(body.error?.data).toMatchObject({ code: 'LINKEDIN_UNAVAILABLE', retryable: true })
	})

	it('AC1 — tools/call on the same failure returns an isError result carrying the code', async () => {
		mockedEnumerate.mockRejectedValue(new Error('unipile is down'))

		const { body } = await rpc(VALID_SLUG, 'tools/call', { name: 'anything', arguments: {} })

		expect(body.result?.isError).toBe(true)
		expect(body.result?.content?.[0]?.text).toContain('LINKEDIN_UNAVAILABLE')
	})

	it('AC1 — a second request inside the negative-cache window errors without calling Unipile again', async () => {
		mockedEnumerate.mockRejectedValue(new Error('unipile is down'))
		await rpc(VALID_SLUG, 'tools/list')
		expect(mockedEnumerate).toHaveBeenCalledTimes(2) // first attempt + the one retry

		const { body } = await rpc(VALID_SLUG, 'tools/list')

		expect(body.error?.message).toContain('LINKEDIN_UNAVAILABLE')
		expect(mockedEnumerate).toHaveBeenCalledTimes(2)
	})

	it('AC2 — a transient failure followed by success within the retry returns the tools', async () => {
		mockedEnumerate
			.mockRejectedValueOnce(new Error('RATE_LIMITED_LINKEDIN'))
			.mockImplementationOnce(async ({ integrationId }) => enumerateOk(integrationId))

		const { body } = await rpc(VALID_SLUG, 'tools/list')

		expect(mockedEnumerate).toHaveBeenCalledTimes(2)
		expect(body.error).toBeUndefined()
		expect(body.result?.tools?.length ?? 0).toBeGreaterThan(0)
	})

	it('AC3 — a slug that matches nothing returns an error naming the valid slugs', async () => {
		mockedEnumerate.mockImplementation(async ({ integrationId }) => enumerateOk(integrationId))

		const { body } = await rpc('linkedin-wrong-slug', 'tools/list')

		expect(body.error?.message).toContain('LINKEDIN_IDENTITY_NOT_FOUND')
		expect(body.error?.message).toContain('linkedin-wrong-slug')
		expect(body.error?.message).toContain(VALID_SLUG)
		expect(body.error?.data).toMatchObject({ retryable: false, validSlugs: [VALID_SLUG] })
	})

	it('AC4 — a workspace with no active credential (disconnected or revoked) keeps the pre-change answer, with no LinkedIn error code', async () => {
		rows = []

		const { body } = await rpc(VALID_SLUG, 'tools/list')

		expect(mockedEnumerate).not.toHaveBeenCalled()
		expect(JSON.stringify(body)).not.toContain('LINKEDIN_UNAVAILABLE')
		expect(JSON.stringify(body)).not.toContain('LINKEDIN_IDENTITY_NOT_FOUND')
	})
})
