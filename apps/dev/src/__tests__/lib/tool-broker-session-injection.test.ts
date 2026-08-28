import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	buildToolBrokerPreamble,
	resolveToolBrokerInjection,
} from '../../lib/tool-broker/session-injection'

const WORKSPACE = '80c5991d-d328-49f2-adad-1c2d86c08f28'
const ACTOR = 'f06b724e-618a-4111-914d-5554062fe155'

// One indexed read, stubbed. The point of these tests is the GATE — what happens
// when the feature is off — not the query itself.
const makeDb = (row: unknown) =>
	({
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => (row ? [row] : []) }) }),
		}),
	}) as never

const provisionedRow = {
	toolkitSlug: 'tk-w80c',
	toolkitId: 'tk_1',
	status: 'active',
	connectedNames: ['DeepWiki', 'Petstore'],
}

const resolve = (db: unknown) =>
	resolveToolBrokerInjection(db as never, {
		sessionId: 'sess-1',
		workspaceId: WORKSPACE,
		actorId: ACTOR,
		internalApiUrl: 'http://host.docker.internal:3000',
	})

beforeEach(() => {
	process.env.TOOL_BROKER_URL = 'http://localhost:4789'
	process.env.TOOL_BROKER_SESSION_SECRET = 'a'.repeat(48)
})

afterEach(() => {
	delete process.env.TOOL_BROKER_URL
	delete process.env.TOOL_BROKER_SESSION_SECRET
	vi.restoreAllMocks()
})

describe('the off switch', () => {
	it('returns null when TOOL_BROKER_URL is unset', async () => {
		// Config, not the feature flag, is what makes the backend path exist. With
		// no URL a session must be byte-identical to one launched before this
		// feature was written.
		delete process.env.TOOL_BROKER_URL
		expect(await resolve(makeDb(provisionedRow))).toBeNull()
	})

	it('returns null when the signing secret is unset', async () => {
		// Minting a token without a secret would either throw during launch or, if
		// it defaulted, produce a forgeable token. Neither is acceptable, so the
		// feature simply does not engage.
		delete process.env.TOOL_BROKER_SESSION_SECRET
		expect(await resolve(makeDb(provisionedRow))).toBeNull()
	})

	it('returns null when the workspace has no toolkit', async () => {
		expect(await resolve(makeDb(null))).toBeNull()
	})

	it('does not touch the database when the feature is unconfigured', async () => {
		delete process.env.TOOL_BROKER_URL
		const select = vi.fn()
		await resolve({ select } as never)
		// Cheap gate first: an unconfigured deployment pays nothing per launch.
		expect(select).not.toHaveBeenCalled()
	})
})

describe('when provisioned', () => {
	it('points the MCP entry at our proxy, not at the backend', async () => {
		const injection = await resolve(makeDb(provisionedRow))

		expect(injection?.mcpServer.url).toBe('http://host.docker.internal:3000/api/tool-broker/mcp')
		// The broker's own address must never reach a container.
		expect(injection?.mcpServer.url).not.toContain('4789')
	})

	it('passes the token as an envsubst placeholder, not inline', async () => {
		const injection = await resolve(makeDb(provisionedRow))

		// The literal token goes to the container as a reserved env var; baking it
		// into the MCP JSON would put it in the session config too.
		expect(injection?.mcpServer.headers.Authorization).toBe('Bearer ${TOOL_BROKER_SESSION_TOKEN}')
		expect(injection?.sessionToken).toBeTruthy()
		expect(injection?.mcpServer.headers.Authorization).not.toContain(injection?.sessionToken ?? '')
	})

	it('names the connected integrations in the preamble', async () => {
		const injection = await resolve(makeDb(provisionedRow))

		// Naming them is the whole point: an unnamed pointer loses to a tool the
		// agent already knows.
		expect(injection?.preamble).toContain('DeepWiki, Petstore')
	})
})

describe('buildToolBrokerPreamble', () => {
	it('teaches the three-step workflow and the result union', async () => {
		const preamble = buildToolBrokerPreamble(['Linear'])

		expect(preamble).toContain('skills({ name: "execute" })')
		expect(preamble).toContain('tools.search({ query })')
		expect(preamble).toContain('tools.describe.tool({ path })')
		expect(preamble).toContain('{ ok: false, error }')
	})

	it('stays readable when nothing is connected yet', async () => {
		const preamble = buildToolBrokerPreamble([])

		expect(preamble).not.toContain('undefined')
		expect(preamble).not.toContain(', ,')
		expect(preamble).toContain('external integrations')
	})

	it('ends with a blank line so it cannot run into the agent prompt', async () => {
		// It is prepended to SYSTEM_PROMPT; without the separator the last sentence
		// would merge into the agent's own first line.
		expect(buildToolBrokerPreamble(['X'])).toMatch(/\n\n$/)
	})
})
