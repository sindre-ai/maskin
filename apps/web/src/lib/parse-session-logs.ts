export interface LogSegment {
	type: 'tool_call' | 'tool_result' | 'thinking' | 'text' | 'error' | 'system'
	content: string
	toolName?: string
}

// Patterns for detecting Claude Code structured output
const TOOL_CALL_PATTERN = /^⏺\s+(.+)$/
const TOOL_RESULT_PATTERN = /^⎿\s*/
const THINKING_START = /^(Thinking|Reasoning|Planning)\.{0,3}$/i
const SYSTEM_PATTERN = /^(Session (completed|failed|started|resumed)|Container |Agent )/i

/**
 * Parse raw session log lines into typed segments for structured rendering.
 * Gracefully degrades to plain text for unrecognized patterns — never throws.
 */
export function parseLogLines(logs: string[]): LogSegment[] {
	const segments: LogSegment[] = []
	let i = 0

	while (i < logs.length) {
		const line = logs[i]

		// System messages
		if (SYSTEM_PATTERN.test(line)) {
			segments.push({ type: 'system', content: line })
			i++
			continue
		}

		// Tool call: starts with ⏺ marker (Claude Code format)
		const toolMatch = line.match(TOOL_CALL_PATTERN)
		if (toolMatch) {
			const toolName = toolMatch[1].trim()
			const contentLines: string[] = []
			i++

			// Collect indented content under the tool call
			while (i < logs.length) {
				const next = logs[i]
				// Stop at another tool call, result marker, or non-indented line
				if (TOOL_CALL_PATTERN.test(next)) break
				if (TOOL_RESULT_PATTERN.test(next)) break
				// Indented content (spaces or tab) or empty lines belong to this tool call
				if (next.startsWith('  ') || next.startsWith('\t') || next === '') {
					contentLines.push(next)
					i++
				} else {
					break
				}
			}

			segments.push({
				type: 'tool_call',
				toolName,
				content: contentLines.join('\n').trim(),
			})

			// Check for result marker immediately after
			if (i < logs.length && TOOL_RESULT_PATTERN.test(logs[i])) {
				const resultLines: string[] = []
				// First result line might have content after the marker
				const firstResultLine = logs[i].replace(TOOL_RESULT_PATTERN, '').trim()
				if (firstResultLine) resultLines.push(firstResultLine)
				i++

				// Collect indented result content
				while (i < logs.length) {
					const next = logs[i]
					if (TOOL_CALL_PATTERN.test(next)) break
					if (TOOL_RESULT_PATTERN.test(next) && !next.startsWith('  ')) break
					if (next.startsWith('  ') || next.startsWith('\t') || next === '') {
						resultLines.push(next)
						i++
					} else {
						break
					}
				}

				if (resultLines.length > 0) {
					segments.push({
						type: 'tool_result',
						toolName,
						content: resultLines.join('\n').trim(),
					})
				}
			}
			continue
		}

		// Result marker without a preceding tool call (standalone)
		if (TOOL_RESULT_PATTERN.test(line)) {
			const resultContent = line.replace(TOOL_RESULT_PATTERN, '').trim()
			const resultLines: string[] = resultContent ? [resultContent] : []
			i++

			while (i < logs.length) {
				const next = logs[i]
				if (TOOL_CALL_PATTERN.test(next)) break
				if (next.startsWith('  ') || next.startsWith('\t') || next === '') {
					resultLines.push(next)
					i++
				} else {
					break
				}
			}

			if (resultLines.length > 0) {
				segments.push({
					type: 'tool_result',
					content: resultLines.join('\n').trim(),
				})
			}
			continue
		}

		// Thinking marker
		if (THINKING_START.test(line.trim())) {
			const thinkLines: string[] = [line]
			i++

			// Collect subsequent indented or empty lines as part of thinking
			while (i < logs.length) {
				const next = logs[i]
				if (TOOL_CALL_PATTERN.test(next)) break
				if (SYSTEM_PATTERN.test(next)) break
				if (next === '' || next.startsWith('  ') || next.startsWith('\t')) {
					thinkLines.push(next)
					i++
				} else {
					break
				}
			}

			segments.push({
				type: 'thinking',
				content: thinkLines.join('\n').trim(),
			})
			continue
		}

		// Default: plain text — accumulate consecutive plain lines
		const textLines: string[] = [line]
		i++

		while (i < logs.length) {
			const next = logs[i]
			if (TOOL_CALL_PATTERN.test(next)) break
			if (TOOL_RESULT_PATTERN.test(next)) break
			if (THINKING_START.test(next.trim())) break
			if (SYSTEM_PATTERN.test(next)) break
			textLines.push(next)
			i++
		}

		const content = textLines.join('\n').trim()
		if (content) {
			segments.push({ type: 'text', content })
		}
	}

	return segments
}

/**
 * Count tool calls in a list of segments for summary display.
 */
export function countToolCalls(segments: LogSegment[]): number {
	return segments.filter((s) => s.type === 'tool_call').length
}

/**
 * Count errors in a list of segments.
 */
export function countErrors(segments: LogSegment[]): number {
	return segments.filter((s) => s.type === 'error').length
}
