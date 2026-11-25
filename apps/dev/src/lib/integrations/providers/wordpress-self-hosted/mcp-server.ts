import type { Database } from '@maskin/db'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { trackIntegrationToolCalled } from '../../../analytics/integration-events'
import { logger } from '../../../logger'
import { getCredential } from '../../lookup'
import { readContextFor } from '../../read-context'
import { type SiteFetch, WordPressError, discoverSite, whoAmI, wpCall } from './client'
import { WORDPRESS_SELF_HOSTED_PROVIDER } from './config'
import { type WordPressCredentials, decodeWordPressCredentials } from './credentials'

/**
 * In-process MCP server for a self-hosted WordPress site, served over Streamable HTTP at
 * `/api/integrations/wordpress-self-hosted/mcp`. Sibling of the Deepdots surface.
 *
 * Reads: check connection, list and get posts, pages and media. Writes: create and edit posts and
 * pages. Which is which lives in tool-kinds.ts (a tool not listed there is a write), and the gate in
 * tool-gate.ts refuses a write for an agent whose access is Read. Nothing here decides access.
 *
 * Content safety, by design:
 *  - A new post or page is always a draft: the server sets status "draft" and the tool has no
 *    status input at all.
 *  - An edit never sends a status, and is refused for an item that is already live (published,
 *    scheduled or private), so no agent can change text on the customer's live site by accident.
 *  - No delete, and no upload: media is read only.
 *
 * The site address, username and application password are resolved here, on the server:
 * getCredential first (access check plus one audit row attributed to the calling agent). They never
 * reach the session. Every call to the site goes through safe-fetch.ts.
 *
 * Every call fires integration_tool_called with ids and an outcome only. No arguments, no rows, no
 * error text.
 */
export { WORDPRESS_SELF_HOSTED_PROVIDER }

export interface WordPressMcpContext {
	db: Database
	workspaceId: string
	/** The authenticated caller; credential reads are attributed to it. */
	actorId: string
	sessionId?: string | null
	/** The workspace's active connection, null when none is connected. */
	integrationId: string | null
	/** The site as shown on the connection (host and folder). Audit only. */
	siteLabel?: string | null
	/** Overridable in tests. */
	getCredentials?: (
		db: Database,
		input: { workspaceId: string; integrationId: string; actorId: string; outboundTarget: string },
	) => Promise<WordPressCredentials>
	/** Overridable in tests. */
	fetchImpl?: SiteFetch
	trackToolCalled?: typeof trackIntegrationToolCalled
}

async function defaultCredentials(
	db: Database,
	input: { workspaceId: string; integrationId: string; actorId: string; outboundTarget: string },
): Promise<WordPressCredentials> {
	const credential = await getCredential(
		db,
		input.workspaceId,
		input.integrationId,
		readContextFor(input.actorId, input.outboundTarget),
	)
	const decoded = decodeWordPressCredentials(credential.value)
	if (!decoded)
		throw new WordPressError('UNEXPECTED_RESPONSE', 'The saved connection is unreadable.')
	return decoded
}

function textResult(payload: unknown, isError = false) {
	return {
		...(isError ? { isError: true as const } : {}),
		content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
	}
}
type ToolResult = ReturnType<typeof textResult>
type Outcome = { result: ToolResult; errorCode: string | null }

function failure(code: string, message: string): Outcome {
	return { result: textResult({ error: { code, message } }, true), errorCode: code }
}
function ok(payload: unknown): Outcome {
	return { result: textResult(payload), errorCode: null }
}

const NEEDS_ATTENTION_CODES: ReadonlySet<string> = new Set([
	'BAD_LOGIN',
	'REST_BLOCKED',
	'NOT_WORDPRESS',
])

function fromError(err: unknown): Outcome {
	if (err instanceof WordPressError) {
		const code = NEEDS_ATTENTION_CODES.has(err.code) ? 'NEEDS_ATTENTION' : err.code
		const suffix =
			code === 'NEEDS_ATTENTION'
				? ' Ask a person to check the WordPress connection under Settings, Integrations. This is not an outage, so do not retry.'
				: ''
		return failure(code, `${err.message}${suffix}`)
	}
	return failure('REQUEST_FAILED', 'The request to the site did not complete.')
}

