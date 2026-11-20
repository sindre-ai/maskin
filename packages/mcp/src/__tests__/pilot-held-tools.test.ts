import { PILOT_HELD_MASKIN_TOOLS, isPilotHeldMaskinTool } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { READ_ONLY_TOOLS, TOOL_ANNOTATIONS } from '../annotations.js'

describe('the Maskin tools a pilot flow holds', () => {
	it('names only tools this server registers, so a rename cannot leave one unheld', () => {
		for (const name of PILOT_HELD_MASKIN_TOOLS) expect(TOOL_ANNOTATIONS).toHaveProperty(name)
	})

	it('holds none of the read-only tools', () => {
		for (const name of PILOT_HELD_MASKIN_TOOLS) expect(READ_ONLY_TOOLS.has(name)).toBe(false)
	})

	it('holds a tool with no row in the annotation table, because nobody classified it', () => {
		expect(
			isPilotHeldMaskinTool(
				'new_tool_nobody_classified',
				'new_tool_nobody_classified' in TOOL_ANNOTATIONS,
			),
		).toBe(true)
		expect(isPilotHeldMaskinTool('create_comment', 'create_comment' in TOOL_ANNOTATIONS)).toBe(
			false,
		)
	})
})
