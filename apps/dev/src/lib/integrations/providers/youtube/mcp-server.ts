import type { Database } from '@maskin/db'
import { sessions } from '@maskin/db/schema'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import {
	type YoutubeOutcome,
	type YoutubeToolName,
	trackYoutubeToolCalled,
} from '../../../analytics/youtube-events'
import { logger } from '../../../logger'
import {
	type ProposeCommon,
	type ProposeInput,
	proposeYoutubeWrite,
} from '../../../youtube/propose'
import { parseChannelRef } from './channel-ref'
import { type YoutubeClientContext, youtubeRead } from './client'
import { type YoutubeErrorCode, isYoutubeError } from './errors'
import {
	prepareUpload,
	prepareVisibilityChange,
	publishVideoInput,
	readUploadStatus,
	uploadStatusInput,
	uploadVideoInput,
} from './upload-tools'

/**
 * In-process MCP server for the YouTube integration, served over Streamable HTTP at
 * /api/integrations/youtube/mcp (mounted in app-factory.ts). Same shape as the Google Meet
 * factory: built per request, so the caller's workspace id and actor id cannot leak across
 * concurrent requests through a shared closure.
 */
export interface YoutubeMcpContext {
	db: Database
	workspaceId: string
	actorId: string
	/** The Maskin session making the call (X-Maskin-Session-Id), for the tool-called event only. */
	sessionId?: string | null
}

const MAX_SEARCH_RESULTS = 10
const MAX_VIDEO_IDS = 50
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

const OUTCOME_BY_CODE: Partial<Record<YoutubeErrorCode, YoutubeOutcome>> = {
	INVALID_INPUT: 'invalid_input',
	QUOTA_EXHAUSTED: 'quota_blocked',
	WORKSPACE_QUOTA_EXHAUSTED: 'quota_blocked',
	CAP_REACHED: 'quota_blocked',
	INVALID_INPUT: 'invalid_input',
	NOT_CONNECTED: 'not_connected',
	RECONSENT_REQUIRED: 'not_connected',
}

/** A session a flow trigger started, as opposed to a person's chat. Best-effort: false on any failure. */
async function startedByTrigger(db: Database, sessionId: string | null | undefined) {
	if (!sessionId) return false
	try {
		const [row] = await db
			.select({ triggerId: sessions.triggerId })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)
		return Boolean(row?.triggerId)
	} catch {
		return false
	}
}

