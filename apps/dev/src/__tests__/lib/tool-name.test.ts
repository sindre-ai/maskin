import { describe, expect, it } from 'vitest'
import { formatToolName } from '../../lib/tool-name'

describe('formatToolName', () => {
	it('drops the mcp prefix and server segment', () => {
		expect(formatToolName('mcp__maskin__desktop_run')).toBe('desktop run')
	})

	it('handles server names with hyphens', () => {
		expect(formatToolName('mcp__github-sindre-ai__get_file_contents')).toBe('get file contents')
	})

	it('keeps built-in tool names as they are', () => {
		expect(formatToolName('Read')).toBe('Read')
	})

	it('leaves a name with no underscores alone', () => {
		expect(formatToolName('search')).toBe('search')
	})
})
