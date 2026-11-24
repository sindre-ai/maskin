import { describe, expect, it } from 'vitest'
import { config } from '../../../../lib/integrations/providers/posthog/config'
import {
	KeyRejectedError,
	POSTHOG_CHECK_MESSAGES,
	UnreadableProjectError,
	checkPostHogFirstData,
	parseEventCount,
} from '../../../../lib/integrations/providers/posthog/first-data-check'
import {
	POSTHOG_PROJECT_HEADER,
	parsePostHogProjectId,
	withPostHogProjectPin,
} from '../../../../lib/integrations/providers/posthog/project-pin'

describe('PostHog provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('posthog')
		expect(config.displayName).toBe('PostHog')
	})

	it('uses api_key auth type with no env-backed secret', () => {
		expect(config.auth.type).toBe('api_key')
		if (config.auth.type === 'api_key') {
			expect(config.auth.config.headerName).toBe('Authorization')
			expect(config.auth.config.headerPrefix).toBe('Bearer ')
			expect(config.auth.config.envKeyName).toBeUndefined()
		}
	})

	it('has no webhook config — data is pulled by the MCP, not pushed', () => {
		expect(config.webhook).toBeUndefined()
	})

	it('has no event definitions — no inbound events to normalize', () => {
		expect(config.events).toBeUndefined()
	})

	it('declares autoInject so session-manager wires the MCP for every workspace with an active integration', () => {
		expect(config.mcp).toBeDefined()
		expect(config.mcp?.autoInject).toBe(true)
		expect(config.mcp?.envKey).toBe('POSTHOG_TOKEN')
	})

	it('declares an HTTP server spec matching the frontend INTEGRATION_MCP_PRESETS entry', () => {
		expect(config.mcp?.server).toEqual({
			type: 'http',
			url: 'https://mcp.posthog.com/mcp',
			headers: { Authorization: 'Bearer ${POSTHOG_TOKEN}' },
		})
	})
})

describe('PostHog project pin', () => {
	const server = config.mcp?.server as NonNullable<NonNullable<typeof config.mcp>['server']>

	it('adds the project header when a project is saved', () => {
		const pinned = withPostHogProjectPin(server, { project_id: '12345' })
		expect(pinned).toEqual({
			...server,
			headers: { Authorization: 'Bearer ${POSTHOG_TOKEN}', [POSTHOG_PROJECT_HEADER]: '12345' },
		})
		expect(POSTHOG_PROJECT_HEADER).toBe('x-posthog-project-id')
	})

	it('leaves the server unchanged when no project is saved', () => {
		expect(withPostHogProjectPin(server, null)).toBe(server)
		expect(withPostHogProjectPin(server, {})).toBe(server)
		expect(withPostHogProjectPin(server, { project_id: '' })).toBe(server)
	})

	it('never turns a non-numeric project id into a header', () => {
		expect(withPostHogProjectPin(server, { project_id: '1\r\nX-Evil: 1' })).toBe(server)
	})

	it('accepts numbers, trims, and refuses anything else', () => {
		expect(parsePostHogProjectId(' 123 ')).toEqual({ ok: true, projectId: '123' })
		expect(parsePostHogProjectId(123)).toEqual({ ok: true, projectId: '123' })
		expect(parsePostHogProjectId('')).toEqual({ ok: true, projectId: null })
		expect(parsePostHogProjectId(undefined)).toEqual({ ok: true, projectId: null })
		expect(parsePostHogProjectId('abc')).toEqual({ ok: false })
		expect(parsePostHogProjectId('12 34')).toEqual({ ok: false })
		expect(parsePostHogProjectId({})).toEqual({ ok: false })
	})
})

describe('PostHog first-data check', () => {
	it('says nothing when the project has events', async () => {
		expect(await checkPostHogFirstData('phx_key', '7', async () => 42)).toEqual({
			status: 'has_events',
			message: null,
		})
	})

	it('says no events in this project, and names the project', async () => {
		const pinned = await checkPostHogFirstData('phx_key', '7', async () => 0)
		expect(pinned.status).toBe('no_events')
		expect(pinned.message).toBe('No events in this project yet. Checked project 7.')
		const unpinned = await checkPostHogFirstData('phx_key', null, async () => 0)
		expect(unpinned.message).toBe(POSTHOG_CHECK_MESSAGES.noEvents(null))
	})

	it('says the key was rejected, with no raw error', async () => {
		const result = await checkPostHogFirstData('phx_secret', '7', async () => {
			throw new KeyRejectedError('401 phx_secret')
		})
		expect(result).toEqual({ status: 'key_rejected', message: POSTHOG_CHECK_MESSAGES.keyRejected })
		expect(result.message).not.toContain('phx_secret')
	})

	it('says the project cannot be read, with no raw error', async () => {
		for (const failure of [new UnreadableProjectError('x'), new Error('boom phx_secret')]) {
			const result = await checkPostHogFirstData('phx_secret', '7', async () => {
				throw failure
			})
			expect(result).toEqual({
				status: 'project_unreadable',
				message: POSTHOG_CHECK_MESSAGES.projectUnreadable,
			})
			expect(result.message).not.toContain('phx_secret')
		}
	})

	it('keeps the three messages different from each other', () => {
		const messages = new Set([
			POSTHOG_CHECK_MESSAGES.noEvents('1'),
			POSTHOG_CHECK_MESSAGES.keyRejected,
			POSTHOG_CHECK_MESSAGES.projectUnreadable,
		])
		expect(messages.size).toBe(3)
	})

	it('reads the count from the text and the rows forms, and refuses anything else', () => {
		expect(parseEventCount('n\n525034')).toBe(525034)
		expect(parseEventCount('n\n0')).toBe(0)
		expect(parseEventCount(JSON.stringify({ results: [[12]] }))).toBe(12)
		expect(parseEventCount(JSON.stringify({ results: 'n\n9' }))).toBe(9)
		expect(parseEventCount('something went wrong')).toBeNull()
	})
})
