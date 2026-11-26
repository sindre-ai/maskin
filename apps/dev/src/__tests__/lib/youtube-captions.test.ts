import {
	YOUTUBE_CAPTION_MAX_BYTES,
	YoutubeCaptionRuleError,
	buildCaptionFilePayload,
	describeCaptionRequest,
} from '../../lib/youtube/captions'

const FILE = { id: 'f1', name: 'talk.srt', sizeBytes: 1200, contentHash: 'abc123' }
const rule = (fn: () => unknown) => {
	try {
		fn()
	} catch (err) {
		return err instanceof YoutubeCaptionRuleError ? err.rule : 'other'
	}
	return null
}

describe('buildCaptionFilePayload', () => {
	it('builds the exact request, with the file hash and the draft flag defaulting to published', () => {
		expect(
			buildCaptionFilePayload(FILE, {
				videoId: 'dQw4w9WgXcQ',
				language: ' en ',
				name: ' English ',
			}),
		).toEqual({
			videoId: 'dQw4w9WgXcQ',
			language: 'en',
			name: 'English',
			isDraft: false,
			fileId: 'f1',
			fileName: 'talk.srt',
			sizeBytes: 1200,
			contentHash: 'abc123',
		})
	})

	it('accepts a VTT file in any case and keeps the track id of a replace', () => {
		const payload = buildCaptionFilePayload(
			{ ...FILE, name: 'TALK.VTT' },
			{ videoId: 'dQw4w9WgXcQ', captionId: 'cap1', language: 'pt-BR', isDraft: true },
		)
		expect(payload).toMatchObject({ captionId: 'cap1', language: 'pt-BR', isDraft: true })
	})

	it('refuses what YouTube would not take, with a rule the agent can act on', () => {
		const ok = { videoId: 'dQw4w9WgXcQ', language: 'en' }
		expect(rule(() => buildCaptionFilePayload({ ...FILE, name: 'talk.mp4' }, ok))).toBe(
			'not_a_caption_file',
		)
		expect(rule(() => buildCaptionFilePayload({ ...FILE, sizeBytes: 0 }, ok))).toBe('file_empty')
		expect(
			rule(() =>
				buildCaptionFilePayload({ ...FILE, sizeBytes: YOUTUBE_CAPTION_MAX_BYTES + 1 }, ok),
			),
		).toBe('file_too_large')
		expect(rule(() => buildCaptionFilePayload({ ...FILE, contentHash: null }, ok))).toBe(
			'file_empty',
		)
		expect(rule(() => buildCaptionFilePayload(FILE, { ...ok, language: 'english please' }))).toBe(
			'bad_language',
		)
		expect(rule(() => buildCaptionFilePayload(FILE, { ...ok, name: '<b>x</b>' }))).toBe('bad_name')
		expect(rule(() => buildCaptionFilePayload(FILE, { ...ok, videoId: 'no' }))).toBe('bad_video_id')
	})
})

describe('describeCaptionRequest', () => {
	it('shows language, file name and whether viewers can see an upload', () => {
		const lines = describeCaptionRequest('upload_caption', {
			language: 'nb',
			name: 'Norsk',
			fileName: 'talk.srt',
			sizeBytes: 1200,
			isDraft: false,
		})
		expect(lines).toEqual([
			'Language: nb',
			'Track name: Norsk',
			'File: talk.srt (1200 bytes)',
			'Published: viewers can turn it on.',
		])
	})

	it('names the track a replace overwrites and the track a delete removes', () => {
		expect(
			describeCaptionRequest('replace_caption', {
				language: 'en',
				fileName: 'new.vtt',
				captionId: 'cap1',
				isDraft: true,
			}),
		).toContain('Overwrites caption track: cap1')
		expect(
			describeCaptionRequest('delete_caption', { language: 'en', captionId: 'cap1' }),
		).toContain('This removes the caption track from the video.')
	})

	it('says nothing for a kind that is not a caption', () => {
		expect(describeCaptionRequest('like', {})).toEqual([])
	})
})
