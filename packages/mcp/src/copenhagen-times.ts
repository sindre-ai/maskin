import { formatCopenhagenStamp } from '@maskin/shared'

// Every tool result carries stored times as UTC ISO strings. Agents copy what they read into
// comments that people read, so each such time gets a Copenhagen sibling next to it:
// `createdAt: "2026-11-17T20:00:00.000Z"` gains `createdAt_copenhagen: "2026-11-17 21:00"`.
// The stored value is left as it is, so anything that parses it keeps working.

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** Subtrees that hold stored or user-written values an agent may send back as they are. */
const SKIPPED_KEYS = new Set(['metadata', 'config'])

export const COPENHAGEN_SUFFIX = '_copenhagen'

export function withCopenhagenTimes<T>(value: T): T {
	return walk(value) as T
}

function walk(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(walk)
	if (value === null || typeof value !== 'object') return value
	const out: Record<string, unknown> = {}
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		out[key] = SKIPPED_KEYS.has(key) ? child : walk(child)
		if (typeof child === 'string' && ISO_TIME.test(child) && !(key + COPENHAGEN_SUFFIX in value)) {
			const stamp = formatCopenhagenStamp(child)
			if (stamp) out[key + COPENHAGEN_SUFFIX] = stamp
		}
	}
	return out
}

/** Parses a text block that is a JSON object or array and adds the Copenhagen times. Other text is returned as it is. */
function withCopenhagenTimesInText(text: string): string {
	const first = text.trimStart()[0]
	if (first !== '{' && first !== '[') return text
	try {
		const parsed = JSON.parse(text)
		return JSON.stringify(withCopenhagenTimes(parsed), null, text.includes('\n  "') ? 2 : 0)
	} catch {
		return text
	}
}

/**
 * Adds Copenhagen times to a tool response, on both channels (the text a voice call reads and
 * `structuredContent`). Returns the response untouched when it has nothing to add.
 */
export function addCopenhagenTimesToResponse<T>(response: T): T {
	if (!response || typeof response !== 'object') return response
	const { content, structuredContent } = response as {
		content?: unknown
		structuredContent?: unknown
	}
	const next: Record<string | symbol, unknown> = { ...(response as object) }
	if (Array.isArray(content)) {
		next.content = content.map((block) =>
			block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
				? {
						...block,
						text: withCopenhagenTimesInText(String((block as { text?: unknown }).text ?? '')),
					}
				: block,
		)
	}
	if (structuredContent && typeof structuredContent === 'object') {
		next.structuredContent = withCopenhagenTimes(structuredContent)
	}
	return next as T
}
