import type { Database } from '@maskin/db'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { logger } from '../../../logger'
import { getCredential } from '../../lookup'
import { TokenManager } from '../../oauth/token-manager'
import { readContextFor } from '../../read-context'
import { GSC_FETCH_TIMEOUT_MS, GSC_PROVIDER } from './sync'

/**
 * In-process MCP server for Google Search Console, served over Streamable HTTP at
 * `/api/integrations/google-search-console/mcp`. Sibling of the Google Meet surface.
 *
 * Two read-only tools, nothing else: `inspect_url` (URL Inspection API) and
 * `list_sites` (sites list with permission level). The token is resolved here, on
 * the server: getCredential first (access check plus one audit row, attributed to the
 * calling agent), then the same TokenManager the daily sync uses. It never reaches
 * the session. Both tools return Google's raw HTTP status next to the body so a
 * caller can tell SERVICE_DISABLED or a permission error from a good answer.
 *
 * One request per call, no retries: these are manual checks, and each inspection
 * counts against the property's daily quota.
 */
export interface GscMcpContext {
	db: Database
	workspaceId: string
	/** The authenticated caller; credential reads are attributed to it. */
	actorId: string
	/** The workspace's active Search Console integration, null when none is connected. */
	integrationId: string | null
	/** Overridable in tests. */
	getAccessToken?: (
		db: Database,
		input: { workspaceId: string; integrationId: string; actorId: string; outboundTarget: string },
	) => Promise<string>
	fetchImpl?: typeof fetch
}

export const GSC_INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect'
export const GSC_SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites'

async function defaultAccessToken(
	db: Database,
	input: { workspaceId: string; integrationId: string; actorId: string; outboundTarget: string },
): Promise<string> {
	// Gate and audit first. TokenManager then decrypts and refreshes on its own path.
	await getCredential(
		db,
		input.workspaceId,
		input.integrationId,
		readContextFor(input.actorId, input.outboundTarget),
	)
	// Imported lazily: the registry imports sync.ts for the postInstall hook.
	const { getProvider } = await import('../../registry')
	return new TokenManager().getValidToken(db, input.integrationId, getProvider(GSC_PROVIDER))
}

export function createGscMcpServer(
	ctx: GscMcpContext,
	/** Called before any tool is registered, e.g. to gate tools on the caller's access. */
	onServer?: (server: McpServer) => void,
): McpServer {
	const server = new McpServer(
		{ name: 'maskin-google-search-console', version: '0.1.0' },
		{ capabilities: { tools: {} } },
	)
	onServer?.(server)

	server.registerTool(
		'inspect_url',
		{
			description:
				"Ask Google Search Console whether one URL is indexed (URL Inspection API). Returns Google's HTTP status and either inspectionResult (indexStatusResult: verdict, coverageState, lastCrawlTime, googleCanonical, ...) or Google's error. site_url must be the property exactly as list_sites returns it, e.g. sc-domain:maskin.io. Each call uses one of the property's 2,000 daily inspections.",
			inputSchema: {
				inspection_url: z.string().url().describe('Fully qualified URL under the property.'),
				site_url: z
					.string()
					.min(1)
					.describe('The property as Search Console lists it, e.g. sc-domain:maskin.io.'),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ inspection_url, site_url }) =>
			callGoogle(ctx, 'inspect_url', GSC_INSPECT_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ inspectionUrl: inspection_url, siteUrl: site_url }),
			}),
	)

	server.registerTool(
		'list_sites',
		{
			description:
				"List the Search Console properties the connected account can see, with each permissionLevel (siteOwner, siteFullUser, siteRestrictedUser, siteUnverifiedUser). Returns Google's HTTP status and the siteEntry list or Google's error.",
			inputSchema: {},
			annotations: { readOnlyHint: true },
		},
		async () => callGoogle(ctx, 'list_sites', GSC_SITES_URL, { method: 'GET' }),
	)

	return server
}

function textResult(payload: unknown, isError = false) {
	return {
		...(isError ? { isError: true as const } : {}),
		content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
	}
}

async function callGoogle(ctx: GscMcpContext, operation: string, url: string, init: RequestInit) {
	if (!ctx.integrationId) {
		return textResult(
			{
				error: {
					code: 'NOT_CONNECTED',
					message: 'Google Search Console is not connected in this workspace.',
				},
			},
			true,
		)
	}

	let token: string
	try {
		token = await (ctx.getAccessToken ?? defaultAccessToken)(ctx.db, {
			workspaceId: ctx.workspaceId,
			integrationId: ctx.integrationId,
			actorId: ctx.actorId,
			outboundTarget: new URL(url).host,
		})
	} catch (err) {
		logger.warn('Search Console MCP could not get a token', {
			workspaceId: ctx.workspaceId,
			integrationId: ctx.integrationId,
			operation,
			error: err instanceof Error ? err.name : 'unknown',
		})
		return textResult(
			{
				error: {
					code: 'TOKEN_UNAVAILABLE',
					message:
						'Could not get a valid Search Console token for this workspace. The connection may need to be reconnected.',
				},
			},
			true,
		)
	}

	let res: Response
	try {
		res = await (ctx.fetchImpl ?? fetch)(url, {
			...init,
			headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(GSC_FETCH_TIMEOUT_MS),
		})
	} catch (err) {
		logger.warn('Search Console MCP request failed', {
			workspaceId: ctx.workspaceId,
			operation,
			error: err instanceof Error ? err.name : 'unknown',
		})
		return textResult(
			{ error: { code: 'REQUEST_FAILED', message: 'The request to Google did not complete.' } },
			true,
		)
	}

	const text = await res.text()
	let body: unknown = text
	try {
		body = JSON.parse(text)
	} catch {
		// Not JSON (an HTML error page): keep the raw text.
	}
	logger.info('Search Console MCP call', {
		workspaceId: ctx.workspaceId,
		operation,
		httpStatus: res.status,
	})
	return textResult({ http_status: res.status, body }, !res.ok)
}
