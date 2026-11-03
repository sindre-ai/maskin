import type { Database } from '@maskin/db'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { logger } from '../../../logger'
import { getCredential } from '../../lookup'
import { TokenManager } from '../../oauth/token-manager'
import { readContextFor } from '../../read-context'
import {
	SITEMAP_DELETED,
	SITEMAP_SUBMITTED,
	canManageSitemaps,
	checkSitemapUnderProperty,
	lastSitemapAction,
	recordSitemapAction,
	sitePath,
	sitemapPath,
	sitemapsPath,
} from './sitemaps'
import { GSC_FETCH_TIMEOUT_MS, GSC_PROVIDER } from './sync'

/**
 * In-process MCP server for Google Search Console, served over Streamable HTTP at
 * `/api/integrations/google-search-console/mcp`. Sibling of the Google Meet surface.
 *
 * Reads: `inspect_url` (URL Inspection API), `list_sites` (sites list with permission
 * level), `list_sitemaps` and `get_sitemap`. Writes: `submit_sitemap` and `delete_sitemap`.
 * Which of these an agent may call is decided by the access gate (tool-kinds.ts lists the
 * reads; every other tool here is a write). Requesting indexing and adding or removing
 * properties are deliberately not offered.
 *
 * The token is resolved here, on the server: getCredential first (access check plus one
 * audit row, attributed to the calling agent), then the same TokenManager the daily sync
 * uses. It never reaches the session. Tools return Google's raw HTTP status next to the
 * body so a caller can tell SERVICE_DISABLED or a permission error from a good answer.
 *
 * No retries: these are manual checks, and each inspection counts against the property's
 * daily quota. `submit_sitemap` makes a few requests (permission check, submit, read back)
 * on one token read.
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
	/** Overridable in tests. */
	findLastSitemapAction?: typeof lastSitemapAction
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

	const siteUrlField = z
		.string()
		.min(1)
		.describe('The property exactly as list_sites returns it, e.g. sc-domain:maskin.io.')
	const sitemapUrlField = z
		.string()
		.min(1)
		.describe('Absolute sitemap URL under the property, e.g. https://maskin.io/sitemap.xml.')

	server.registerTool(
		'list_sitemaps',
		{
			description:
				"List the sitemaps Search Console has for a property, each with lastSubmitted, isPending, errors and warnings. Returns Google's HTTP status and the sitemap list or Google's error.",
			inputSchema: { site_url: siteUrlField },
			annotations: { readOnlyHint: true },
		},
		async ({ site_url }) =>
			callGoogle(ctx, 'list_sitemaps', sitemapsPath(site_url), { method: 'GET' }),
	)

	server.registerTool(
		'get_sitemap',
		{
			description:
				"Read one sitemap's status in Search Console: lastSubmitted, lastDownloaded, isPending, errors, warnings. Returns Google's HTTP status and the sitemap or Google's error (404 when Search Console does not have it).",
			inputSchema: { site_url: siteUrlField, sitemap_url: sitemapUrlField },
			annotations: { readOnlyHint: true },
		},
		async ({ site_url, sitemap_url }) =>
			callGoogle(ctx, 'get_sitemap', sitemapPath(site_url, sitemap_url), { method: 'GET' }),
	)

	server.registerTool(
		'submit_sitemap',
		{
			description:
				'Submit a sitemap for a property, then read its status back. The sitemap URL must sit under the property, and the connected account must be an owner or full user of it. Submitting the same sitemap again is safe: it asks Google to fetch it again.',
			inputSchema: { site_url: siteUrlField, sitemap_url: sitemapUrlField },
			annotations: { destructiveHint: false, idempotentHint: true },
		},
		async ({ site_url, sitemap_url }) => {
			const check = checkSitemapUnderProperty(site_url, sitemap_url)
			if (!check.ok) return failure('INVALID_SITEMAP_URL', check.message)
			const sitemapUrl = check.sitemapUrl
			return withGoogle(ctx, 'submit_sitemap', async ({ google, integrationId }) => {
				const refused = await requireManagePermission(google, site_url)
				if (refused) return refused
				const path = sitemapPath(site_url, sitemapUrl)
				const put = await google(path, { method: 'PUT' })
				if (!put.ok) return writeFailure(put)

				// Only after Google answered ok: a refused submit must not make a later delete legal.
				const warning = await record(ctx, SITEMAP_SUBMITTED, {
					integrationId,
					property: site_url,
					sitemapUrl,
				})
				const status = await google(path, { method: 'GET' })
				return textResult({
					http_status: put.status,
					submitted: true,
					sitemap: status.ok ? status.body : null,
					...(status.ok ? {} : { status_read_failed: { http_status: status.status } }),
					...(warning ? { warning } : {}),
				})
			})
		},
	)

	server.registerTool(
		'delete_sitemap',
		{
			description:
				'Remove a sitemap from a property in Search Console. Only sitemaps submitted through submit_sitemap can be removed; one added in the Search Console UI is refused. The connected account must be an owner or full user of the property.',
			inputSchema: { site_url: siteUrlField, sitemap_url: sitemapUrlField },
			annotations: { destructiveHint: true },
		},
		async ({ site_url, sitemap_url }) => {
			const check = checkSitemapUnderProperty(site_url, sitemap_url)
			if (!check.ok) return failure('INVALID_SITEMAP_URL', check.message)
			const sitemapUrl = check.sitemapUrl
			return withGoogle(ctx, 'delete_sitemap', async ({ google, integrationId }) => {
				const last = await (ctx.findLastSitemapAction ?? lastSitemapAction)(ctx.db, {
					workspaceId: ctx.workspaceId,
					property: site_url,
					sitemapUrl,
				})
				if (last !== SITEMAP_SUBMITTED) {
					return failure(
						'NOT_SUBMITTED_BY_MASKIN',
						'Maskin has no record of submitting this sitemap, or it was already removed, so it will not delete it. A sitemap added in Search Console has to be removed there.',
					)
				}
				const refused = await requireManagePermission(google, site_url)
				if (refused) return refused
				const del = await google(sitemapPath(site_url, sitemapUrl), { method: 'DELETE' })
				if (!del.ok) return writeFailure(del)

				const warning = await record(ctx, SITEMAP_DELETED, {
					integrationId,
					property: site_url,
					sitemapUrl,
				})
				return textResult({
					http_status: del.status,
					deleted: true,
					...(warning ? { warning } : {}),
				})
			})
		},
	)

	return server
}

