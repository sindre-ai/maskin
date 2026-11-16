import type { ActivityStep } from '@/components/agents/session-log-transcript'
import { plainActivityLine, plainStepLabel } from '@/lib/plain-activity'
import { describe, expect, it } from 'vitest'

const tool = (name: string): ActivityStep => ({
	id: name,
	kind: 'tool_use',
	text: name,
	tool: name,
})

describe('plainStepLabel', () => {
	it('maps known tools to short plain verbs, ignoring the mcp server prefix', () => {
		expect(plainStepLabel(tool('mcp__maskin__get_comments'))).toBe('Reading comments')
		expect(plainStepLabel(tool('mcp__maskin__list_triggers'))).toBe('Checking triggers')
		expect(plainStepLabel(tool('mcp__maskin__post_conversation_message'))).toBe('Writing a reply')
		expect(plainStepLabel(tool('Read'))).toBe('Reading files')
	})

	it('falls back to the verb at the front of the tool name', () => {
		expect(plainStepLabel(tool('mcp__maskin__list_objects'))).toBe('Looking things up')
		expect(plainStepLabel(tool('mcp__maskin__update_objects'))).toBe('Saving changes')
	})

	it('reads "Working" for a tool with no friendly name', () => {
		expect(plainStepLabel(tool('mcp__maskin__desktop_run'))).toBe('Working')
		expect(plainStepLabel({ id: 'x', kind: 'tool_use', text: 'Old step' })).toBe('Working')
	})

	it('has no line for Bash, thoughts or user messages', () => {
		expect(plainStepLabel(tool('Bash'))).toBeNull()
		expect(plainStepLabel({ id: 't', kind: 'thinking', text: 'Thinking…' })).toBeNull()
		expect(plainStepLabel({ id: 'u', kind: 'user', text: 'hi' })).toBeNull()
	})
})

describe('plainActivityLine', () => {
	it('uses the latest step that has a plain line', () => {
		expect(
			plainActivityLine([
				tool('mcp__maskin__get_comments'),
				tool('Bash'),
				{ id: 't', kind: 'thinking', text: 'Thinking…' },
			]),
		).toBe('Reading comments')
	})

	it('reads "Working" when no step has a plain line', () => {
		expect(plainActivityLine([tool('Bash')])).toBe('Working')
		expect(plainActivityLine([])).toBe('Working')
	})
})
