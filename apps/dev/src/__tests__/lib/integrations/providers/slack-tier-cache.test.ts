import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	SLACK_TIER_CACHE_TTL_MS,
	type SlackIntegrationConfig,
	canUseAssistantWrite,
	probeSlackTier,
	probeSlackTierOnInstall,
	refreshSlackTierIfStale,
} from '../../../../lib/integrations/providers/slack/tier-cache'

// ── Helpers ──────────────────────────────────────────────────────────────────

interface FakeIntegrationRow {
	id: string
	config: SlackIntegrationConfig | null
}

function makeFakeDb() {
	const updateCalls: Array<{ values: unknown; whereCalled: boolean }> = []
	const db = {
		update: () => ({
			set: (values: unknown) => {
				const call = { values, whereCalled: false }
				updateCalls.push(call)
				return {
					where: () => {
						call.whereCalled = true
						return Promise.resolve()
					},
				}
			},
		}),
	}
	return { db, updateCalls }
}

/** Recursively flatten a drizzle SQL fragment into a string for inspection. */
function sqlToString(value: unknown): string {
	if (value == null) return ''
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
		return String(value)
	if (Array.isArray(value)) return value.map(sqlToString).join(' ')
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>
		if ('queryChunks' in obj) return sqlToString(obj.queryChunks)
		if ('value' in obj && Object.keys(obj).length <= 3) return sqlToString(obj.value)
		const ctorName = obj.constructor?.name ?? ''
		if (ctorName.startsWith('Pg') || 'table' in obj) {
			const name = (obj as { name?: string }).name
			return name ? `<col:${name}>` : `<${ctorName}>`
		}
		try {
			return JSON.stringify(obj)
		} catch {
			return `<${ctorName}>`
		}
	}
	return String(value)
}

function jsonOkResponse(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		json: () => Promise.resolve(body),
	} as Response
}

// ── canUseAssistantWrite — sync gate (AC-T6 entry point) ─────────────────────

describe('canUseAssistantWrite', () => {
	const now = 1_700_000_000_000

	it('refuses when the cache reports Free and the entry is fresh', () => {
		const integration = {
			config: { slackTierCache: { tier: 'free' as const, fetchedAt: now - 1000 } },
		}
		expect(canUseAssistantWrite(integration, now)).toBe(false)
	})

	it('allows when the cache reports Paid and the entry is fresh', () => {
		const integration = {
			config: { slackTierCache: { tier: 'paid' as const, fetchedAt: now - 1000 } },
		}
		expect(canUseAssistantWrite(integration, now)).toBe(true)
	})

	it('fails open (allows) when the cache reports unknown but is fresh', () => {
		const integration = {
			config: { slackTierCache: { tier: 'unknown' as const, fetchedAt: now - 1000 } },
		}
		expect(canUseAssistantWrite(integration, now)).toBe(true)
	})

	it('fails open when no cache entry has been written yet', () => {
		expect(canUseAssistantWrite({ config: {} }, now)).toBe(true)
		expect(canUseAssistantWrite({ config: null }, now)).toBe(true)
	})

	it('fails open once the cache entry has gone stale — AC-T6 TTL expiry path', () => {
		const integration = {
			config: {
				slackTierCache: { tier: 'free' as const, fetchedAt: now - SLACK_TIER_CACHE_TTL_MS - 1 },
			},
		}
		// Stale Free entry no longer blocks — the lazy refresher will re-probe
		// and either reconfirm Free (and block again) or upgrade to Paid.
		expect(canUseAssistantWrite(integration, now)).toBe(true)
	})

	it('treats a TTL-boundary entry as just-stale (strictly-less-than TTL)', () => {
		const integration = {
			config: {
				slackTierCache: { tier: 'free' as const, fetchedAt: now - SLACK_TIER_CACHE_TTL_MS },
			},
		}
		expect(canUseAssistantWrite(integration, now)).toBe(true)
	})
})

// ── probeSlackTier — Slack API → tier mapping ────────────────────────────────