function textResult(payload: unknown, isError = false) {
	return {
		...(isError ? { isError: true as const } : {}),
		content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
	}
}

type ToolResult = ReturnType<typeof textResult>

function failure(code: string, message: string): ToolResult {
	return textResult({ error: { code, message } }, true)
}

interface GoogleReply {
	status: number
	ok: boolean
	body: unknown
}

type GoogleCall = (url: string, init: RequestInit) => Promise<GoogleReply>

/** Carries a finished error result out of a request that could not complete. */
class ToolFailure extends Error {
	constructor(readonly result: ToolResult) {
		super('tool failure')
	}
}

/**
 * Runs one tool against Google. The token is read on the first request and reused for the
 * rest, so a tool that makes several requests leaves one credential audit row.
 */
async function withGoogle(
	ctx: GscMcpContext,
	operation: string,
	run: (session: { google: GoogleCall; integrationId: string }) => Promise<ToolResult>,
): Promise<ToolResult> {
	const integrationId = ctx.integrationId
	if (!integrationId) {
		return failure('NOT_CONNECTED', 'Google Search Console is not connected in this workspace.')
	}

	let token: string | undefined
	const google: GoogleCall = async (url, init) => {
		if (token === undefined) {
			try {
				token = await (ctx.getAccessToken ?? defaultAccessToken)(ctx.db, {
					workspaceId: ctx.workspaceId,
					integrationId,
					actorId: ctx.actorId,
					outboundTarget: new URL(url).host,
				})
			} catch (err) {
				logger.warn('Search Console MCP could not get a token', {
					workspaceId: ctx.workspaceId,
					integrationId,
					operation,
					error: err instanceof Error ? err.name : 'unknown',
				})
				throw new ToolFailure(
					failure(
						'TOKEN_UNAVAILABLE',
						'Could not get a valid Search Console token for this workspace. The connection may need to be reconnected.',
					),
				)
			}
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
			throw new ToolFailure(failure('REQUEST_FAILED', 'The request to Google did not complete.'))
		}

		const text = await res.text()
		let body: unknown = text
		try {
			body = JSON.parse(text)
		} catch {
			// Not JSON (an HTML error page, or an empty 204): keep the raw text.
		}
		logger.info('Search Console MCP call', {
			workspaceId: ctx.workspaceId,
			operation,
			httpStatus: res.status,
		})
		return { status: res.status, ok: res.ok, body }
	}

	try {
		return await run({ google, integrationId })
	} catch (err) {
		if (err instanceof ToolFailure) return err.result
		throw err
	}
}

