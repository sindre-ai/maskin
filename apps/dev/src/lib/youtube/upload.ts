/**
 * What a held upload or publish request is made of, and the rules it must meet before it is held.
 * Pure code, no Google and no storage: the tools use it to build the stored request, the card
 * reads it back, and the executor checks it again before it sends anything.
 */

/** Google's limit for one video file is 256 GB. Decimal, so a file near the edge is refused here. */
export const YOUTUBE_UPLOAD_MAX_BYTES = 256_000_000_000
export const YOUTUBE_TITLE_MAX_CHARS = 100
export const YOUTUBE_DESCRIPTION_MAX_BYTES = 5_000
export const YOUTUBE_TAGS_MAX_CHARS = 500

export type YoutubeUploadRule =
	| 'not_a_video'
	| 'file_empty'
	| 'file_too_large'
	| 'bad_title'
	| 'bad_description'
	| 'bad_tags'
	| 'bad_category'
	| 'bad_video_id'
	| 'bad_publish_time'
	| 'publish_time_passed'
	| 'bad_visibility'

/** A request the rules refuse. The message is for the agent that asked, so it says how to fix it. */
export class YoutubeUploadRuleError extends Error {
	constructor(
		readonly rule: YoutubeUploadRule,
		message: string,
	) {
		super(message)
	}
}

export interface UploadFile {
	id: string
	name: string
	mimeType: string
	sizeBytes: number
	contentHash: string | null
}

export interface UploadVideoInput {
	title: string
	description?: string
	tags?: string[]
	categoryId?: string
	/** The requester says the video is AI generated or altered. */
	aiGenerated?: boolean
}

/** The exact upload request, stored and hashed. Its privacy is always private. */
export interface UploadPayload {
	fileId: string
	fileName: string
	mimeType: string
	sizeBytes: number
	contentHash?: string
	title: string
	description: string
	tags?: string[]
	categoryId?: string
	privacyStatus: 'private'
	containsSyntheticMedia?: true
}

export function buildUploadPayload(file: UploadFile, input: UploadVideoInput): UploadPayload {
	if (!file.mimeType.toLowerCase().startsWith('video/')) {
		throw new YoutubeUploadRuleError(
			'not_a_video',
			`That file is ${file.mimeType}, not a video. YouTube takes video files only.`,
		)
	}
	if (file.sizeBytes <= 0) {
		throw new YoutubeUploadRuleError(
			'file_empty',
			'That file is empty, so there is nothing to upload.',
		)
	}
	if (file.sizeBytes > YOUTUBE_UPLOAD_MAX_BYTES) {
		throw new YoutubeUploadRuleError(
			'file_too_large',
			`That file is ${file.sizeBytes} bytes. YouTube accepts at most ${YOUTUBE_UPLOAD_MAX_BYTES} bytes (256 GB) in one video.`,
		)
	}
	const title = input.title.trim()
	if (title.length === 0 || title.length > YOUTUBE_TITLE_MAX_CHARS || /[<>]/.test(title)) {
		throw new YoutubeUploadRuleError(
			'bad_title',
			`The title needs 1 to ${YOUTUBE_TITLE_MAX_CHARS} characters and cannot contain < or >.`,
		)
	}
	const description = (input.description ?? '').trim()
	if (
		Buffer.byteLength(description, 'utf8') > YOUTUBE_DESCRIPTION_MAX_BYTES ||
		/[<>]/.test(description)
	) {
		throw new YoutubeUploadRuleError(
			'bad_description',
			`The description can be at most ${YOUTUBE_DESCRIPTION_MAX_BYTES} bytes and cannot contain < or >.`,
		)
	}
	const tags = (input.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0)
	if (tags.join(',').length > YOUTUBE_TAGS_MAX_CHARS || tags.some((tag) => /[<>]/.test(tag))) {
		throw new YoutubeUploadRuleError(
			'bad_tags',
			`The tags can total at most ${YOUTUBE_TAGS_MAX_CHARS} characters and cannot contain < or >.`,
		)
	}
	if (input.categoryId !== undefined && !/^\d{1,4}$/.test(input.categoryId)) {
		throw new YoutubeUploadRuleError(
			'bad_category',
			'The category id is the number YouTube gives a category, for example 22.',
		)
	}
	return {
		fileId: file.id,
		fileName: file.name,
		mimeType: file.mimeType,
		sizeBytes: file.sizeBytes,
		...(file.contentHash ? { contentHash: file.contentHash } : {}),
		title,
		description,
		...(tags.length > 0 ? { tags } : {}),
		...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
		privacyStatus: 'private',
		...(input.aiGenerated ? { containsSyntheticMedia: true as const } : {}),
	}
}