export const MAX_TEXT_CHARS = 60_000
const DEFAULT_PER_PAGE = 20
const MAX_PER_PAGE = 50

const clip = (value: unknown, max: number): string | null =>
	typeof value === 'string' ? value.slice(0, max) : null

/** Plain text from WordPress' rendered HTML, for lists. */
function plain(html: unknown, max: number): string | null {
	if (typeof html !== 'string') return null
	return html
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&#8217;/g, "'")
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max)
}

type Rendered = { rendered?: unknown; raw?: unknown } | undefined
const renderedOf = (v: unknown): Rendered =>
	typeof v === 'object' && v !== null ? (v as Rendered) : undefined

function summary(item: Record<string, unknown>) {
	return {
		id: item.id,
		title: plain(renderedOf(item.title)?.rendered, 300),
		status: item.status,
		slug: clip(item.slug, 200),
		date: item.date,
		modified: item.modified,
		link: clip(item.link, 500),
		excerpt: plain(renderedOf(item.excerpt)?.rendered, 300),
	}
}

function detail(item: Record<string, unknown>) {
	const content = renderedOf(item.content)
	const raw = typeof content?.raw === 'string' ? content.raw : null
	const text = raw ?? (typeof content?.rendered === 'string' ? content.rendered : '')
	return {
		...summary(item),
		content: text.slice(0, MAX_TEXT_CHARS),
		content_is_block_markup: raw !== null,
		content_truncated: text.length > MAX_TEXT_CHARS,
	}
}

function mediaSummary(item: Record<string, unknown>) {
	return {
		id: item.id,
		title: plain(renderedOf(item.title)?.rendered, 300),
		media_type: item.media_type,
		mime_type: item.mime_type,
		alt_text: clip(item.alt_text, 300),
		source_url: clip(item.source_url, 500),
		date: item.date,
		link: clip(item.link, 500),
	}
}

const pageField = z
	.number()
	.int()
	.min(1)
	.max(10_000)
	.optional()
	.describe('Page of results, from 1.')
const perPageField = z
	.number()
	.int()
	.min(1)
	.max(MAX_PER_PAGE)
	.optional()
	.describe(`How many to return, 1 to ${MAX_PER_PAGE}. Default ${DEFAULT_PER_PAGE}.`)
const searchField = z.string().max(200).optional().describe('Text to look for.')
const idField = z.number().int().min(1).describe('The WordPress id of the item.')
const statusFilter = z
	.enum(['any', 'publish', 'draft', 'pending', 'future', 'private'])
	.optional()
	.describe('Only items with this status. Default any.')
const titleField = z.string().max(500)
const contentField = z.string().max(MAX_TEXT_CHARS)
const excerptField = z.string().max(5_000)

type ItemKind = 'posts' | 'pages'

