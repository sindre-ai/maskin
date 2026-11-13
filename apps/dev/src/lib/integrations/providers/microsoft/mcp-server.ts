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
	type Built,
	DEFAULT_LIMIT,
	type GraphEvent,
	MAX_LIMIT,
	SEARCH_SCAN_LIMIT,
	UTC_HEADERS,
	UTC_TEXT_HEADERS,
	buildGetRequest,
	buildListRequest,
	buildSearchRequest,
	matchesQuery,
	trimEvent,
} from './calendar'
import { MICROSOFT_PROVIDER } from './config'
import { GRAPH_BASE, GraphError, graphJson } from './graph'

/**
 * In-process MCP server for the Outlook calendar, served over Streamable HTTP at
 * `/api/integrations/microsoft/mcp`. Sibling of the Deepdots and Search Console surfaces.
 *
 * Three read tools: list events, get one event, search events. Read only, by design: nothing here
 * writes to Microsoft (only GET addresses are built, the sign-in holds Calendars.Read and no write
 * scope), and tool-kinds.ts lists exactly these three names as reads.
 *
 * The calendar is the one of the person who connected Microsoft. The token is resolved here, on the
 * server: getCredential first (access check plus one audit row, attributed to the calling agent),
 * then TokenManager, which renews it. It never reaches the session.
 *
 * Every call fires integration_tool_called with ids and an outcome only. No arguments, no events,
 * no error text.
 */
export const MICROSOFT_FETCH_TIMEOUT_MS = 20_000

/** Pages read for one search (100 events each); see SEARCH_SCAN_LIMIT. */
const SEARCH_MAX_PAGES = SEARCH_SCAN_LIMIT / 100