function callGoogle(ctx: GscMcpContext, operation: string, url: string, init: RequestInit) {
	return withGoogle(ctx, operation, async ({ google }) => {
		const reply = await google(url, init)
		return textResult({ http_status: reply.status, body: reply.body }, !reply.ok)
	})
}

/**
 * The write tools' pre-check: the property must exist for this account and the account
 * must be an owner or full user of it. Returns an error result, or null when allowed.
 */
async function requireManagePermission(
	google: GoogleCall,
	property: string,
): Promise<ToolResult | null> {
	const site = await google(sitePath(property), { method: 'GET' })
	if (!site.ok) return textResult({ http_status: site.status, body: site.body }, true)
	const level = (site.body as { permissionLevel?: unknown } | null)?.permissionLevel
	if (canManageSitemaps(level)) return null
	return failure(
		'PROPERTY_NOT_WRITABLE',
		`The connected Google account is "${String(level)}" on ${property}. Only an owner or full user can submit or remove sitemaps.`,
	)
}

// Google's wording when the token was granted read-only access.
const INSUFFICIENT_SCOPE = /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i

/** A failed write. A read-only token gets a plain message that says what a person must do. */
function writeFailure(reply: GoogleReply): ToolResult {
	if (reply.status === 403 && INSUFFICIENT_SCOPE.test(JSON.stringify(reply.body))) {
		return failure(
			'RECONNECT_REQUIRED',
			'Google refused because this connection only has read permission. A person must reconnect Google Search Console with the broader permission under Settings → Integrations.',
		)
	}
	return textResult({ http_status: reply.status, body: reply.body }, true)
}

/**
 * Writes the audit row that delete_sitemap later reads. Google has already acted, so a
 * failure here is reported in the result instead of turning a done change into an error.
 */
async function record(
	ctx: GscMcpContext,
	action: typeof SITEMAP_SUBMITTED | typeof SITEMAP_DELETED,
	input: { integrationId: string; property: string; sitemapUrl: string },
): Promise<string | null> {
	try {
		await recordSitemapAction(ctx.db, action, {
			workspaceId: ctx.workspaceId,
			actorId: ctx.actorId,
			...input,
		})
		return null
	} catch (err) {
		logger.error('Search Console MCP could not record a sitemap action', {
			workspaceId: ctx.workspaceId,
			action,
			error: err instanceof Error ? err.name : 'unknown',
		})
		return action === SITEMAP_SUBMITTED
			? 'Google accepted the sitemap, but Maskin could not record it, so delete_sitemap will refuse to remove it.'
			: 'Google removed the sitemap, but Maskin could not record it.'
	}
}
