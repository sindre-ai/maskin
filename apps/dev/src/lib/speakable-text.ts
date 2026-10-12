/**
 * Turns an agent's markdown reply into text worth reading aloud: no markup
 * characters, no code dumps, no raw URLs, no table scaffolding.
 *
 * A line-by-line port of apps/apple/Sources/MaskinCore/Speech/SpeakableText.swift
 * so a reply sounds the same whether the phone reads it or the server speaks it.
 * Keep the two in step; the tests share their inputs.
 */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

function cleanLine(line: string): string | null {
	if (line === '') return ''
	if (/^([-*_]\s*){3,}$/.test(line)) return null
	if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes('-')) return null
	let s = line
	s = s.replace(/^#{1,6}\s+/, '')
	s = s.replace(/^>+\s?/, '')
	s = s.replace(/^[-*+]\s+\[[ xX]\]\s+/, '')
	s = s.replace(/^[-*+]\s+/, '')
	s = s.replace(/^\d+[.)]\s+/, '')
	// Images: drop. Links: keep the label.
	s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
	s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
	s = s.replace(/https?:\/\/\S+/g, 'link')
	// Table rows read as comma-separated cells.
	if (s.startsWith('|') || s.endsWith('|')) {
		s = s
			.split('|')
			.map((c) => c.trim())
			.filter((c) => c.length > 0)
			.join(', ')
	}
	// Emphasis, strikethrough, inline code, html.
	s = s.replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
	s = s.replace(/(?<![\w*])[*_](\S(?:.*?\S)?)[*_](?![\w*])/g, '$1')
	s = s.replace(/`([^`]*)`/g, '$1')
	s = s.replace(/<[^>]+>/g, '')
	return s.trim()
}

export function toSpeakableText(markdown: string): string {
	const out: string[] = []
	let inFence = false
	let skippedCode = false
	for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
		const trimmed = raw.trim()
		if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
			inFence = !inFence
			if (inFence && !skippedCode) {
				out.push('Code block skipped.')
				skippedCode = true
			}
			continue
		}
		if (inFence) continue
		const line = cleanLine(trimmed)
		if (line === null) continue
		out.push(line)
	}
	return out
		.join('\n')
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

/**
 * Speakable text for a live call. A person listening cannot use an id, so any
 * UUID is dropped (the style prompt asks the model to say names; this is the
 * backstop for when it does not).
 */
export function toLiveSpeech(markdown: string): string {
	return toSpeakableText(markdown)
		.replace(UUID_RE, '')
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/\s+([,.;:!?])/g, '$1')
		.trim()
}