describe('probeSlackTier', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('returns Paid when apps.permissions.info lists assistant:write in any scope group', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonOkResponse({
				ok: true,
				info: { team: { scopes: ['chat:write', 'assistant:write'] } },
			}),
		)
		await expect(probeSlackTier('xoxb-paid')).resolves.toBe('paid')
		expect(fetchSpy).toHaveBeenCalledWith(
			'https://slack.com/api/apps.permissions.info',
			expect.objectContaining({
				headers: { Authorization: 'Bearer xoxb-paid' },
			}),
		)
	})

	it('returns Free when ok=true but no assistant:write scope anywhere', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonOkResponse({
				ok: true,
				info: {
					team: { scopes: ['chat:write', 'channels:read'] },
					channel: { scopes: [] },
					user: { scopes: [] },
				},
			}),
		)
		await expect(probeSlackTier('xoxb-free')).resolves.toBe('free')
	})

	it('returns unknown on ok=false (so we fail open, not flip a Paid workspace to Free)', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonOkResponse({ ok: false, error: 'invalid_auth' }),
		)
		await expect(probeSlackTier('xoxb-bad')).resolves.toBe('unknown')
	})

	it('returns unknown on a network failure rather than throwing into the caller', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNRESET'))
		await expect(probeSlackTier('xoxb-anything')).resolves.toBe('unknown')
	})

	it('returns unknown when the response body is not parseable JSON', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: () => Promise.reject(new Error('Unexpected token')),
		} as unknown as Response)
		await expect(probeSlackTier('xoxb-junk')).resolves.toBe('unknown')
	})
})

// ── refreshSlackTierIfStale — lazy hot-path refresh ──────────────────────────

