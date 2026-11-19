import { files, youtubePendingActions } from '@maskin/db/schema'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { YoutubeActionError, createPendingAction } from '../../../youtube/actions'
import {
	type ProposeContext,
	assertObjectInWorkspace,
	findApprovers,
	readOwnChannel,
} from '../../../youtube/propose'
import {
	type PublishPayload,
	YoutubeUploadRuleError,
	buildPublishPayload,
	buildUploadPayload,
} from '../../../youtube/upload'
import type { YoutubeClientContext } from './client'
import { YoutubeError } from './errors'
import { getYoutubeIntegrationId } from './token'

/**
 * The tools of part 5: prepare a private upload, ask for a video to be made unlisted, public or
 * scheduled, and read how either ended. The first two only create a pending action and put its
 * card in front of the people who can approve it (see `youtube/actions.ts`). Nothing here calls
 * the Google write client; the executor does, after a person has said yes.
 */

export const uploadVideoInput = {
	file_id: z.string().uuid().describe('The Maskin file to upload. It must be a video file.'),
	object_id: z
		.string()
		.uuid()
		.describe('The task, bet or flow this upload is for. The approval card is posted there.'),
	title: z.string().min(1).max(200).describe('The video title, 100 characters at most.'),
	description: z.string().max(10_000).optional().describe('The video description.'),
	tags: z.array(z.string().max(100)).max(50).optional().describe('Tags, 500 characters in total.'),
	category_id: z.string().max(10).optional().describe('YouTube category id, for example 22.'),
	ai_generated: z
		.boolean()
		.optional()
		.describe('True when the video is AI generated or altered. It is then declared to YouTube.'),
	note: z
		.string()
		.max(1_000)
		.optional()
		.describe(
			'A note for the approver. It is shown separately, labelled as yours, and never replaces the request.',
		),
}

export const publishVideoInput = {
	video_id: z.string().min(6).max(20).describe('The YouTube id of a private video on the channel.'),
	object_id: z
		.string()
		.uuid()
		.describe('The task, bet or flow this change is for. The approval card is posted there.'),
	visibility: z.enum(['unlisted', 'public']).describe('Who can watch the video once it changes.'),
	publish_at: z
		.string()
		.optional()
		.describe(
			'Schedule the video to become public at this time, ISO 8601 with a time zone, in the future. Only with visibility public.',
		),
	note: z.string().max(1_000).optional().describe('A note for the approver, shown separately.'),
}

export const uploadStatusInput = {
	action_id: z.string().uuid().describe('The action id an upload or publish call returned.'),
}

const invalid = (message: string, hint?: string) =>
	new YoutubeError({ code: 'INVALID_INPUT', message, ...(hint ? { hint } : {}) })

async function hold(
	ctx: ProposeContext,
	params: {
		kind: 'upload_video' | 'publish_video'
		payload: object
		targetVideoId: string | null
		objectId: string
		note?: string
	},
) {
	const { db, workspaceId, actorId } = ctx
	await assertObjectInWorkspace(db, workspaceId, params.objectId)
	const approverIds = await findApprovers(db, workspaceId)
	if (approverIds.length === 0) {
		throw invalid('This workspace has no person who can approve a YouTube change.')
	}
	const integrationId = await getYoutubeIntegrationId(db, workspaceId, actorId)
	try {
		const held = await createPendingAction(db, {
			workspaceId,
			integrationId,
			kind: params.kind,
			payload: params.payload as Record<string, unknown>,
			targetVideoId: params.targetVideoId,
			channelLabel: (await readOwnChannel(ctx).catch(() => null))?.title ?? null,
			agentNote: params.note ?? null,
			requestedByActor: actorId,
			requestedBySession: ctx.sessionId ?? null,
			cardEntityId: params.objectId,
			approverIds,
		})
		return {
			status: 'pending_approval',
			action_id: held.id,
			expires_at: held.expiresAt.toISOString(),
			message:
				'Nothing has been sent to YouTube. A person has to approve the card first. Read the result with youtube__get_upload_status.',
		}
	} catch (err) {
		if (err instanceof YoutubeActionError) throw invalid(err.message)
		throw err
	}
}

export async function prepareUpload(
	ctx: ProposeContext,
	args: z.infer<z.ZodObject<typeof uploadVideoInput>>,
) {
	const [file] = await ctx.db
		.select({
			id: files.id,
			name: files.name,
			mimeType: files.mimeType,
			sizeBytes: files.sizeBytes,
			contentHash: files.contentHash,
		})
		.from(files)
		.where(and(eq(files.id, args.file_id), eq(files.workspaceId, ctx.workspaceId)))
		.limit(1)
	if (!file) throw invalid('No file with that id in this workspace.')
	let payload: ReturnType<typeof buildUploadPayload>
	try {
		payload = buildUploadPayload(file, {
			title: args.title,
			description: args.description,
			tags: args.tags,
			categoryId: args.category_id,
			aiGenerated: args.ai_generated,
		})
	} catch (err) {
		if (err instanceof YoutubeUploadRuleError) throw invalid(err.message)
		throw err
	}
	return hold(ctx, {
		kind: 'upload_video',
		payload,
		targetVideoId: null,
		objectId: args.object_id,
		note: args.note,
	})
}

export async function prepareVisibilityChange(
	ctx: ProposeContext,
	args: z.infer<z.ZodObject<typeof publishVideoInput>>,
) {
	let payload: PublishPayload
	try {
		payload = buildPublishPayload({
			videoId: args.video_id,
			visibility: args.visibility,
			publishAt: args.publish_at,
		})
	} catch (err) {
		if (err instanceof YoutubeUploadRuleError) throw invalid(err.message)
		throw err
	}
	return hold(ctx, {
		kind: 'publish_video',
		payload,
		targetVideoId: payload.videoId,
		objectId: args.object_id,
		note: args.note,
	})
}

/** How an upload or publish request stands. Never its content. */
export async function readUploadStatus(
	ctx: YoutubeClientContext,
	args: z.infer<z.ZodObject<typeof uploadStatusInput>>,
) {
	const [row] = await ctx.db
		.select()
		.from(youtubePendingActions)
		.where(
			and(
				eq(youtubePendingActions.id, args.action_id),
				eq(youtubePendingActions.workspaceId, ctx.workspaceId),
				inArray(youtubePendingActions.kind, ['upload_video', 'publish_video']),
			),
		)
		.limit(1)
	if (!row)
		throw new YoutubeError({
			code: 'NOT_FOUND',
			message: 'No upload or publish request with that id.',
		})
	const size = (row.payload as { sizeBytes?: unknown } | null)?.sizeBytes
	return {
		action_id: row.id,
		kind: row.kind,
		status: row.status,
		result_code: row.resultCode,
		expires_at: row.expiresAt.toISOString(),
		video_id: row.status === 'executed' || row.kind === 'publish_video' ? row.targetVideoId : null,
		...(row.kind === 'upload_video' && row.status === 'approved'
			? {
					bytes_sent: row.uploadBytesSent ?? 0,
					total_bytes: typeof size === 'number' ? size : null,
				}
			: {}),
	}
}
