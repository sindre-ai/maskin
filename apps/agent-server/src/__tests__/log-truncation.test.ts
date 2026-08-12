import { describe, expect, it } from 'vitest'
import { MAX_LOG_LINE_BYTES, truncateLogLine } from '../index'

describe('truncateLogLine', () => {
	it('returns short lines unchanged', () => {
		const line = 'agent starting up\n'
		expect(truncateLogLine(line)).toBe(line)
	})

	it('returns a line exactly at the byte limit unchanged', () => {
		const line = 'x'.repeat(MAX_LOG_LINE_BYTES)
		expect(truncateLogLine(line)).toBe(line)
	})

	it('truncates an oversized line and appends a truncation marker', () => {
		// A single NDJSON stdout line with no embedded newline — the shape that
		// used to fail the server's per-line cap and drop the whole batch.
		const oversized = 'x'.repeat(MAX_LOG_LINE_BYTES + 50_000)

		const result = truncateLogLine(oversized)

		expect(result.length).toBeLessThan(oversized.length)
		expect(result).toContain('...[truncated 50000 bytes]')
		expect(new TextEncoder().encode(result).length).toBeLessThan(
			new TextEncoder().encode(oversized).length,
		)
	})

	it('preserves a trailing newline after truncation', () => {
		const oversized = `${'x'.repeat(MAX_LOG_LINE_BYTES + 1_000)}\n`

		const result = truncateLogLine(oversized)

		expect(result.endsWith('\n')).toBe(true)
	})

	it('does not add a trailing newline when the original line had none', () => {
		const oversized = 'x'.repeat(MAX_LOG_LINE_BYTES + 1_000)

		const result = truncateLogLine(oversized)

		expect(result.endsWith('\n')).toBe(false)
	})

	it('measures by UTF-8 byte length, not JS string length, for multi-byte content', () => {
		// Each emoji is 4 bytes in UTF-8 but 2 UTF-16 code units in JS string length.
		const emoji = '😀'
		const line = emoji.repeat(Math.ceil((MAX_LOG_LINE_BYTES + 4_000) / 4))

		const result = truncateLogLine(line)

		expect(new TextEncoder().encode(result).length).toBeLessThan(
			new TextEncoder().encode(line).length,
		)
		expect(result).toContain('...[truncated')
	})

	it('respects a custom maxBytes argument', () => {
		const line = 'x'.repeat(100)
		const result = truncateLogLine(line, 10)
		expect(result).toBe(`${'x'.repeat(10)}...[truncated 90 bytes]`)
	})
})
