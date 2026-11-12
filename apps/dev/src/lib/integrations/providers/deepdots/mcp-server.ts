import type { Database } from '@maskin/db'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { trackIntegrationToolCalled } from '../../../analytics/integration-events'
import { logger } from '../../../logger'
import { IntegrationAuthRevokedError } from '../../errors'
import { getCredential } from '../../lookup'
import { TokenManager } from '../../oauth/token-manager'
import { readContextFor } from '../../read-context'
import {
	DEEPDOTS_BASE_URL,
	DEFAULT_LIMIT,
	type DeepdotsList,
	MAX_LIMIT,
	MAX_SKIP,
	buildListRequest,
	trimPage,
} from './query'

/**
 * In-process MCP server for Deepdots, served over Streamable HTTP at
 * `/api/integrations/deepdots/mcp`. Sibling of the Google Search Console surface.
 *
 * Four read tools: insights, issues, opportunities, topics. Read only, by design: nothing here
 * writes to Deepdots, and tool-kinds.ts lists the provider as all-read.
 *
 * The Deepdots token is resolved here, on the server: getCredential first (access check plus one
 * audit row, attributed to the calling agent), then TokenManager, which renews the one-hour token
 * before it ends. The token never reaches the session, and the agent never sees raw filter JSON
 * (see query.ts).
 *
 * Every call fires integration_tool_called with ids and an outcome only. No arguments, no rows,
 * no error text.
 */
export const DEEPDOTS_PROVIDER = 'deepdots'
export const DEEPDOTS_FETCH_TIMEOUT_MS = 20_000

export interface DeepdotsMcpContext {
	db: Database
	workspaceId: string
	/** The authenticated caller; credential reads are attributed to it. */
	actorId: string
	/** The Maskin session making the call (X-Maskin-Session-Id), for the tool-call event only. */
	sessionId?: string | null
	/** The workspace's active Deepdots integration, null when none is connected. */
	integrationId: string | null
	/** Overridable in tests. */
	getAccessToken?: (
		db: Database,
		input: { workspaceId: string; integrationId: string; actorId: string; outboundTarget: string },
	) => Promise<string>
	fetchImpl?: typeof fetch
	/** Overridable in tests. */
	trackToolCalled?: typeof trackIntegrationToolCalled
}

async function defaultAccessToken(
	db: Database,
	input: { workspaceId: string; integrationId: string; actorId: string; outboundTarget: string },
): Promise<string> {
	// Gate and audit first. TokenManager then decrypts and renews on its own path.
	await getCredential(
		db,
		input.workspaceId,
		input.integrationId,
		readContextFor(input.actorId, input.outboundTarget),
	)
	// Imported lazily, as Search Console does: the registry imports provider modules.
	const { getProvider } = await import('../../registry')
	return new TokenManager().getValidToken(db, input.integrationId, getProvider(DEEPDOTS_PROVIDER))
}

function textResult(payload: unknown, isError = false) {
	return {
		...(isError ? { isError: true as const } : {}),
		content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
	}
}

type ToolResult = ReturnType<typeof textResult>

// A failure carries its code out so the event can report it without reading the message.
type Outcome = { result: ToolResult; errorCode: string | null }

function failure(code: string, message: string): Outcome {
	return { result: textResult({ error: { code, message } }, true), errorCode: code }
}

const NEEDS_ATTENTION_MESSAGE =
	'The Deepdots connection needs attention: the saved sign-in no longer works. Ask a person to reconnect Deepdots under Settings, Integrations. This is not an outage, so do not retry.'

/** Every Deepdots failure, mapped to a code and a message that says what to do. */
function failureForStatus(status: number): Outcome {
	if (status === 401 || status === 403) {
		return failure('NEEDS_ATTENTION', NEEDS_ATTENTION_MESSAGE)
	}
	if (status === 405) {
		return failure(
			'NOT_ALLOWED',
			'Deepdots refused this read for the connected user (it lacks permission for this data). Ask a person to connect a Deepdots user that can read feedback.',
		)
	}
	if (status === 429 || status >= 500) {
		return failure(
			'TEMPORARILY_UNAVAILABLE',
			'Deepdots is busy or down right now. Try again later.',
		)
	}
	return failure('REQUEST_FAILED', `Deepdots answered with an unexpected status (${status}).`)
}

const limitField = z
	.number()
	.int()
	.min(1)
	.max(MAX_LIMIT)
	.optional()
	.describe(`How many rows to return, 1 to ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`)
const skipField = z
	.number()
	.int()
	.min(0)
	.max(MAX_SKIP)
	.optional()
	.describe('Rows to skip, for the next page. Use next_skip from the last answer.')
const sinceField = z
	.string()
	.optional()
	.describe('Only rows generated on or after this date, e.g. 2026-11-01.')