export interface PublishVideoInput {
	videoId: string
	visibility: 'unlisted' | 'public'
	/** ISO 8601 with a time zone. Only with visibility public. */
	publishAt?: string
}

/**
 * The exact publish request, stored and hashed. A scheduled publish is a private video with a
 * publishAt time: YouTube makes it public then. A past time would publish at once, so it is refused.
 */
export interface PublishPayload {
	videoId: string
	privacyStatus: 'private' | 'unlisted' | 'public'
	publishAt?: string
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** The time as an exact UTC instant, or a refusal when it is not a time or is not in the future. */
export function parsePublishAt(value: string, now: Date = new Date()): string {
	const text = value.trim()
	const at = ISO_WITH_ZONE.test(text) ? new Date(text) : null
	if (!at || Number.isNaN(at.getTime())) {
		throw new YoutubeUploadRuleError(
			'bad_publish_time',
			'Give the time as ISO 8601 with a time zone, for example 2026-12-01T09:00:00Z.',
		)
	}
	if (at.getTime() <= now.getTime()) {
		throw new YoutubeUploadRuleError(
			'publish_time_passed',
			'That time has passed. YouTube would publish the video at once, so it is refused. Pick a future time.',
		)
	}
	return at.toISOString()
}

export function buildPublishPayload(
	input: PublishVideoInput,
	now: Date = new Date(),
): PublishPayload {
	if (!/^[A-Za-z0-9_-]{6,20}$/.test(input.videoId)) {
		throw new YoutubeUploadRuleError('bad_video_id', 'That is not a YouTube video id.')
	}
	if (input.visibility !== 'unlisted' && input.visibility !== 'public') {
		throw new YoutubeUploadRuleError('bad_visibility', 'Visibility is unlisted or public.')
	}
	if (input.publishAt === undefined) {
		return { videoId: input.videoId, privacyStatus: input.visibility }
	}
	if (input.visibility !== 'public') {
		throw new YoutubeUploadRuleError(
			'bad_visibility',
			'YouTube can only schedule a video to become public. Use visibility public with a time, or unlisted without one.',
		)
	}
	return {
		videoId: input.videoId,
		privacyStatus: 'private',
		publishAt: parsePublishAt(input.publishAt, now),
	}
}

/** True when a stored publish request carries a time that has gone by. Checked again at the run. */
export function publishTimeHasPassed(payload: PublishPayload, now: Date = new Date()): boolean {
	return payload.publishAt !== undefined && new Date(payload.publishAt).getTime() <= now.getTime()
}

/** Lines the card shows above the raw request, read from the stored request and nothing else. */
export function describeStoredRequest(kind: string, payload: Record<string, unknown>): string[] {
	if (kind === 'upload_video') {
		const size = typeof payload.sizeBytes === 'number' ? payload.sizeBytes : null
		return [
			'Visibility: PRIVATE. The server always uploads as private. Nothing is public until a second approval.',
			`AI generated or altered: ${payload.containsSyntheticMedia === true ? 'yes, marked by the requester' : 'not marked'}`,
			`File: ${String(payload.fileName ?? 'unknown')}${size === null ? '' : ` (${size} bytes)`}`,
		]
	}
	if (kind === 'publish_video') {
		if (typeof payload.publishAt === 'string') {
			return [`Goes public at exactly: ${payload.publishAt} (UTC)`]
		}
		return [
			`Visibility changes now to: ${String(payload.privacyStatus ?? 'unknown').toUpperCase()}`,
		]
	}
	return []
}
