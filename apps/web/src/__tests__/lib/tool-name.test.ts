import { formatToolName } from '@/lib/tool-name'
import { describe, expect, it } from 'vitest'

describe('formatToolName', () => {
	it('drops the mcp prefix and server segment', () => {
		expect(formatToolName('mcp__maskin__desktop_run')).toBe('Desktop run')
	})

	it('handles server names with hyphens', () => {
		expect(formatToolName('mcp__github-sindre-ai__get_file_contents')).toBe('Get file contents')
	})

	it('keeps built-in tool names as they are', () => {
		expect(formatToolName('Read')).toBe('Read')
	})

	it('capitalises only the first letter', () => {
		expect(formatToolName('search')).toBe('Search')
		expect(formatToolName('mcp__maskin__create_session')).toBe('Create session')
		expect(formatToolName('mcp__x__getFooBar')).toBe('GetFooBar')
	})
})