describe('refreshSlackTierIfStale', () => {
	const now = 1_700_000_000_000
	let fetchSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		fetchSpy = vi.spyOn(globalThis, 'fetch')
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('skips the probe entirely when the cache is fresh', async () => {
		const { db, updateCalls } = makeFakeDb()
		const integration: FakeIntegrationRow = {
			id: 'int-1',
			config: { slackTierCache: { tier: 'free', fetchedAt: now - 1000 } },
		}
		// biome-ignore lint/suspicious/noExplicitAny: test fake doesn't need full Database type
		const tier = await refreshSlackTierIfStale(db as any, integration, 'xoxb-x', now)
		expect(tier).toBe('free')
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(updateCalls).toHaveLength(0)
	})

	it('probes and writes a fresh Free entry on cache miss', async () => {
		fetchSpy.mockResolvedValueOnce(
			jsonOkResponse({ ok: true, info: { team: { scopes: ['chat:write'] } } }),
		)
		const { db, updateCalls } = makeFakeDb()
		const integration: FakeIntegrationRow = { id: 'int-1', config: {} }
		// biome-ignore lint/suspicious/noExplicitAny: test fake doesn't need full Database type
		const tier = await refreshSlackTierIfStale(db as any, integration, 'xoxb-free', now)
		expect(tier).toBe('free')
		expect(updateCalls).toHaveLength(1)
		expect(updateCalls[0]?.whereCalled).toBe(true)
		const flat = sqlToString((updateCalls[0]?.values as { config: unknown }).config)
		expect(flat).toContain('jsonb_set')
		expect(flat).toContain('slackTierCache')
		expect(flat).toContain('"tier":"free"')
		expect(flat).toContain(`"fetchedAt":${now}`)
		// The caller's in-memory integration row is mutated so the immediately-following
		// canUseAssistantWrite sync gate sees the new entry without a re-fetch.
		expect(integration.config?.slackTierCache).toEqual({ tier: 'free', fetchedAt: now })
		expect(canUseAssistantWrite(integration, now)).toBe(false)
	})

	it('probes on stale entry — AC-T6 refresh path — and may flip Free → Paid', async () => {
		fetchSpy.mockResolvedValueOnce(
			jsonOkResponse({ ok: true, info: { team: { scopes: ['assistant:write'] } } }),
		)
		const { db, updateCalls } = makeFakeDb()
		const integration: FakeIntegrationRow = {
			id: 'int-1',
			config: {
				slackTierCache: { tier: 'free', fetchedAt: now - SLACK_TIER_CACHE_TTL_MS - 1 },
				system_actor_id: 'actor-keep-me',
			},
		}
		// biome-ignore lint/suspicious/noExplicitAny: test fake doesn't need full Database type
		const tier = await refreshSlackTierIfStale(db as any, integration, 'xoxb-upgraded', now)
		expect(tier).toBe('paid')
		expect(updateCalls).toHaveLength(1)
		// In-memory mutation preserves sibling config keys (system_actor_id) — same
		// guarantee the SQL jsonb_set provides on the row.
		expect(integration.config?.system_actor_id).toBe('actor-keep-me')
		expect(integration.config?.slackTierCache).toEqual({ tier: 'paid', fetchedAt: now })
		expect(canUseAssistantWrite(integration, now)).toBe(true)
	})

	it('keeps the previous cache entry when a probe returns unknown and we already had a reading', async () => {
		fetchSpy.mockRejectedValueOnce(new Error('ECONNRESET'))
		const { db, updateCalls } = makeFakeDb()
		const integration: FakeIntegrationRow = {
			id: 'int-1',
			config: {
				slackTierCache: { tier: 'free', fetchedAt: now - SLACK_TIER_CACHE_TTL_MS - 1 },
			},
		}
		// biome-ignore lint/suspicious/noExplicitAny: test fake doesn't need full Database type
		const tier = await refreshSlackTierIfStale(db as any, integration, 'xoxb-x', now)
		// A transient probe failure must not flip a previous Free reading to fail-open;
		// the old entry is retained and the next successful probe will correct it.
		expect(tier).toBe('free')
		expect(updateCalls).toHaveLength(0)
		expect(integration.config?.slackTierCache?.tier).toBe('free')
	})

	it('writes an unknown entry when the probe fails and there was no prior reading', async () => {
		fetchSpy.mockRejectedValueOnce(new Error('ECONNRESET'))
		const { db, updateCalls } = makeFakeDb()
		const integration: FakeIntegrationRow = { id: 'int-1', config: {} }
		// biome-ignore lint/suspicious/noExplicitAny: test fake doesn't need full Database type
		const tier = await refreshSlackTierIfStale(db as any, integration, 'xoxb-x', now)
		expect(tier).toBe('unknown')
		expect(updateCalls).toHaveLength(1)
		const flat = sqlToString((updateCalls[0]?.values as { config: unknown }).config)
		expect(flat).toContain('"tier":"unknown"')
	})
})

// ── probeSlackTierOnInstall — registry postInstall hook ─────────────────────

describe('probeSlackTierOnInstall', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('probes and seeds the cache from the OAuth credentials', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			jsonOkResponse({ ok: true, info: { team: { scopes: ['assistant:write'] } } }),
		)
		const { db, updateCalls } = makeFakeDb()
		await probeSlackTierOnInstall({
			// biome-ignore lint/suspicious/noExplicitAny: test fake doesn't need full Database type
			db: db as any,
			integrationId: 'int-9',
			workspaceId: 'ws-1',
			credentials: { accessToken: 'xoxb-installed' },
		})
		expect(updateCalls).toHaveLength(1)
		const flat = sqlToString((updateCalls[0]?.values as { config: unknown }).config)
		expect(flat).toContain('"tier":"paid"')
		expect(flat).toContain('slackTierCache')
	})

	it('logs and returns early when credentials carry no access token (no DB write)', async () => {
		const { db, updateCalls } = makeFakeDb()
		await probeSlackTierOnInstall({
			// biome-ignore lint/suspicious/noExplicitAny: test fake doesn't need full Database type
			db: db as any,
			integrationId: 'int-9',
			workspaceId: 'ws-1',
			credentials: {},
		})
		expect(updateCalls).toHaveLength(0)
	})
})