export function createDeepdotsMcpServer(
	ctx: DeepdotsMcpContext,
	/** Called before any tool is registered, e.g. to gate tools on the caller's access. */
	onServer?: (server: McpServer) => void,
): McpServer {
	const server = new McpServer(
		{ name: 'maskin-deepdots', version: '0.1.0' },
		{ capabilities: { tools: {} } },
	)
	onServer?.(server)

	const register = (
		tool: string,
		list: DeepdotsList,
		description: string,
		extra: { since: boolean; search: boolean },
	) => {
		const inputSchema = {
			limit: limitField,
			skip: skipField,
			...(extra.since ? { since: sinceField } : {}),
			...(extra.search
				? { search: z.string().max(200).optional().describe('Text to look for in the name.') }
				: {}),
		}
		server.registerTool(
			tool,
			{ description, inputSchema, annotations: { readOnlyHint: true } },
			async (input: { limit?: number; skip?: number; since?: string; search?: string }) => {
				const outcome = await runList(ctx, tool, list, input)
				await (ctx.trackToolCalled ?? trackIntegrationToolCalled)({
					provider: DEEPDOTS_PROVIDER,
					tool,
					outcome: outcome.errorCode ? 'error' : 'success',
					errorCode: outcome.errorCode,
					actorId: ctx.actorId,
					sessionId: ctx.sessionId ?? null,
					workspaceId: ctx.workspaceId,
				})
				return outcome.result
			},
		)
	}

	register(
		'deepdots_list_insights',
		'insights',
		'List the latest Deepdots insights (summaries of customer feedback), newest first: name, summary, status, source system. Returns items, has_more and next_skip.',
		{ since: true, search: false },
	)
	register(
		'deepdots_list_issues',
		'issues',
		"List the latest Deepdots issues found in customer feedback, newest first: name, reason, category, priority, score, an extract in the customer's language, topics. Returns items, has_more and next_skip.",
		{ since: true, search: false },
	)
	register(
		'deepdots_list_opportunities',
		'opportunities',
		'List Deepdots opportunities (FIX, IMPROVE or INTRODUCE, with severity HIGH, MEDIUM or LOW), newest first. search looks in the opportunity name. Returns items, has_more and next_skip.',
		{ since: true, search: true },
	)
	register(
		'deepdots_list_topics',
		'topics',
		'List Deepdots topics with how much feedback they carry and how that changed over 7 and 30 days. Returns items, has_more and next_skip.',
		{ since: false, search: false },
	)

	return server
}

async function runList(
	ctx: DeepdotsMcpContext,
	tool: string,
	list: DeepdotsList,
	input: { limit?: number; skip?: number; since?: string; search?: string },
): Promise<Outcome> {
	const integrationId = ctx.integrationId
	if (!integrationId) {
		return failure('NOT_CONNECTED', 'Deepdots is not connected in this workspace.')
	}

	const built = buildListRequest(list, input)
	if (!built.ok) return failure('INVALID_INPUT', built.message)

	let token: string
	try {
		token = await (ctx.getAccessToken ?? defaultAccessToken)(ctx.db, {
			workspaceId: ctx.workspaceId,
			integrationId,
			actorId: ctx.actorId,
			outboundTarget: new URL(DEEPDOTS_BASE_URL).host,
		})
	} catch (err) {
		// The error name and nothing else: the message of a sign-in failure could carry a login.
		logger.warn('Deepdots MCP could not get a token', {
			workspaceId: ctx.workspaceId,
			integrationId,
			tool,
			error: err instanceof Error ? err.name : 'unknown',
		})
		if (err instanceof IntegrationAuthRevokedError) {
			return failure('NEEDS_ATTENTION', NEEDS_ATTENTION_MESSAGE)
		}
		return failure(
			'TOKEN_UNAVAILABLE',
			'Could not get a valid Deepdots token for this workspace. This may be temporary; if it keeps happening the connection needs attention.',
		)
	}

	let res: Response
	try {
		res = await (ctx.fetchImpl ?? fetch)(built.url, {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
			signal: AbortSignal.timeout(DEEPDOTS_FETCH_TIMEOUT_MS),
		})
	} catch (err) {
		logger.warn('Deepdots MCP request failed', {
			workspaceId: ctx.workspaceId,
			tool,
			error: err instanceof Error ? err.name : 'unknown',
		})
		return failure('REQUEST_FAILED', 'The request to Deepdots did not complete.')
	}

	logger.info('Deepdots MCP call', { workspaceId: ctx.workspaceId, tool, httpStatus: res.status })
	if (!res.ok) return failureForStatus(res.status)

	let body: unknown
	try {
		body = await res.json()
	} catch {
		return failure('UNEXPECTED_RESPONSE', 'Deepdots answered with something that is not JSON.')
	}
	const page = trimPage(list, body, built.limit, Math.max(0, Math.trunc(input.skip ?? 0)))
	if (!page) {
		return failure('UNEXPECTED_RESPONSE', 'Deepdots answered with something that is not a list.')
	}
	return { result: textResult(page), errorCode: null }
}
