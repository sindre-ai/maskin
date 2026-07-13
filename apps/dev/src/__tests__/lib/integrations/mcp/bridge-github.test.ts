import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
	mockConnect,
	mockListTools,
	mockCallTool,
	mockClose,
	MockStdioClientTransport,
	mockFetchInstallationOwnerLogin,
} = vi.hoisted(() => ({
	mockConnect: vi.fn(),
	mockListTools: vi.fn(),
	mockCallTool: vi.fn(),
	mockClose: vi.fn(),
	MockStdioClientTransport: vi.fn(),
	mockFetchInstallationOwnerLogin: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
	Client: vi.fn().mockImplementation(() => ({
		connect: mockConnect,
		listTools: mockListTools,
		callTool: mockCallTool,
		close: mockClose,
	})),
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
	StdioClientTransport: MockStdioClientTransport,
}))

vi.mock('../../../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../../../lib/integrations/providers/github/auth', () => ({
	fetchInstallationOwnerLogin: mockFetchInstallationOwnerLogin,
}))

import {
	buildGithubProviderContext,
	createMcpSession,
	resolveInstallationExists,
} from '../../../../lib/integrations/mcp/bridge'
import { TaggedGithubError } from '../../../../lib/integrations/providers/github/error-tagger'
import { stampTokenMetadata } from '../../../../lib/integrations/providers/github/token-metadata'

const INSTALLATION_ID = '12345678'
const FRESH_TOKEN = 'ghs_test_freshtoken0000'

function freshTokenMeta() {
	return stampTokenMetadata(FRESH_TOKEN, INSTALLATION_ID)
}

describe('createMcpSession — non-github providers', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue({ tools: [] })
	})

	it('passes tool call errors through unchanged when providerContext is absent', async () => {
		mockCallTool.mockRejectedValue(new Error('boom 500'))
		const session = await createMcpSession('node', [], {})
		await expect(session.executeTool('tool', {})).rejects.toMatchObject({
			message: 'boom 500',
		})
	})

	it('passes tool call errors through unchanged for non-github providerContext', async () => {
		mockCallTool.mockRejectedValue(new Error('slack unavailable 500'))
		const session = await createMcpSession('node', [], {}, { provider: 'slack' })
		const thrown = await session.executeTool('tool', {}).catch((e) => e)
		expect(thrown).toBeInstanceOf(Error)
		expect(thrown).not.toBeInstanceOf(TaggedGithubError)
		expect(thrown.message).toBe('slack unavailable 500')
	})

	it('returns success payload untouched when provider is not github', async () => {
		mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
		const session = await createMcpSession('node', [], {}, { provider: 'linear' })
		await expect(session.executeTool('tool', {})).resolves.toBe('ok')
	})
})

