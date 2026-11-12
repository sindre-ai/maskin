import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	MICROSOFT_PROVIDER,
	config,
	parseTokenResponse,
} from '../../../../lib/integrations/providers/microsoft/config'
import {
	GraphError,
	graphJson,
	graphPages,
} from '../../../../lib/integrations/providers/microsoft/graph'
import { vttToMarkdown } from '../../../../lib/integrations/providers/microsoft/vtt'
import { getProvider, listProviders } from '../../../../lib/integrations/registry'
import { integrationScopeGaps } from '../../../../lib/integrations/scope-drift'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers })

describe('Microsoft provider config', () => {
	it('signs in work or school accounts through the multi-tenant organizations endpoint', () => {
		expect(config.name).toBe('microsoft')
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2')
		expect(config.auth.config.authorizationUrl).toBe(
			'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
		)
		expect(config.auth.config.tokenUrl).toBe(
			'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
		)
		expect(config.auth.config.pkce).toBe(true)
		expect(config.auth.config.clientIdEnv).toBe('MICROSOFT_CLIENT_ID')
		expect(config.auth.config.clientSecretEnv).toBe('MICROSOFT_CLIENT_SECRET')
	})

	it('asks for exactly the delegated scopes the poll job uses', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2')
		expect(config.auth.config.scopes).toEqual([
			'offline_access',
			'User.Read',
			'Calendars.Read',
			'OnlineMeetings.Read',
			'OnlineMeetingTranscript.Read.All',
		])
	})

	it('is registered, with no webhook and no MCP server', () => {
		expect(listProviders().map((p) => p.config.name)).toContain(MICROSOFT_PROVIDER)
		const resolved = getProvider(MICROSOFT_PROVIDER)
		expect(resolved.config.webhook).toBeUndefined()
		expect(resolved.config.mcp).toBeUndefined()
		expect(resolved.postInstall).toBeTypeOf('function')
		expect(resolved.resolveExternalId).toBeTypeOf('function')
	})
})

describe('parseTokenResponse', () => {
	it('adds offline_access, which Microsoft never lists, so a healthy install does not read as missing a scope', () => {
		if (config.auth.type !== 'oauth2') throw new Error('expected oauth2')
		const parsed = parseTokenResponse({
			access_token: 'a',
			refresh_token: 'r',
			scope:
				'User.Read Calendars.Read OnlineMeetings.Read OnlineMeetingTranscript.Read.All profile openid email',
		})
		expect(parsed.scope).toContain('offline_access')
		expect(integrationScopeGaps(config, { scope: parsed.scope })).toEqual({
			missing: [],
			needsReconnect: false,
		})
	})

	it('leaves the scope alone when there is no refresh token', () => {
		expect(parseTokenResponse({ access_token: 'a', scope: 'User.Read' })).toEqual({})
	})
})

describe('vttToMarkdown', () => {
	it('names the speaker and merges consecutive cues from the same one', () => {
		const vtt = [
			'WEBVTT',
			'',
			'00:00:01.000 --> 00:00:03.000',
			'<v Ada Lovelace>Hello everyone.</v>',
			'',
			'00:00:03.000 --> 00:00:05.000',
			'<v Ada Lovelace>Shall we start?</v>',
			'',
			'00:00:05.000 --> 00:00:07.000',
			'<v Alan Turing>Yes &amp; thanks.</v>',
			'',
		].join('\n')
		expect(vttToMarkdown(vtt)).toBe(
			'**Ada Lovelace:** Hello everyone. Shall we start?\n\n**Alan Turing:** Yes & thanks.',
		)
	})

	it('reads CRLF files, cue ids and cues without a speaker', () => {
		const vtt = 'WEBVTT\r\n\r\ncue-1\r\n00:00:01.000 --> 00:00:03.000\r\nJust text\r\n\r\n'
		expect(vttToMarkdown(vtt)).toBe('Just text')
	})

	it('returns an empty string for a transcript with no cues yet', () => {
		expect(vttToMarkdown('WEBVTT\n\n')).toBe('')
	})
})

describe('graph client', () => {
	afterEach(() => vi.restoreAllMocks())

	it('reads the transcripts-disabled answer from the inner error code', async () => {
		const fetch = vi.fn(async () =>
			json(
				{
					error: {
						code: 'Forbidden',
						message: 'off',
						innerError: { code: 'GraphAccessToTranscriptsDisabled' },
					},
				},
				403,
			),
		)
		const err = await graphJson('https://graph.microsoft.com/v1.0/x', 't', { fetch }).catch(
			(e) => e,
		)
		expect(err).toBeInstanceOf(GraphError)
		expect(err.isTranscriptsDisabled).toBe(true)
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it('does not treat another 403 as the admin switch', async () => {
		const fetch = vi.fn(async () => json({ error: { code: 'Forbidden' } }, 403))
		const err = await graphJson('https://graph.microsoft.com/v1.0/x', 't', { fetch }).catch(
			(e) => e,
		)
		expect(err.isTranscriptsDisabled).toBe(false)
	})

	it('retries throttling, waiting as long as Retry-After says', async () => {
		const sleep = vi.fn(async () => {})
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(json({}, 429, { 'Retry-After': '2' }))
			.mockResolvedValueOnce(json({ ok: true }))
		await expect(
			graphJson('https://graph.microsoft.com/v1.0/x', 't', { fetch, sleep }),
		).resolves.toEqual({
			ok: true,
		})
		expect(sleep).toHaveBeenCalledWith(2000)
	})

	it('follows nextLink across pages', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				json({ value: [1], '@odata.nextLink': 'https://graph.microsoft.com/next' }),
			)
			.mockResolvedValueOnce(json({ value: [2] }))
		await expect(
			graphPages<number>('https://graph.microsoft.com/first', 't', { fetch }),
		).resolves.toEqual([1, 2])
	})
})
