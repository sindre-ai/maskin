import { createHash } from 'node:crypto'
import type { Database } from '@maskin/db'
import { actors, files, objects, workspaceMembers } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { type YoutubeClientContext, youtubeRead } from '../integrations/providers/youtube/client'
import { YoutubeError } from '../integrations/providers/youtube/errors'
import { getYoutubeIntegrationId } from '../integrations/providers/youtube/token'
import {
	type CreatePendingActionInput,
	YoutubeActionError,
	type YoutubeActionKind,
	createPendingAction,
} from './actions'
import { assertWithinYoutubeCaps, normalizeCommentText } from './caps'

/**
 * What a YouTube write tool does: build the exact request, check what can be checked now, and hand
 * it to the approval gate. Nothing in here calls Google for a write, and it does not import the
 * Google write client (a test fails if it does). The only Google calls are two reads, for the
 * channel's name and, for a video edit, the video's current details.
 *
 * Each builder returns the body the executor will send as it is, so the card shows the same thing
 * Google will receive.
 */

export const YOUTUBE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024
const THUMBNAIL_MIME_TYPES = ['image/png', 'image/jpeg']

export interface ProposeContext extends YoutubeClientContext {
	sessionId?: string | null
}

interface Built {
	kind: YoutubeActionKind
	payload: Record<string, unknown>
	targetVideoId?: string
	textHash?: string
}

const invalid = (message: string, hint?: string) =>
	new YoutubeError({ code: 'INVALID_INPUT', message, hint })

export interface MetadataInput {
	video_id: string
	title?: string
	description?: string
	tags?: string[]
	category_id?: string
}

export interface ThumbnailInput {
	video_id: string
	file_id: string
}

export interface CreatePlaylistInput {
	title: string
	description?: string
	privacy_status: 'private' | 'unlisted' | 'public'
}

export interface AddToPlaylistInput {
	playlist_id: string
	video_id: string
	position?: number
}

export interface PostCommentInput {
	video_id: string
	text: string
}

export interface ReplyToCommentInput {
	video_id: string
	comment_id: string
	text: string
}

export interface LikeInput {
	video_id: string
}

interface ChannelRead {
	items?: Array<{ id?: string; snippet?: { title?: string } }>
}

interface VideoRead {
	items?: Array<{
		snippet?: {
			channelId?: string
			title?: string
			description?: string
			tags?: string[]
			categoryId?: string
			defaultLanguage?: string
		}
	}>
}

/** The connected channel's id and public name. Same read as youtube__get_channel, so it shares its cache. */
export async function readOwnChannel(ctx: YoutubeClientContext) {
	const channel = await youtubeRead<ChannelRead>(ctx, {
		tool: 'youtube__get_channel',
		path: 'channels',
		params: { part: 'snippet,statistics,contentDetails', mine: 'true' },
		units: 1,
	})
	const item = channel.items?.[0]
	return { id: item?.id ?? null, title: item?.snippet?.title ?? null }
}

/** A comment's text is kept as this hash only once its action ends, for the "no identical text twice" rule. */
const hashText = (text: string) =>
	createHash('sha256').update(normalizeCommentText(text)).digest('hex')

async function buildMetadata(
	ctx: YoutubeClientContext,
	input: MetadataInput,
	channelId: string | null,
): Promise<Built> {
	if (
		input.title === undefined &&
		input.description === undefined &&
		input.tags === undefined &&
		input.category_id === undefined
	) {
		throw invalid('Nothing to change.', 'Give a title, description, tags or category_id.')
	}
	const video = await youtubeRead<VideoRead>(ctx, {
		tool: 'youtube__update_video_metadata',
		path: 'videos',
		params: { part: 'snippet', id: input.video_id },
		units: 1,
	})
	const current = video.items?.[0]?.snippet
	if (!current) {
		throw new YoutubeError({ code: 'NOT_FOUND', message: 'No video with that id.' })
	}
	if (!channelId || current.channelId !== channelId) {
		throw new YoutubeError({
			code: 'PERMISSION_DENIED',
			message: 'That video is not on the connected channel.',
		})
	}
	// videos.update replaces the snippet and drops any editable field left out, so the request
	// carries the whole snippet with the change applied. The card then shows the result.
	const tags = input.tags ?? current.tags
	const snippet: Record<string, unknown> = {
		title: input.title ?? current.title,
		description: input.description ?? current.description ?? '',
		categoryId: input.category_id ?? current.categoryId,
		...(tags && tags.length > 0 ? { tags } : {}),
		...(current.defaultLanguage ? { defaultLanguage: current.defaultLanguage } : {}),
	}
	const unchanged =
		snippet.title === current.title &&
		snippet.description === (current.description ?? '') &&
		snippet.categoryId === current.categoryId &&
		JSON.stringify(snippet.tags ?? []) === JSON.stringify(current.tags ?? [])
	if (unchanged) throw invalid('The video already has these details.')
	return {
		kind: 'update_video_metadata',
		payload: { id: input.video_id, snippet },
		targetVideoId: input.video_id,
	}
}