function jsonResult(payload: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

function toolError(tool: string, err: unknown) {
	if (isYoutubeError(err)) {
		logger.info('YouTube MCP tool returned a normalized error', { tool, code: err.code })
		return {
			isError: true as const,
			content: [{ type: 'text' as const, text: JSON.stringify({ error: err.toPayload() }) }],
		}
	}
	// Never put the raw error text in the result or the log: it can carry response content.
	logger.error('YouTube MCP tool unexpected error', { tool })
	return {
		isError: true as const,
		content: [
			{
				type: 'text' as const,
				text: JSON.stringify({
					error: { code: 'PROVIDER_ERROR', message: 'Unexpected upstream error.' },
				}),
			},
		],
	}
}

export function createYoutubeMcpServer(
	ctx: YoutubeMcpContext,
	/** Called before any tool is registered, e.g. to gate tools on the caller's access. */
	onServer?: (server: McpServer) => void,
): McpServer {
	const server = new McpServer(
		{ name: 'maskin-youtube', version: '0.1.0' },
		{ capabilities: { tools: {} } },
	)
	onServer?.(server)
	registerTools(server, ctx)
	return server
}

/**
 * Every tool goes through this one wrapper, so anything that must happen on every youtube__ call
 * has one place to live. It emits one youtube_tool_called event per call, on a cache hit and on a
 * quota refusal too. The event never throws and carries a category, never an error string.
 */
function registerTool<Shape extends z.ZodRawShape>(
	server: McpServer,
	ctx: YoutubeMcpContext,
	name: YoutubeToolName,
	description: string,
	inputSchema: Shape,
	run: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>,
	/** A write tool only asks: it holds the change for a person and says so in its event. */
	options: { write?: boolean } = {},
) {
	const toolName = `youtube__${name}`
	server.registerTool(
		toolName,
		{ description, inputSchema, annotations: { readOnlyHint: !options.write } },
		// The SDK types this callback from the schema shape, which is generic here, so TypeScript
		// cannot resolve it. run() above is what keeps each tool's arguments typed.
		(async (args: unknown) => {
			let outcome: YoutubeOutcome = options.write ? 'pending_approval' : 'ok'
			let result: ReturnType<typeof jsonResult> | ReturnType<typeof toolError>
			try {
				result = jsonResult(await run(args as z.infer<z.ZodObject<Shape>>))
			} catch (err) {
				outcome = (isYoutubeError(err) && OUTCOME_BY_CODE[err.code]) || 'upstream_error'
				result = toolError(toolName, err)
			}
			await trackYoutubeToolCalled({
				workspaceId: ctx.workspaceId,
				agentId: ctx.actorId,
				sessionId: ctx.sessionId ?? null,
				tool: name,
				outcome,
				viaLoop: await startedByTrigger(ctx.db, ctx.sessionId),
			})
			return result
		}) as never,
	)
}

function registerTools(server: McpServer, ctx: YoutubeMcpContext): void {
	const client: YoutubeClientContext = ctx

	registerTool(
		server,
		ctx,
		'get_channel',
		'Get the connected YouTube channel: title, description, subscriber, view and video counts, and the id of its uploads playlist. Returns the channel as the YouTube Data API returns it. Costs 1 quota unit; repeat reads within 15 minutes are served from a cache at no cost. If the Google account owns several channels, the one chosen at connect time is returned.',
		{},
		() =>
			youtubeRead(client, {
				tool: 'youtube__get_channel',
				path: 'channels',
				params: { part: 'snippet,statistics,contentDetails', mine: 'true' },
				units: 1,
			}),
	)

	registerTool(
		server,
		ctx,
		'search',
		"Search public YouTube for videos or channels. Returns up to 10 results as the YouTube Data API returns them (ids and snippets only: read the details with get_public_videos or get_public_channel). Counts against a small daily search allowance shared by the whole product, so search sparingly and prefer a channel id or handle you already have. Repeat searches within 15 minutes are served from a cache at no cost. The results are other creators' public data: use them in this session, do not store them.",
		{
			q: z.string().trim().min(1).max(200).describe('What to search for.'),
			type: z
				.enum(['video', 'channel'])
				.default('video')
				.describe('Search for videos or for channels. Defaults to video.'),
			max_results: z
				.number()
				.int()
				.min(1)
				.max(MAX_SEARCH_RESULTS)
				.default(MAX_SEARCH_RESULTS)
				.describe('How many results, 1 to 10. Defaults to 10.'),
		},
		({ q, type, max_results }) =>
			youtubeRead(client, {
				tool: 'youtube__search',
				path: 'search',
				params: { part: 'snippet', q, type, maxResults: String(max_results) },
				units: 1,
				bucket: 'search',
			}),
	)

	registerTool(
		server,
		ctx,
		'get_public_channel',
		"Get the public details of any YouTube channel: title, description, and subscriber, view and video counts, as the YouTube Data API returns them. Pass a channel id (UC and 22 characters), a handle such as @name, or a channel URL (youtube.com/channel/UC..., youtube.com/@name or youtube.com/user/name). Custom youtube.com/c/ URLs cannot be resolved: search once to find the channel id. Costs 1 quota unit; repeat reads within 15 minutes are served from a cache at no cost. Other creators' data: use it in this session, do not store it.",
		{
			channel: z
				.string()
				.trim()
				.min(1)
				.max(300)
				.describe('A channel id, a handle such as @name, or a channel URL.'),
		},
		({ channel }) =>
			youtubeRead(client, {
				tool: 'youtube__get_public_channel',
				path: 'channels',
				params: { part: 'snippet,statistics', ...parseChannelRef(channel) },
				units: 1,
			}),
	)

	registerTool(
		server,
		ctx,
		'get_public_videos',
		`Get the public details of up to ${MAX_VIDEO_IDS} YouTube videos in one call: title, description, publish date, and view, like and comment counts, as the YouTube Data API returns them. Pass video ids (11 characters each), not URLs. Costs 1 quota unit for the whole batch; repeat reads within 15 minutes are served from a cache at no cost. Other creators' data: use it in this session, do not store it.`,
		{
			ids: z
				.array(
					z.string().regex(VIDEO_ID, 'A video id is 11 letters, digits, dashes or underscores.'),
				)
				.min(1)
				.max(MAX_VIDEO_IDS)
				.describe(`Video ids, 1 to ${MAX_VIDEO_IDS}.`),
		},
		({ ids }) =>
			youtubeRead(client, {
				tool: 'youtube__get_public_videos',
				path: 'videos',
				// Sorted and de-duplicated, so the same set in any order is one cache entry.
				params: { part: 'snippet,statistics', id: [...new Set(ids)].sort().join(',') },
				units: 1,
			}),
	)

	registerWriteTools(server, ctx)
	registerUploadTools(server, ctx)
}

const objectIdField = z
	.string()
	.uuid()
	.describe(
		'The task, bet or flow this change is for. The approval card is posted on it, so the people on it see the request.',
	)
const noteField = z
	.string()
	.max(1000)
	.optional()
	.describe(
		'Why you want this change. Shown on the card as your note, apart from the exact request, which it never replaces.',
	)
const videoIdField = z.string().min(1).max(32).describe('The video id, for example dQw4w9WgXcQ.')

/** Every write tool only asks, and none of them calls Google: see lib/youtube/propose.ts. */
function registerWriteTools(server: McpServer, ctx: YoutubeMcpContext): void {
	const propose = (common: ProposeCommon, request: ProposeInput) =>
		proposeYoutubeWrite(ctx, common, request)
	const write = { write: true }
	const held =
		'Holds the change for a person to approve and returns the id of the held request. It never changes anything on YouTube itself: the change goes out only after a person approves the card, and the request lapses after 7 days. Quota (50 units) is charged when it runs.'

	registerTool(
		server,
		ctx,
		'update_video_metadata',
		`Ask to change the title, description, tags or category of one of your own videos. Give only what should change; the rest stays as it is. ${held}`,
		{
			object_id: objectIdField,
			video_id: videoIdField,
			title: z.string().min(1).max(100).optional().describe('New title, 100 characters at most.'),
			description: z
				.string()
				.max(5000)
				.optional()
				.describe('New description, 5000 characters at most.'),
			tags: z
				.array(z.string().min(1).max(100))
				.max(30)
				.optional()
				.describe('The full new list of tags.'),
			category_id: z.string().min(1).max(8).optional().describe('New YouTube category id.'),
			note: noteField,
		},
		({ object_id, note, ...args }) =>
			propose({ object_id, note }, { tool: 'update_video_metadata', args }),
		write,
	)

	registerTool(
		server,
		ctx,
		'set_thumbnail',
		`Ask to set the thumbnail of one of your own videos to an image file in this workspace (PNG or JPEG, 2 MB at most). The image is fixed when you ask: if the file changes before a person approves, nothing is sent. ${held}`,
		{
			object_id: objectIdField,
			video_id: videoIdField,
			file_id: z.string().uuid().describe('The id of the image file in this workspace.'),
			note: noteField,
		},
		({ object_id, note, ...args }) => propose({ object_id, note }, { tool: 'set_thumbnail', args }),
		write,
	)

	registerTool(
		server,
		ctx,
		'create_playlist',
		`Ask to create a playlist on the connected channel. It is private unless you say otherwise. ${held}`,
		{
			object_id: objectIdField,
			title: z.string().min(1).max(150).describe('Playlist title, 150 characters at most.'),
			description: z.string().max(5000).optional().describe('Playlist description.'),
			privacy_status: z.enum(['private', 'unlisted', 'public']).default('private'),
			note: noteField,
		},
		({ object_id, note, ...args }) =>
			propose({ object_id, note }, { tool: 'create_playlist', args }),
		write,
	)

	registerTool(
		server,
		ctx,
		'add_to_playlist',
		`Ask to add a video to one of your own playlists. ${held}`,
		{
			object_id: objectIdField,
			playlist_id: z.string().min(1).max(64).describe('The id of one of your playlists.'),
			video_id: videoIdField,
			position: z
				.number()
				.int()
				.min(0)
				.optional()
				.describe('Place in the playlist, counting from 0. Default: the end.'),
			note: noteField,
		},
		({ object_id, note, ...args }) =>
			propose({ object_id, note }, { tool: 'add_to_playlist', args }),
		write,
	)

	registerTool(
		server,
		ctx,
		'post_comment',
		`Ask to post a top-level comment on a video. Limits for the whole workspace: 10 comments and replies a day, 3 a day on any one video, and never the same text twice. No comment may offer anything for likes, comments or subscribes. ${held}`,
		{
			object_id: objectIdField,
			video_id: videoIdField,
			text: z.string().min(1).max(5000).describe('The comment, exactly as it should appear.'),
			note: noteField,
		},
		({ object_id, note, ...args }) => propose({ object_id, note }, { tool: 'post_comment', args }),
		write,
	)

	registerTool(
		server,
		ctx,
		'reply_to_comment',
		`Ask to reply to a comment. The video id is needed too, because replies count toward the same limits as comments: 10 a day for the workspace, 3 a day on any one video, and never the same text twice. ${held}`,
		{
			object_id: objectIdField,
			video_id: videoIdField,
			comment_id: z.string().min(1).max(128).describe('The id of the comment to reply to.'),
			text: z.string().min(1).max(5000).describe('The reply, exactly as it should appear.'),
			note: noteField,
		},
		({ object_id, note, ...args }) =>
			propose({ object_id, note }, { tool: 'reply_to_comment', args }),
		write,
	)

	registerTool(
		server,
		ctx,
		'like',
		`Ask to like a video. At most 20 likes a day for the workspace. ${held}`,
		{
			object_id: objectIdField,
			video_id: videoIdField,
			note: noteField,
		},
		({ object_id, note, ...args }) => propose({ object_id, note }, { tool: 'like', args }),
		write,
	)
}

/** Part 5. An upload is always private; making it public is a second request with its own approval. */
function registerUploadTools(server: McpServer, ctx: YoutubeMcpContext): void {
	registerTool(
		server,
		ctx,
		'upload_video',
		'Prepare the upload of a Maskin video file to the connected YouTube channel. Nothing is sent yet: this holds the request and puts an approval card in front of the workspace owners. When a person approves, the server uploads the video as PRIVATE, always, whatever you ask for. To make it unlisted, public or scheduled you need a second approval with youtube__publish_video. Set ai_generated when the video is AI generated or altered. Returns an action id; read the result with youtube__get_upload_status.',
		uploadVideoInput,
		(args) => prepareUpload(ctx, args),
		{ write: true },
	)

	registerTool(
		server,
		ctx,
		'publish_video',
		'Ask for a private video on the connected channel to become unlisted, public, or public at a set time (publish_at, ISO 8601 with a time zone, in the future). Nothing is sent yet: a person approves the exact change on a card that shows the time. A time that has passed is refused, because YouTube would publish at once. Returns an action id.',
		publishVideoInput,
		(args) => prepareVisibilityChange(ctx, args),
		{ write: true },
	)

	registerTool(
		server,
		ctx,
		'get_upload_status',
		'How an upload or publish request stands: pending approval, approved and uploading (with bytes sent), executed (with the YouTube video id for an upload) or failed (with a result code). Never returns the request itself.',
		uploadStatusInput,
		(args) => readUploadStatus(ctx, args),
	)
}