describe('createMcpSession — github wrapping', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockConnect.mockResolvedValue(undefined)
		mockListTools.mockResolvedValue({ tools: [] })
	})

	it('tags a 401 failure as `401-unauth` when the token was just minted', async () => {
		mockCallTool.mockRejectedValue(new Error('Requires authentication: status 401'))
		const session = await createMcpSession(
			'node',
			[],
			{},
			{
				provider: 'github',
				tokenMetadata: freshTokenMeta(),
			},
		)

		const thrown = (await session.executeTool('create_pull_request', {}).catch((e) => e)) as unknown
		expect(thrown).toBeInstanceOf(TaggedGithubError)
		const tagged = thrown as TaggedGithubError
		expect(tagged.cause_tag).toBe('401-unauth')
		expect(tagged.installation_id).toBe(INSTALLATION_ID)
	})

	it('tags a 403 failure as `403-permission`', async () => {
		mockCallTool.mockRejectedValue(new Error('Permission denied: status 403'))
		const session = await createMcpSession(
			'node',
			[],
			{},
			{
				provider: 'github',
				tokenMetadata: freshTokenMeta(),
			},
		)

		const thrown = (await session.executeTool('merge_pull_request', {}).catch((e) => e)) as unknown
		expect(thrown).toBeInstanceOf(TaggedGithubError)
		expect((thrown as TaggedGithubError).cause_tag).toBe('403-permission')
	})

	it('tags a 422 failure as `schema-validation`', async () => {
		mockCallTool.mockRejectedValue(
			new Error('invalid_type: pull_number expected number received string: status 422'),
		)
		const session = await createMcpSession(
			'node',
			[],
			{},
			{
				provider: 'github',
				tokenMetadata: freshTokenMeta(),
			},
		)

		const thrown = (await session.executeTool('get_pr', {}).catch((e) => e)) as unknown
		expect(thrown).toBeInstanceOf(TaggedGithubError)
		expect((thrown as TaggedGithubError).cause_tag).toBe('schema-validation')
	})

	it('tags a 401 as `token-expired-mid-session` when the install id no longer resolves', async () => {
		mockCallTool.mockRejectedValue(new Error('Bad credentials: status 401'))
		mockFetchInstallationOwnerLogin.mockRejectedValue(
			new Error('Failed to fetch installation owner: 404 not found'),
		)
		const session = await createMcpSession(
			'node',
			[],
			{},
			{
				provider: 'github',
				tokenMetadata: freshTokenMeta(),
				resolveInstallation: resolveInstallationExists,
			},
		)

		const thrown = (await session.executeTool('merge_pull_request', {}).catch((e) => e)) as unknown
		expect(thrown).toBeInstanceOf(TaggedGithubError)
		expect((thrown as TaggedGithubError).cause_tag).toBe('token-expired-mid-session')
	})

	it('tags a failure as `missing-token` when no tokenMetadata is threaded', async () => {
		mockCallTool.mockRejectedValue(new Error('Requires authentication: status 401'))
		const session = await createMcpSession(
			'node',
			[],
			{},
			{
				provider: 'github',
			},
		)

		const thrown = (await session.executeTool('create_pr', {}).catch((e) => e)) as unknown
		expect(thrown).toBeInstanceOf(TaggedGithubError)
		expect((thrown as TaggedGithubError).cause_tag).toBe('missing-token')
	})

	it('passes success payload through untouched', async () => {
		mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'merged' }] })
		const session = await createMcpSession(
			'node',
			[],
			{},
			{
				provider: 'github',
				tokenMetadata: freshTokenMeta(),
			},
		)

		await expect(session.executeTool('merge_pull_request', {})).resolves.toBe('merged')
	})
})

describe('buildGithubProviderContext', () => {
	it('stamps a fresh TokenMetadata and wires resolveInstallation', () => {
		const ctx = buildGithubProviderContext({ token: FRESH_TOKEN, installationId: INSTALLATION_ID })
		expect(ctx.provider).toBe('github')
		expect(ctx.tokenMetadata?.token).toBe(FRESH_TOKEN)
		expect(ctx.tokenMetadata?.installationId).toBe(INSTALLATION_ID)
		expect(ctx.resolveInstallation).toBe(resolveInstallationExists)
	})
})

describe('resolveInstallationExists', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('returns true when fetchInstallationOwnerLogin succeeds', async () => {
		mockFetchInstallationOwnerLogin.mockResolvedValue('sindre-ai')
		await expect(resolveInstallationExists('42')).resolves.toBe(true)
	})

	it('returns false when fetchInstallationOwnerLogin throws a 404 error', async () => {
		mockFetchInstallationOwnerLogin.mockRejectedValue(
			new Error('Failed to fetch installation owner: 404 not found'),
		)
		await expect(resolveInstallationExists('42')).resolves.toBe(false)
	})

	it('rethrows non-404 errors so a network blip is not mistaken for install churn', async () => {
		mockFetchInstallationOwnerLogin.mockRejectedValue(
			new Error('Failed to fetch installation owner: 500 server error'),
		)
		await expect(resolveInstallationExists('42')).rejects.toThrow(/500 server error/)
	})
})