async function buildThumbnail(
	db: Database,
	workspaceId: string,
	input: ThumbnailInput,
): Promise<Built> {
	const [file] = await db
		.select({
			id: files.id,
			name: files.name,
			mimeType: files.mimeType,
			sizeBytes: files.sizeBytes,
			contentHash: files.contentHash,
		})
		.from(files)
		.where(and(eq(files.id, input.file_id), eq(files.workspaceId, workspaceId)))
		.limit(1)
	if (!file) throw invalid('That file is not in this workspace.')
	if (!THUMBNAIL_MIME_TYPES.includes(file.mimeType)) {
		throw invalid('A thumbnail must be a PNG or JPEG image.')
	}
	if (file.sizeBytes > YOUTUBE_THUMBNAIL_MAX_BYTES) {
		throw invalid('A thumbnail must be 2 MB or smaller.')
	}
	if (!file.contentHash) {
		throw invalid(
			'That file has no content hash yet.',
			'Open or save the file once, then ask again.',
		)
	}
	// The hash goes in the request, so the image a person approves is the image that is sent: the
	// executor refuses a file whose bytes no longer match.
	return {
		kind: 'set_thumbnail',
		payload: {
			videoId: input.video_id,
			fileId: file.id,
			fileName: file.name,
			contentHash: file.contentHash,
		},
		targetVideoId: input.video_id,
	}
}

function buildCreatePlaylist(input: CreatePlaylistInput): Built {
	return {
		kind: 'create_playlist',
		payload: {
			snippet: {
				title: input.title,
				...(input.description ? { description: input.description } : {}),
			},
			status: { privacyStatus: input.privacy_status },
		},
	}
}

function buildAddToPlaylist(input: AddToPlaylistInput): Built {
	return {
		kind: 'add_to_playlist',
		payload: {
			snippet: {
				playlistId: input.playlist_id,
				resourceId: { kind: 'youtube#video', videoId: input.video_id },
				...(input.position !== undefined ? { position: input.position } : {}),
			},
		},
		targetVideoId: input.video_id,
	}
}

function buildPostComment(input: PostCommentInput): Built {
	return {
		kind: 'post_comment',
		payload: {
			snippet: {
				videoId: input.video_id,
				topLevelComment: { snippet: { textOriginal: input.text } },
			},
		},
		targetVideoId: input.video_id,
		textHash: hashText(input.text),
	}
}

function buildReplyToComment(input: ReplyToCommentInput): Built {
	return {
		kind: 'reply_to_comment',
		payload: { snippet: { parentId: input.comment_id, textOriginal: input.text } },
		// A reply needs no video id to be sent. It is kept here so the per-video cap counts it.
		targetVideoId: input.video_id,
		textHash: hashText(input.text),
	}
}

function buildLike(input: LikeInput): Built {
	return {
		kind: 'like',
		payload: { id: input.video_id, rating: 'like' },
		targetVideoId: input.video_id,
	}
}

/** The people who may decide a change: the human owners and admins of the workspace. */
export async function findApprovers(db: Database, workspaceId: string): Promise<string[]> {
	const rows = await db
		.select({ id: actors.id })
		.from(workspaceMembers)
		.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				inArray(workspaceMembers.role, ['owner', 'admin']),
				eq(actors.type, 'human'),
			),
		)
	return rows.map((row) => row.id)
}

