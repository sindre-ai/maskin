import { type YoutubeClientContext, youtubeRead } from './client'
import { YoutubeError, isYoutubeError } from './errors'

export interface GetOwnCaptionsInput {
	video_id: string
	/** Language code of the track, for example en. Default: the best track the video has. */
	language?: string
	format: 'srt' | 'vtt'
}

interface CaptionTrack {
	id?: string
	snippet?: { language?: string; trackKind?: string; name?: string }
}

/**
 * Caption text of a video on the connected channel. The video's channel is checked first (2 reads,
 * 1 unit each), and a video on any other channel is refused before captions.list is called, so a
 * foreign video never costs the 250 units and never reaches the caption endpoints. The caption
 * calls are not cached: the text is returned to the calling agent only.
 */
export async function getOwnCaptions(client: YoutubeClientContext, input: GetOwnCaptionsInput) {
	const own = await youtubeRead<{ items?: Array<{ id?: string }> }>(client, {
		tool: 'youtube__get_own_captions',
		path: 'channels',
		params: { part: 'id', mine: 'true' },
		units: 1,
	})
	const ownChannelId = own.items?.[0]?.id

	const video = await youtubeRead<{ items?: Array<{ snippet?: { channelId?: string } }> }>(client, {
		tool: 'youtube__get_own_captions',
		path: 'videos',
		params: { part: 'snippet', id: input.video_id },
		units: 1,
	})
	const videoChannelId = video.items?.[0]?.snippet?.channelId
	if (!videoChannelId) {
		throw new YoutubeError({ code: 'NOT_FOUND', message: 'YouTube video not found.' })
	}
	if (!ownChannelId || videoChannelId !== ownChannelId) {
		throw new YoutubeError({
			code: 'PERMISSION_DENIED',
			message: 'This video is not on the connected channel.',
			hint: 'Captions can only be read for videos owned by the connected YouTube channel.',
		})
	}

	try {
		const list = await youtubeRead<{ items?: CaptionTrack[] }>(client, {
			tool: 'youtube__get_own_captions',
			path: 'captions',
			params: { part: 'snippet', videoId: input.video_id },
			units: 50,
			cache: false,
		})
		const tracks = (list.items ?? []).filter((t) => t.id)
		if (tracks.length === 0) {
			throw new YoutubeError({ code: 'NOT_FOUND', message: 'This video has no caption tracks.' })
		}
		const track = pickTrack(tracks, input.language)
		if (!track?.id) {
			const languages = [...new Set(tracks.map((t) => t.snippet?.language).filter(Boolean))]
			throw new YoutubeError({
				code: 'NOT_FOUND',
				message: `No caption track in language ${input.language}.`,
				hint: `Available languages: ${languages.join(', ') || 'unknown'}.`,
			})
		}
		const text = await youtubeRead<string>(client, {
			tool: 'youtube__get_own_captions',
			path: `captions/${encodeURIComponent(track.id)}`,
			params: { tfmt: input.format },
			units: 200,
			cache: false,
			as: 'text',
		})
		return {
			video_id: input.video_id,
			track: {
				id: track.id,
				language: track.snippet?.language ?? null,
				kind: track.snippet?.trackKind ?? null,
			},
			format: input.format,
			text,
		}
	} catch (err) {
		// A connection made before youtube.force-ssl was requested has no caption access.
		if (
			isYoutubeError(err) &&
			err.code === 'PERMISSION_DENIED' &&
			err.reason === 'insufficientPermissions'
		) {
			throw new YoutubeError({
				code: 'RECONSENT_REQUIRED',
				message: 'The connected YouTube grant does not include caption access.',
				provider_status: err.providerStatus,
				reason: err.reason,
				integration_id: err.integrationId,
				hint: 'Ask a workspace member to reconnect YouTube in Settings → Integrations.',
			})
		}
		throw err
	}
}

/** The requested language if given, else a standard (non auto-generated) track, else the first. */
function pickTrack(tracks: CaptionTrack[], language?: string): CaptionTrack | undefined {
	if (language) {
		const wanted = language.toLowerCase()
		const inLanguage = tracks.filter((t) => t.snippet?.language?.toLowerCase() === wanted)
		return inLanguage.find((t) => t.snippet?.trackKind !== 'asr') ?? inLanguage[0]
	}
	return tracks.find((t) => t.snippet?.trackKind === 'standard') ?? tracks[0]
}
