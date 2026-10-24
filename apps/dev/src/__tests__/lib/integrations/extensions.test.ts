import { createHmac } from 'node:crypto'
import {
	MAX_EXTENSION_TOOLS,
	createExtensionBodySchema,
	mcpConfigSchema,
	toolGrantsSchema,
	updateExtensionBodySchema,
	webhookConfigSchema,
} from '@maskin/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	buildCalcomDelivery,
	buildFirefliesDelivery,
} from '../../../../tests/integrations/fixtures/signed-deliveries'
import {
	allowWebhookRequest,
	deliveryEntityId,
	evalJsonPath,
	generateSigningSecret,
	generateWebhookToken,
	grantEffect,
	isStaleDelivery,
	mapWebhookEvent,
	mcpConfigWriteError,
	resetWebhookRateLimits,
	verifyExtensionSignature,
} from '../../../lib/integrations/extensions'
import { VENDOR_RECIPES } from '../../../lib/integrations/vendor-recipes'
import { WebhookHandler } from '../../../lib/integrations/webhooks/handler'

const fireflies = VENDOR_RECIPES.find((r) => r.slug === 'fireflies')

describe('webhookConfigSchema', () => {
	it('round-trips the Fireflies recipe config', () => {
		const parsed = webhookConfigSchema.parse(fireflies?.webhookConfig)
		expect(webhookConfigSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
		expect(parsed.maxAgeSeconds).toBe(300)
		expect(parsed.rateLimit.perMinute).toBe(60)
	})

	it('rejects an unknown signature scheme', () => {
		const bad = { ...fireflies?.webhookConfig, signatureScheme: 'md5' }
		expect(webhookConfigSchema.safeParse(bad).success).toBe(false)
	})

	it('rejects a config with no event map', () => {
		const { eventMap: _drop, ...bad } = fireflies?.webhookConfig ?? ({} as Record<string, unknown>)
		expect(webhookConfigSchema.safeParse(bad).success).toBe(false)
	})

	it('rejects a wrong-typed field', () => {
		const bad = { ...fireflies?.webhookConfig, maxAgeSeconds: '300' }
		expect(webhookConfigSchema.safeParse(bad).success).toBe(false)
	})

	it('requires the timestamp header and template for the timestamp scheme', () => {
		const base = { ...fireflies?.webhookConfig, signatureScheme: 'timestamp' }
		const res = webhookConfigSchema.safeParse(base)
		expect(res.success).toBe(false)
		const ok = webhookConfigSchema.safeParse({
			...base,
			timestampHeader: 'x-slack-request-timestamp',
			timestampBodyTemplate: 'v0:{timestamp}:{body}',
		})
		expect(ok.success).toBe(true)
	})
})

describe('mcpConfigSchema', () => {
	const base = {
		envKey: 'FIREFLIES_TOKEN',
		server: fireflies?.mcpConfig?.server,
		credentialProvider: 'extension-mcp:fireflies',
	}
	const tool = (i: number) => ({ name: `get_thing_${i}`, kind: 'read' as const })

	it('round-trips the Fireflies recipe config', () => {
		const parsed = mcpConfigSchema.parse({ ...base, tools: [tool(1), tool(2)] })
		expect(mcpConfigSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
		expect(parsed.autoInject).toBe(true)
	})

	it('accepts exactly the tool cap', () => {
		const tools = Array.from({ length: MAX_EXTENSION_TOOLS }, (_, i) => tool(i))
		expect(mcpConfigSchema.safeParse({ ...base, tools }).success).toBe(true)
	})

	it('rejects a 21-tool payload with a structured error on tools', () => {
		const tools = Array.from({ length: MAX_EXTENSION_TOOLS + 1 }, (_, i) => tool(i))
		const res = mcpConfigSchema.safeParse({ ...base, tools })
		expect(res.success).toBe(false)
		if (!res.success) expect(res.error.issues[0]?.path).toEqual(['tools'])
	})

	it('rejects a tool with an unknown kind', () => {
		const res = mcpConfigSchema.safeParse({ ...base, tools: [{ name: 'x', kind: 'admin' }] })
		expect(res.success).toBe(false)
	})

	it('rejects a missing server', () => {
		const { server: _drop, ...bad } = base
		expect(mcpConfigSchema.safeParse(bad).success).toBe(false)
	})
})

describe('toolGrantsSchema', () => {
	it('accepts plain and expiring grant values', () => {
		const grants = {
			'agent-1': {
				get_transcript: 'allow',
				delete_transcript: 'deny',
				search: { effect: 'allow', expires_at: '2026-12-01T00:00:00.000Z', grant_id: 'g1' },
				list: { effect: 'deny', expires_at: null, grant_id: 'g2' },
			},
		}
		const parsed = toolGrantsSchema.parse(grants)
		expect(grantEffect(parsed['agent-1']?.get_transcript ?? 'deny')).toBe('allow')
		expect(grantEffect(parsed['agent-1']?.search ?? 'deny')).toBe('allow')
		expect(grantEffect(parsed['agent-1']?.list ?? 'allow')).toBe('deny')
	})

	it('rejects a grant that is neither allow, deny nor the object form', () => {
		expect(toolGrantsSchema.safeParse({ a: { t: 'maybe' } }).success).toBe(false)
		expect(toolGrantsSchema.safeParse({ a: { t: { effect: 'allow' } } }).success).toBe(false)
	})
})

describe('extension request bodies', () => {
	it('rejects a slug with uppercase or spaces', () => {
		const res = createExtensionBodySchema.safeParse({ slug: 'My Ext', name: 'x' })
		expect(res.success).toBe(false)
	})

	it('does not accept a slug on update (immutable)', () => {
		expect(updateExtensionBodySchema.safeParse({ slug: 'new-slug' }).success).toBe(false)
		expect(updateExtensionBodySchema.safeParse({ name: 'New name' }).success).toBe(true)
	})
})

describe('evalJsonPath', () => {
	it('reads nested keys, bracket keys and array indexes', () => {
		const payload = { a: { b: [{ c: 'deep' }, { c: 'second' }] }, 'odd key': 7 }
		expect(evalJsonPath(payload, '$.a.b[1].c')).toBe('second')
		expect(evalJsonPath(payload, "$['odd key']")).toBe(7)
		expect(evalJsonPath(payload, '$')).toBe(payload)
	})

	it('returns undefined for missing paths, null parents and type mismatches', () => {
		expect(evalJsonPath({ a: null }, '$.a.b')).toBeUndefined()
		expect(evalJsonPath({ a: [1] }, '$.a.b')).toBeUndefined()
		expect(evalJsonPath({ a: { b: 1 } }, '$.a[0]')).toBeUndefined()
		expect(evalJsonPath({}, '$.missing')).toBeUndefined()
	})

	it('treats unsupported syntax as no match instead of throwing', () => {
		expect(evalJsonPath({ a: [1, 2] }, '$.a[*]')).toBeUndefined()
		expect(evalJsonPath({ a: 1 }, 'a')).toBeUndefined()
		expect(evalJsonPath({ a: 1 }, '$..a')).toBeUndefined()
	})
})

describe('mapWebhookEvent', () => {
	const eventMap = {
		externalIdPath: '$.meeting_id',
		entityType: { literal: 'fireflies.transcript' },
		action: { literal: 'ready' },
	}

	it('maps a flat Fireflies payload', () => {
		const payload = { event: 'meeting.transcribed', meeting_id: 'abc123' }
		const res = mapWebhookEvent(eventMap, payload)
		expect(res).toEqual({
			ok: true,
			event: {
				externalId: 'abc123',
				entityType: 'fireflies.transcript',
				action: 'ready',
				data: payload,
			},
		})
	})

	it('maps a nested Cal.com payload with path-driven action', () => {
		const payload = { triggerEvent: 'BOOKING_CREATED', payload: { uid: 'bk_1' } }
		const res = mapWebhookEvent(
			{
				externalIdPath: '$.payload.uid',
				entityType: { literal: 'calcom.booking' },
				action: { path: '$.triggerEvent' },
				dataPath: '$.payload',
			},
			payload,
		)
		expect(res).toMatchObject({
			ok: true,
			event: { externalId: 'bk_1', action: 'BOOKING_CREATED', data: { uid: 'bk_1' } },
		})
	})

	it('reads an id out of an array element and stringifies numbers', () => {
		const res = mapWebhookEvent(
			{ ...eventMap, externalIdPath: '$.items[0].id' },
			{ items: [{ id: 42 }] },
		)
		expect(res).toMatchObject({ ok: true, event: { externalId: '42' } })
	})

	it('fails on the external id when the path is missing', () => {
		const res = mapWebhookEvent(eventMap, { event: 'x' })
		expect(res).toMatchObject({ ok: false, field: 'externalId' })
	})

	it('fails on a null or empty id value', () => {
		expect(mapWebhookEvent(eventMap, { meeting_id: null })).toMatchObject({ ok: false })
		expect(mapWebhookEvent(eventMap, { meeting_id: '' })).toMatchObject({ ok: false })
		expect(mapWebhookEvent(eventMap, { meeting_id: { nested: 1 } })).toMatchObject({ ok: false })
	})

	it('names the action field when its path does not resolve', () => {
		const res = mapWebhookEvent({ ...eventMap, action: { path: '$.nope' } }, { meeting_id: 'a' })
		expect(res).toMatchObject({ ok: false, field: 'action' })
	})

	it('fails when dataPath does not resolve', () => {
		const res = mapWebhookEvent({ ...eventMap, dataPath: '$.body' }, { meeting_id: 'a' })
		expect(res).toMatchObject({ ok: false, field: 'data' })
	})
})

describe('verifyExtensionSignature', () => {
	const handler = new WebhookHandler()
	const secret = 'a'.repeat(64)
	const firefliesConfig = webhookConfigSchema.parse(fireflies?.webhookConfig)

	it('accepts a signed Fireflies delivery (X-Hub-Signature, sha256= prefix)', () => {
		const d = buildFirefliesDelivery({ secret })
		expect(verifyExtensionSignature(handler, firefliesConfig, d.body, d.headers, secret)).toBe(true)
	})

	it('rejects a Fireflies delivery signed with another secret', () => {
		const d = buildFirefliesDelivery({ secret: 'b'.repeat(64) })
		expect(verifyExtensionSignature(handler, firefliesConfig, d.body, d.headers, secret)).toBe(
			false,
		)
	})

	it('accepts a Cal.com delivery (raw hex, no prefix)', () => {
		const d = buildCalcomDelivery({ secret })
		const cfg = webhookConfigSchema.parse({
			signatureScheme: 'hmac-sha256',
			signatureHeader: 'X-Cal-Signature-256',
			eventMap: {
				externalIdPath: '$.payload.uid',
				entityType: { literal: 'calcom.booking' },
				action: { path: '$.triggerEvent' },
			},
		})
		expect(verifyExtensionSignature(handler, cfg, d.body, d.headers, secret)).toBe(true)
	})

	it('checks the timestamp scheme with the extension maxAgeSeconds', () => {
		const cfg = webhookConfigSchema.parse({
			signatureScheme: 'timestamp',
			signatureHeader: 'X-Slack-Signature',
			signaturePrefix: 'v0=',
			timestampHeader: 'X-Slack-Request-Timestamp',
			timestampBodyTemplate: 'v0:{ts}:{body}',
			maxAgeSeconds: 60,
			eventMap: fireflies?.webhookConfig?.eventMap,
		})
		const body = '{"a":1}'
		const sign = (ts: string) =>
			`v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`
		const fresh = String(Math.floor(Date.now() / 1000))
		const old = String(Math.floor(Date.now() / 1000) - 120)
		const headersFor = (ts: string) => ({
			'x-slack-request-timestamp': ts,
			'x-slack-signature': sign(ts),
		})
		expect(verifyExtensionSignature(handler, cfg, body, headersFor(fresh), secret)).toBe(true)
		expect(verifyExtensionSignature(handler, cfg, body, headersFor(old), secret)).toBe(false)
	})
})

describe('isStaleDelivery', () => {
	const cfg = (extra: Record<string, unknown>) =>
		webhookConfigSchema.parse({ ...fireflies?.webhookConfig, ...extra })
	const now = 1_760_000_000_000

	it('is never stale when no timestamp header is configured', () => {
		expect(isStaleDelivery(cfg({}), {}, now)).toBe(false)
	})

	it('flags a delivery older than maxAgeSeconds, in seconds or milliseconds', () => {
		const c = cfg({ timestampHeader: 'x-ts', maxAgeSeconds: 300 })
		expect(isStaleDelivery(c, { 'x-ts': String(now / 1000 - 301) }, now)).toBe(true)
		expect(isStaleDelivery(c, { 'x-ts': String(now - 301_000) }, now)).toBe(true)
		expect(isStaleDelivery(c, { 'x-ts': String(now / 1000 - 299) }, now)).toBe(false)
	})

	it('flags a non-numeric timestamp', () => {
		expect(isStaleDelivery(cfg({ timestampHeader: 'x-ts' }), { 'x-ts': 'yesterday' }, now)).toBe(
			true,
		)
	})
})

describe('allowWebhookRequest', () => {
	beforeEach(() => resetWebhookRateLimits())

	it('allows perMinute requests per token, then refuses', () => {
		for (let i = 0; i < 3; i++) expect(allowWebhookRequest('tok', 3, 1000)).toBe(true)
		expect(allowWebhookRequest('tok', 3, 1000)).toBe(false)
		expect(allowWebhookRequest('other', 3, 1000)).toBe(true)
	})

	it('opens a fresh window after a minute', () => {
		for (let i = 0; i < 3; i++) allowWebhookRequest('tok', 3, 1000)
		expect(allowWebhookRequest('tok', 3, 1000 + 60_000)).toBe(true)
	})
})

describe('generators', () => {
	it('mints a 32-byte hex secret and a url-safe token', () => {
		expect(generateSigningSecret()).toMatch(/^[0-9a-f]{64}$/)
		expect(generateWebhookToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(generateWebhookToken()).not.toBe(generateWebhookToken())
	})

	it('derives a stable uuid for one extension and external id', () => {
		const a = deliveryEntityId('ext-1', 'ASxwZxCstx')
		expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
		expect(deliveryEntityId('ext-1', 'ASxwZxCstx')).toBe(a)
		expect(deliveryEntityId('ext-2', 'ASxwZxCstx')).not.toBe(a)
	})
})

describe('mcpConfigWriteError', () => {
	const stdio = mcpConfigSchema.parse({
		envKey: 'AUTHORIZATION',
		server: { type: 'stdio', command: 'npx', args: ['mcp-remote', 'https://example.com/mcp'] },
		credentialProvider: 'extension:example',
	})

	it('accepts a stdio server', () => {
		expect(mcpConfigWriteError(stdio)).toBeNull()
	})

	it('accepts no config at all', () => {
		expect(mcpConfigWriteError(null)).toBeNull()
		expect(mcpConfigWriteError(undefined)).toBeNull()
	})

	it('rejects the http variant with a plain message', () => {
		const http = mcpConfigSchema.parse({
			...stdio,
			server: { type: 'http', url: 'https://example.com/mcp' },
		})
		expect(mcpConfigWriteError(http)).toMatch(/stdio/i)
	})
})
