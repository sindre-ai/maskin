/**
 * What a held caption request is made of, and the rules it must meet before it is held. Pure code,
 * no Google and no storage, like `upload.ts`: the tools build the stored request with it, the card
 * reads it back, and the executor checks the file again before anything is sent.
 *
 * Google charges a caption write by the call: captions.insert 400 units, captions.update 450,
 * captions.delete 50 (https://developers.google.com/youtube/v3/determine_quota_cost). The executor
 * charges these when the action runs.
 */

export const YOUTUBE_CAPTION_INSERT_UNITS = 400
export const YOUTUBE_CAPTION_UPDATE_UNITS = 450
export const YOUTUBE_CAPTION_DELETE_UNITS = 50
/** An SRT or VTT file is plain text. Held well under Google's own limit (100 MB). */
export const YOUTUBE_CAPTION_MAX_BYTES = 1_000_000
export const YOUTUBE_CAPTION_NAME_MAX_CHARS = 150

export type YoutubeCaptionRule =
	| 'not_a_caption_file'
	| 'file_empty'
	| 'file_too_large'
	| 'bad_language'
	| 'bad_name'
	| 'bad_video_id'

export class YoutubeCaptionRuleError extends Error {
	constructor(
		readonly rule: YoutubeCaptionRule,
		message: string,
	) {
		super(message)
	}
}

export interface CaptionFile {
	id: string
	name: string
	sizeBytes: number
	contentHash: string | null
}

/** The exact caption upload or replace request, stored and hashed. */
export interface CaptionFilePayload {
	videoId: string
	/** Set for a replace: the track that is overwritten. */
	captionId?: string
	language: string
	name: string
	isDraft: boolean
	fileId: string
	fileName: string
	sizeBytes: number
	contentHash: string
}

/** The exact caption delete request, stored and hashed. Language and name are read from Google for the card. */
export interface CaptionDeletePayload {
	videoId: string
	captionId: string
	language: string
	name: string
}

/** BCP-47 enough for YouTube: en, nb, pt-BR, zh-Hans. */
const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/

export function assertVideoId(videoId: string): void {
	if (!VIDEO_ID.test(videoId)) {
		throw new YoutubeCaptionRuleError('bad_video_id', 'That is not a YouTube video id.')
	}
}

export function buildCaptionFilePayload(
	file: CaptionFile,
	input: {
		videoId: string
		captionId?: string
		language: string
		name?: string
		isDraft?: boolean
	},
): CaptionFilePayload {
	assertVideoId(input.videoId)
	if (!/\.(srt|vtt)$/i.test(file.name)) {
		throw new YoutubeCaptionRuleError(
			'not_a_caption_file',
			'A caption file must be an SRT or VTT file (the name ends in .srt or .vtt).',
		)
	}
	if (file.sizeBytes <= 0) {
		throw new YoutubeCaptionRuleError('file_empty', 'That file is empty.')
	}
	if (file.sizeBytes > YOUTUBE_CAPTION_MAX_BYTES) {
		throw new YoutubeCaptionRuleError(
			'file_too_large',
			`A caption file can be at most ${YOUTUBE_CAPTION_MAX_BYTES} bytes.`,
		)
	}
	const language = input.language.trim()
	if (!LANGUAGE.test(language)) {
		throw new YoutubeCaptionRuleError(
			'bad_language',
			'The language is a code such as en, nb or pt-BR.',
		)
	}
	const name = (input.name ?? '').trim()
	if (name.length > YOUTUBE_CAPTION_NAME_MAX_CHARS || /[<>]/.test(name)) {
		throw new YoutubeCaptionRuleError(
			'bad_name',
			`The track name can be at most ${YOUTUBE_CAPTION_NAME_MAX_CHARS} characters and cannot contain < or >.`,
		)
	}
	if (!file.contentHash) {
		// The hash is what makes the file a person approves the file that is sent.
		throw new YoutubeCaptionRuleError(
			'file_empty',
			'That file has no content hash yet. Open or save the file once, then ask again.',
		)
	}
	return {
		videoId: input.videoId,
		...(input.captionId ? { captionId: input.captionId } : {}),
		language,
		name,
		isDraft: input.isDraft === true,
		fileId: file.id,
		fileName: file.name,
		sizeBytes: file.sizeBytes,
		contentHash: file.contentHash,
	}
}

/** Lines the card shows above the raw request, read from the stored request and nothing else. */
export function describeCaptionRequest(kind: string, payload: Record<string, unknown>): string[] {
	const language = `Language: ${String(payload.language ?? 'unknown')}`
	const name =
		typeof payload.name === 'string' && payload.name ? [`Track name: ${payload.name}`] : []
	if (kind === 'delete_caption') {
		return [
			language,
			...name,
			`Caption track: ${String(payload.captionId ?? 'unknown')}`,
			'This removes the caption track from the video.',
		]
	}
	if (kind === 'upload_caption' || kind === 'replace_caption') {
		const size = typeof payload.sizeBytes === 'number' ? ` (${payload.sizeBytes} bytes)` : ''
		return [
			language,
			...name,
			`File: ${String(payload.fileName ?? 'unknown')}${size}`,
			...(kind === 'replace_caption'
				? [`Overwrites caption track: ${String(payload.captionId ?? 'unknown')}`]
				: []),
			payload.isDraft === true
				? 'Saved as a draft: viewers cannot see it.'
				: 'Published: viewers can turn it on.',
		]
	}
	return []
}