export interface MicrosoftMcpContext {
	db: Database
	workspaceId: string
	/** The authenticated caller; credential reads are attributed to it. */
	actorId: string
	/** The Maskin session making the call (X-Maskin-Session-Id), for the tool-call event only. */
	sessionId?: string | null
	/** The workspace's active Microsoft integration, null when none is connected. */
	integrationId: string | null
	/** Overridable in tests. */
	getAccessToken?: (
		db: Database,
		input: { workspaceId: string; integrationId: string; actorId: string; outboundTarget: string },
	) => Promise<string>
	fetchImpl?: typeof fetch
	now?: () => Date
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
	return new TokenManager().getValidToken(db, input.integrationId, getProvider(MICROSOFT_PROVIDER))
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
	'The Microsoft connection needs attention: the saved sign-in no longer works. Ask a person to reconnect Microsoft under Settings, Integrations. This is not an outage, so do not retry.'

/** Every Graph failure, mapped to a code and a message that says what to do. */
function failureForGraph(err: GraphError): Outcome {
	if (err.status === 401) return failure('NEEDS_ATTENTION', NEEDS_ATTENTION_MESSAGE)
	if (err.status === 403) {
		return failure(
			'NOT_ALLOWED',
			'Microsoft refused this calendar read (the connected account has not allowed Maskin to read its calendar, or the company blocks it). Ask a person to reconnect Microsoft and accept calendar access, or to ask their IT admin.',
		)
	}
	if (err.status === 404) {
		return failure('NOT_FOUND', 'Microsoft has no event with that id (it may have been deleted).')
	}
	if (err.status === 429 || err.status >= 500) {
		return failure(
			'TEMPORARILY_UNAVAILABLE',
			'Microsoft is busy or down right now. Try again later.',
		)
	}
	return failure('REQUEST_FAILED', `Microsoft answered with an unexpected status (${err.status}).`)
}

const fromField = z
	.string()
	.optional()
	.describe(
		'Start of the window. A date (2026-11-13) means midnight UTC; add a time and offset for a local day, e.g. 2026-11-13T00:00:00+01:00.',
	)
const toField = z.string().optional().describe('End of the window, same format as from.')
const limitField = z
	.number()
	.int()
	.min(1)
	.max(MAX_LIMIT)
	.optional()
	.describe(`How many events to return, 1 to ${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`)

export function createMicrosoftMcpServer(
	ctx: MicrosoftMcpContext,
	/** Called before any tool is registered, e.g. to gate tools on the caller's access. */
	onServer?: (server: McpServer) => void,
): McpServer {
	const server = new McpServer(
		{ name: 'maskin-microsoft', version: '0.1.0' },
		{ capabilities: { tools: {} } },
	)
	onServer?.(server)

	/** Runs one tool, then reports the call (ids and outcome only) and returns the result. */
	const respond = async (tool: string, run: () => Promise<Outcome>) => {
		const outcome = await runTool(ctx, tool, run)
		await (ctx.trackToolCalled ?? trackIntegrationToolCalled)({
			provider: MICROSOFT_PROVIDER,
			tool,
			outcome: outcome.errorCode ? 'error' : 'success',
			errorCode: outcome.errorCode,
			actorId: ctx.actorId,
			sessionId: ctx.sessionId ?? null,
			workspaceId: ctx.workspaceId,
		})
		return outcome.result
	}

	const now = () => (ctx.now ?? (() => new Date()))()
	const graph = <T>(url: string, token: string, headers: Record<string, string>) =>
		graphJson<T>(
			url,
			token,
			{
				fetch: (input, init) =>
					(ctx.fetchImpl ?? fetch)(input, {
						...init,
						signal: AbortSignal.timeout(MICROSOFT_FETCH_TIMEOUT_MS),
					}),
			},
			headers,
		)
	/** Validates first, then gets a token, then runs the call. */
	const withBuilt = async <T>(
		tool: string,
		built: Built<T>,
		call: (ok: T, token: string) => Promise<Outcome>,
	): Promise<Outcome> => {
		if (!built.ok) return failure('INVALID_INPUT', built.message)
		const token = await tokenFor(ctx, tool)
		if (typeof token !== 'string') return token
		return call(built, token)
	}

	server.registerTool(
		'outlook_list_events',
		{
			description:
				"List events on the connected person's Outlook calendar in a time window, in start order. Defaults to the next 7 days. Times are UTC. Returns events and has_more; narrow from and to to see the rest.",
			inputSchema: { from: fromField, to: toField, limit: limitField },
			annotations: { readOnlyHint: true },
		},
		(input) =>
			respond('outlook_list_events', () =>
				withBuilt('outlook_list_events', buildListRequest(input, now()), async (req, token) => {
					const body = await graph<{ value?: GraphEvent[] }>(req.url, token, UTC_HEADERS)
					const rows = body.value ?? []
					return {
						result: textResult({
							from: req.window.from.toISOString(),
							to: req.window.to.toISOString(),
							events: rows.slice(0, req.limit).map((e) => trimEvent(e)),
							has_more: rows.length > req.limit,
						}),
						errorCode: null,
					}
				}),
			),
	)

	server.registerTool(
		'outlook_get_event',
		{
			description:
				'Open one Outlook calendar event by the id from outlook_list_events or outlook_search_events: attendees and their answers, location, join link and the description as text. Times are UTC.',
			inputSchema: { id: z.string().min(1).max(1_000).describe('The event id.') },
			annotations: { readOnlyHint: true },
		},
		(input) =>
			respond('outlook_get_event', () =>
				withBuilt('outlook_get_event', buildGetRequest(input.id), async (req, token) => {
					const event = await graph<GraphEvent>(req.url, token, UTC_TEXT_HEADERS)
					return { result: textResult({ event: trimEvent(event, true) }), errorCode: null }
				}),
			),
	)

	server.registerTool(
		'outlook_search_events',
		{
			description: `Find Outlook calendar events whose title, place, organizer, attendees or description start contain some text (not case sensitive). Defaults to 30 days back and 90 days ahead; set from and to to look elsewhere. Times are UTC. Returns events, has_more and searched_all (false when the window held more than ${SEARCH_SCAN_LIMIT} events and only the earliest were searched).`,
			inputSchema: {
				query: z.string().min(1).max(200).describe('Text to look for.'),
				from: fromField,
				to: toField,
				limit: limitField,
			},
			annotations: { readOnlyHint: true },
		},
		(input) =>
			respond('outlook_search_events', () =>
				withBuilt('outlook_search_events', buildSearchRequest(input, now()), async (req, token) => {
					const matches: GraphEvent[] = []
					let next: string | undefined = req.url
					let pages = 0
					while (next && pages < SEARCH_MAX_PAGES) {
						const body: { value?: GraphEvent[]; '@odata.nextLink'?: string } = await graph(
							next,
							token,
							UTC_HEADERS,
						)
						matches.push(...(body.value ?? []).filter((e) => matchesQuery(e, req.query)))
						next = body['@odata.nextLink']
						pages++
					}
					return {
						result: textResult({
							from: req.window.from.toISOString(),
							to: req.window.to.toISOString(),
							events: matches.slice(0, req.limit).map((e) => trimEvent(e)),
							has_more: matches.length > req.limit,
							searched_all: next === undefined,
						}),
						errorCode: null,
					}
				}),
			),
	)

	return server
}

/** The access token, or the failure to hand back to the agent. */
async function tokenFor(ctx: MicrosoftMcpContext, tool: string): Promise<string | Outcome> {
	const integrationId = ctx.integrationId
	if (!integrationId) {
		return failure('NOT_CONNECTED', 'Microsoft is not connected in this workspace.')
	}
	try {
		return await (ctx.getAccessToken ?? defaultAccessToken)(ctx.db, {
			workspaceId: ctx.workspaceId,
			integrationId,
			actorId: ctx.actorId,
			outboundTarget: new URL(GRAPH_BASE).host,
		})
	} catch (err) {
		// The error name and nothing else: a refresh failure message could carry token detail.
		logger.warn('Microsoft MCP could not get a token', {
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
			'Could not get a valid Microsoft token for this workspace. This may be temporary; if it keeps happening the connection needs attention.',
		)
	}
}

/** Runs one tool body and turns a Graph or network failure into an agent-readable result. */
async function runTool(
	ctx: MicrosoftMcpContext,
	tool: string,
	body: () => Promise<Outcome>,
): Promise<Outcome> {
	try {
		const outcome = await body()
		logger.info('Microsoft MCP call', {
			workspaceId: ctx.workspaceId,
			tool,
			ok: outcome.errorCode === null,
		})
		return outcome
	} catch (err) {
		if (err instanceof GraphError) {
			logger.warn('Microsoft MCP Graph error', {
				workspaceId: ctx.workspaceId,
				tool,
				httpStatus: err.status,
				code: err.code,
			})
			return failureForGraph(err)
		}
		logger.warn('Microsoft MCP request failed', {
			workspaceId: ctx.workspaceId,
			tool,
			error: err instanceof Error ? err.name : 'unknown',
		})
		return failure('REQUEST_FAILED', 'The request to Microsoft did not complete.')
	}
}
