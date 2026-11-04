import { describe, expect, it } from 'vitest'
import { classifyToolKind, resolveToolKind } from '../../../lib/integrations/tool-kind'

describe('classifyToolKind', () => {
	it.each(['get_transcript', 'list_meetings', 'read_note', 'search_calls', 'find_user'])(
		'classifies %s as read',
		(name) => {
			expect(classifyToolKind(name)).toBe('read')
		},
	)

	it.each([
		'create_task',
		'delete_meeting',
		'send_message',
		'update_note',
		'getaway',
		'upload_file',
	])('classifies %s as write', (name) => {
		expect(classifyToolKind(name)).toBe('write')
	})
})

describe('resolveToolKind', () => {
	it('lets a declared kind win over the name', () => {
		expect(resolveToolKind({ name: 'get_and_delete', kind: 'write' })).toBe('write')
		expect(resolveToolKind({ name: 'create_report', kind: 'read' })).toBe('read')
	})

	it('falls back to the name when no kind is declared', () => {
		expect(resolveToolKind({ name: 'list_items' })).toBe('read')
		expect(resolveToolKind({ name: 'archive_item' })).toBe('write')
	})
})