export async function assertObjectInWorkspace(db: Database, workspaceId: string, objectId: string) {
	const [row] = await db
		.select({ id: objects.id })
		.from(objects)
		.where(and(eq(objects.id, objectId), eq(objects.workspaceId, workspaceId)))
		.limit(1)
	if (!row) throw invalid('The object_id is not an object in this workspace.')
}

export type ProposeInput =
	| { tool: 'update_video_metadata'; args: MetadataInput }
	| { tool: 'set_thumbnail'; args: ThumbnailInput }
	| { tool: 'create_playlist'; args: CreatePlaylistInput }
	| { tool: 'add_to_playlist'; args: AddToPlaylistInput }
	| { tool: 'post_comment'; args: PostCommentInput }
	| { tool: 'reply_to_comment'; args: ReplyToCommentInput }
	| { tool: 'like'; args: LikeInput }

export interface ProposeCommon {
	/** The object the approval card is posted on: the task, bet or flow the change is for. */
	object_id: string
	note?: string
}

export interface ProposeResult {
	action_id: string
	status: string
	expires_at: string
	message: string
}

/**
 * Stores one write as a pending action and posts its card. Returns the action's id, never a result
 * from Google: a person decides, and the server runs the change after that.
 */
export async function proposeYoutubeWrite(
	ctx: ProposeContext,
	common: ProposeCommon,
	request: ProposeInput,
): Promise<ProposeResult> {
	const { db, workspaceId, actorId } = ctx
	// Not connected or revoked: stop here, before anything is stored.
	const integrationId = await getYoutubeIntegrationId(db, workspaceId, actorId, ctx.integrationId)
	await assertObjectInWorkspace(db, workspaceId, common.object_id)

	// The channel's name is read by the server, never taken from the agent, so the card shows the
	// real channel. A failed read leaves the card with the generic wording.
	const channel = await readOwnChannel(ctx).catch((err) => {
		if (request.tool === 'update_video_metadata') throw err
		return { id: null, title: null }
	})

	let built: Built
	switch (request.tool) {
		case 'update_video_metadata':
			built = await buildMetadata(ctx, request.args, channel.id)
			break
		case 'set_thumbnail':
			built = await buildThumbnail(db, workspaceId, request.args)
			break
		case 'create_playlist':
			built = buildCreatePlaylist(request.args)
			break
		case 'add_to_playlist':
			built = buildAddToPlaylist(request.args)
			break
		case 'post_comment':
			built = buildPostComment(request.args)
			break
		case 'reply_to_comment':
			built = buildReplyToComment(request.args)
			break
		case 'like':
			built = buildLike(request.args)
			break
	}

	const approverIds = await findApprovers(db, workspaceId)
	if (approverIds.length === 0) {
		throw invalid('This workspace has no person who can approve a YouTube change.')
	}

	const input: CreatePendingActionInput = {
		workspaceId,
		integrationId,
		kind: built.kind,
		payload: built.payload,
		targetVideoId: built.targetVideoId ?? null,
		channelLabel: channel.title,
		agentNote: common.note ?? null,
		textHash: built.textHash ?? null,
		requestedByActor: actorId,
		requestedBySession: ctx.sessionId ?? null,
		cardEntityId: common.object_id,
		approverIds,
		beforeInsert: (tx) =>
			assertWithinYoutubeCaps(tx, {
				workspaceId,
				kind: built.kind,
				targetVideoId: built.targetVideoId ?? null,
				textHash: built.textHash ?? null,
			}),
	}
	try {
		const created = await createPendingAction(db, input)
		return {
			action_id: created.id,
			status: created.status,
			expires_at: created.expiresAt.toISOString(),
			message:
				'Held for a person to approve. Nothing was sent to YouTube. It goes out only after they approve, and the request lapses after 7 days.',
		}
	} catch (err) {
		if (err instanceof YoutubeActionError) {
			throw err.code === 'NOT_FOUND'
				? new YoutubeError({ code: 'NOT_CONNECTED', message: err.message })
				: invalid(err.message)
		}
		throw err
	}
}