export function createWordPressMcpServer(
	ctx: WordPressMcpContext,
	/** Called before any tool is registered, e.g. to gate tools on the caller's access. */
	onServer?: (server: McpServer) => void,
): McpServer {
	const server = new McpServer(
		{ name: 'maskin-wordpress-self-hosted', version: '0.1.0' },
		{ capabilities: { tools: {} } },
	)
	onServer?.(server)

	/** Registers one tool: connection check, run, one analytics event. */
	const register = <S extends z.ZodRawShape>(
		tool: string,
		description: string,
		inputSchema: S,
		run: (creds: WordPressCredentials, input: z.infer<z.ZodObject<S>>) => Promise<Outcome>,
	) => {
		server.registerTool(
			tool,
			{ description, inputSchema },
			async (input: z.infer<z.ZodObject<S>>) => {
				const outcome = await runTool(ctx, tool, (creds) => run(creds, input))
				await (ctx.trackToolCalled ?? trackIntegrationToolCalled)({
					provider: WORDPRESS_SELF_HOSTED_PROVIDER,
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
	const fetchImpl = ctx.fetchImpl

	register(
		'wordpress_check_connection',
		'Check that the WordPress connection works: the site, who it signs in as, and whether that user can edit posts. Call this first if another tool fails.',
		{},
		async (creds) => {
			const info = await discoverSite(creds.site_url, fetchImpl)
			const me = await whoAmI(creds, fetchImpl)
			return ok({
				site: creds.site_url,
				site_name: info.name,
				signed_in_as: me.name,
				can_edit_posts: me.can_edit_posts,
				application_passwords_listed: info.application_passwords,
			})
		},
	)

	const registerList = (kind: ItemKind, noun: string) =>
		register(
			`wordpress_list_${kind}`,
			`List ${noun} on the WordPress site, newest first: id, title, status, date, link and a short excerpt. Returns items, total and total_pages.`,
			{ page: pageField, per_page: perPageField, search: searchField, status: statusFilter },
			async (creds, input) => {
				const { json, total, totalPages } = await wpCall(
					creds,
					`wp/v2/${kind}`,
					{
						query: {
							context: 'edit',
							page: input.page ?? 1,
							per_page: input.per_page ?? DEFAULT_PER_PAGE,
							search: input.search,
							status: input.status ?? 'any',
							orderby: 'date',
							order: 'desc',
						},
					},
					fetchImpl,
				)
				if (!Array.isArray(json))
					return failure('UNEXPECTED_RESPONSE', 'The site did not answer with a list.')
				return ok({
					items: json.map((i) => summary(i as Record<string, unknown>)),
					total,
					total_pages: totalPages,
				})
			},
		)
	registerList('posts', 'posts')
	registerList('pages', 'pages')

	const registerGet = (kind: ItemKind, noun: string) =>
		register(
			`wordpress_get_${noun}`,
			`Get one ${noun} with its full content. The content is the editor's own text (block markup) when the user may edit it.`,
			{ id: idField },
			async (creds, input) => {
				const { json } = await wpCall(
					creds,
					`wp/v2/${kind}/${input.id}`,
					{ query: { context: 'edit' } },
					fetchImpl,
				)
				return ok(detail(json as Record<string, unknown>))
			},
		)
	registerGet('posts', 'post')
	registerGet('pages', 'page')

	register(
		'wordpress_list_media',
		'List media library items (images, files), newest first: id, title, type, alt text and file address. Read only.',
		{ page: pageField, per_page: perPageField, search: searchField },
		async (creds, input) => {
			const { json, total, totalPages } = await wpCall(
				creds,
				'wp/v2/media',
				{
					query: {
						context: 'edit',
						page: input.page ?? 1,
						per_page: input.per_page ?? DEFAULT_PER_PAGE,
						search: input.search,
						orderby: 'date',
						order: 'desc',
					},
				},
				fetchImpl,
			)
			if (!Array.isArray(json))
				return failure('UNEXPECTED_RESPONSE', 'The site did not answer with a list.')
			return ok({
				items: json.map((i) => mediaSummary(i as Record<string, unknown>)),
				total,
				total_pages: totalPages,
			})
		},
	)
	register(
		'wordpress_get_media',
		'Get one media library item. Read only.',
		{ id: idField },
		async (creds, input) => {
			const { json } = await wpCall(
				creds,
				`wp/v2/media/${input.id}`,
				{ query: { context: 'edit' } },
				fetchImpl,
			)
			return ok(mediaSummary(json as Record<string, unknown>))
		},
	)

	const registerCreate = (kind: ItemKind, noun: string) =>
		register(
			`wordpress_create_${noun}`,
			`Create a new ${noun} as a DRAFT. It is never published: a person publishes it in WordPress. There is no status input. Returns the id and the address to open it in the WordPress editor.`,
			{
				title: titleField.min(1),
				content: contentField.optional(),
				excerpt: excerptField.optional(),
			},
			async (creds, input) => {
				const { json } = await wpCall(
					creds,
					`wp/v2/${kind}`,
					{
						method: 'POST',
						// Built field by field, and status is set here and nowhere else.
						body: {
							status: 'draft',
							title: input.title,
							...(input.content !== undefined ? { content: input.content } : {}),
							...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
						},
					},
					fetchImpl,
				)
				const item = json as Record<string, unknown>
				return ok({ ...summary(item), edit_url: editUrl(creds, kind, item.id) })
			},
		)
	registerCreate('posts', 'post')
	registerCreate('pages', 'page')

	const registerUpdate = (kind: ItemKind, noun: string) =>
		register(
			`wordpress_update_${noun}`,
			`Edit the title, content or excerpt of a ${noun} that is not live yet (a draft or pending item). Items that are published, scheduled or private are refused, and the status can never be changed here. Send only the fields to change.`,
			{
				id: idField,
				title: titleField.min(1).optional(),
				content: contentField.optional(),
				excerpt: excerptField.optional(),
			},
			async (creds, input) => {
				if (
					input.title === undefined &&
					input.content === undefined &&
					input.excerpt === undefined
				) {
					return failure('INVALID_INPUT', 'Send at least one of title, content or excerpt.')
				}
				const { json: current } = await wpCall(
					creds,
					`wp/v2/${kind}/${input.id}`,
					{ query: { context: 'edit', _fields: 'id,status' } },
					fetchImpl,
				)
				const status = (current as { status?: unknown }).status
				if (status !== 'draft' && status !== 'pending' && status !== 'auto-draft') {
					return failure(
						'NOT_ALLOWED',
						`This ${noun} is not a draft (its status is ${typeof status === 'string' ? status : 'unknown'}), so it is not edited here. Create a new draft, or ask a person to edit it in WordPress.`,
					)
				}
				const { json } = await wpCall(
					creds,
					`wp/v2/${kind}/${input.id}`,
					{
						method: 'POST',
						// No status key, ever.
						body: {
							...(input.title !== undefined ? { title: input.title } : {}),
							...(input.content !== undefined ? { content: input.content } : {}),
							...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
						},
					},
					fetchImpl,
				)
				const item = json as Record<string, unknown>
				return ok({ ...summary(item), edit_url: editUrl(creds, kind, item.id) })
			},
		)
	registerUpdate('posts', 'post')
	registerUpdate('pages', 'page')

	return server
}

function editUrl(creds: WordPressCredentials, _kind: ItemKind, id: unknown): string | null {
	return typeof id === 'number'
		? `${creds.site_url}/wp-admin/post.php?post=${id}&action=edit`
		: null
}

async function runTool(
	ctx: WordPressMcpContext,
	tool: string,
	run: (creds: WordPressCredentials) => Promise<Outcome>,
): Promise<Outcome> {
	const integrationId = ctx.integrationId
	if (!integrationId) {
		return failure('NOT_CONNECTED', 'No WordPress site is connected in this workspace.')
	}
	let creds: WordPressCredentials
	try {
		creds = await (ctx.getCredentials ?? defaultCredentials)(ctx.db, {
			workspaceId: ctx.workspaceId,
			integrationId,
			actorId: ctx.actorId,
			outboundTarget: ctx.siteLabel ?? 'wordpress-site',
		})
	} catch (err) {
		// The error name and nothing else: a message could carry a value.
		logger.warn('WordPress MCP could not read the connection', {
			workspaceId: ctx.workspaceId,
			integrationId,
			tool,
			error: err instanceof Error ? err.name : 'unknown',
		})
		return failure(
			'CREDENTIAL_UNAVAILABLE',
			'This agent may not use the WordPress connection, or the saved connection could not be read. Ask a person to check the access under Settings, Integrations.',
		)
	}
	try {
		const outcome = await run(creds)
		logger.info('WordPress MCP call', {
			workspaceId: ctx.workspaceId,
			tool,
			ok: !outcome.errorCode,
		})
		return outcome
	} catch (err) {
		logger.warn('WordPress MCP call failed', {
			workspaceId: ctx.workspaceId,
			tool,
			error: err instanceof WordPressError ? err.code : err instanceof Error ? err.name : 'unknown',
		})
		return fromError(err)
	}
}
