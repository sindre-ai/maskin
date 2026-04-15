import { countErrors, countToolCalls, parseLogLines } from '@/lib/parse-session-logs'
import { describe, expect, it } from 'vitest'

describe('parseLogLines', () => {
	it('returns empty array for empty input', () => {
		expect(parseLogLines([])).toEqual([])
	})

	it('parses plain text as a text segment', () => {
		const result = parseLogLines(['Hello world', 'Second line'])
		expect(result).toHaveLength(1)
		expect(result[0].type).toBe('text')
		expect(result[0].content).toBe('Hello world\nSecond line')
	})

	it('parses tool call with marker', () => {
		const result = parseLogLines(['⏺ Read file.ts', '  Reading contents...'])
		expect(result).toHaveLength(1)
		expect(result[0].type).toBe('tool_call')
		expect(result[0].toolName).toBe('Read file.ts')
		expect(result[0].content).toBe('Reading contents...')
	})

	it('parses tool call followed by result', () => {
		const result = parseLogLines([
			'⏺ Read file.ts',
			'  path: /src/index.ts',
			'⎿ File contents here',
			'  line 1',
			'  line 2',
		])
		expect(result).toHaveLength(2)
		expect(result[0].type).toBe('tool_call')
		expect(result[0].toolName).toBe('Read file.ts')
		expect(result[1].type).toBe('tool_result')
		expect(result[1].content).toContain('File contents here')
	})

	it('parses multiple tool calls in sequence', () => {
		const result = parseLogLines([
			'⏺ Read file.ts',
			'  path: /a.ts',
			'⏺ Write file.ts',
			'  path: /b.ts',
		])
		expect(result).toHaveLength(2)
		expect(result[0].type).toBe('tool_call')
		expect(result[0].toolName).toBe('Read file.ts')
		expect(result[1].type).toBe('tool_call')
		expect(result[1].toolName).toBe('Write file.ts')
	})

	it('parses system messages', () => {
		const result = parseLogLines(['Session completed successfully'])
		expect(result).toHaveLength(1)
		expect(result[0].type).toBe('system')
	})

	it('parses thinking segments', () => {
		const result = parseLogLines(['Thinking...', '  I need to analyze the code'])
		expect(result).toHaveLength(1)
		expect(result[0].type).toBe('thinking')
		expect(result[0].content).toContain('I need to analyze')
	})

	it('handles mixed content gracefully', () => {
		const result = parseLogLines([
			'Starting task',
			'⏺ Read main.ts',
			'  file: main.ts',
			'⎿ contents of main.ts',
			'Done reading',
		])
		expect(result).toHaveLength(4)
		expect(result[0].type).toBe('text')
		expect(result[1].type).toBe('tool_call')
		expect(result[2].type).toBe('tool_result')
		expect(result[3].type).toBe('text')
	})

	it('never throws on malformed input', () => {
		expect(() => parseLogLines([''])).not.toThrow()
		expect(() => parseLogLines(['⏺'])).not.toThrow()
		expect(() => parseLogLines(['⎿'])).not.toThrow()
		expect(() => parseLogLines(['\t', '  ', ''])).not.toThrow()
	})

	it('handles tool call without content', () => {
		const result = parseLogLines(['⏺ Bash'])
		expect(result).toHaveLength(1)
		expect(result[0].type).toBe('tool_call')
		expect(result[0].toolName).toBe('Bash')
		expect(result[0].content).toBe('')
	})
})

describe('countToolCalls', () => {
	it('counts tool call segments', () => {
		const segments = parseLogLines(['⏺ Read file.ts', '⏺ Write file.ts', 'Some text'])
		expect(countToolCalls(segments)).toBe(2)
	})

	it('returns 0 for no tool calls', () => {
		const segments = parseLogLines(['Hello world'])
		expect(countToolCalls(segments)).toBe(0)
	})
})

describe('countErrors', () => {
	it('returns 0 for segments without errors', () => {
		const segments = parseLogLines(['Hello world'])
		expect(countErrors(segments)).toBe(0)
	})
})
