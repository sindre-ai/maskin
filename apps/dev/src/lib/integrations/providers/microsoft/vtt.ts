/**
 * Teams transcripts come back as WebVTT: a cue is a timing line, then text that
 * names the speaker in a voice tag (`<v Ada Lovelace>Hello</v>`). Turn that into
 * the same "**Speaker:** text" lines the Skjald meeting body uses, merging
 * consecutive cues from one speaker.
 */
export function vttToMarkdown(vtt: string): string {
	const lines: string[] = []
	let speaker: string | null = null
	let text: string[] = []

	const flush = () => {
		if (text.length === 0) return
		const body = text.join(' ').replace(/\s+/g, ' ').trim()
		if (body) lines.push(speaker ? `**${speaker}:** ${body}` : body, '')
		text = []
	}

	for (const block of vtt.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
		const rows = block.split('\n')
		const timing = rows.findIndex((row) => row.includes('-->'))
		if (timing === -1) continue // header, NOTE and STYLE blocks
		const cue = rows.slice(timing + 1)
		// The voice tag sits on the cue's first line; later lines belong to the same speaker.
		const cueSpeaker = cue[0]?.match(/^<v(?:\.[^\s>]+)*\s+([^>]*)>/)?.[1]?.trim() || null
		if (cueSpeaker !== speaker) {
			flush()
			speaker = cueSpeaker
		}
		for (const row of cue) {
			const content = row
				.replace(/<[^>]+>/g, '')
				.replace(/&amp;/g, '&')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.trim()
			if (content) text.push(content)
		}
	}
	flush()
	return lines.join('\n').trim()
}
