import { describe, expect, it } from 'vitest'
import { DISCOVERY_LOOP } from '../../../lib/marketplace-loops/discovery-loop'
import {
	loopSettingsForInstall,
	loopSettingsPatch,
	loopSettingsSchema,
	readLoopSettings,
} from '../../../lib/marketplace-loops/loop-settings'

const settings = {
	entryCondition: 'An insight arrives.',
	closeCondition: 'The insight has a home.',
	tags: ['Product', 'product'],
	targets: [{ label: 'Items passed', source: 'Graded weekly', actual: 0, target: 15 }],
}

describe('loopSettingsForInstall', () => {
	it('gives a new install the text, the targets and a copy of the text as shipped', () => {
		const meta = loopSettingsForInstall(settings)
		expect(meta.entry_condition).toBe('An insight arrives.')
		expect(meta.close_condition).toBe('The insight has a home.')
		expect(meta.tags).toEqual(['Product'])
		expect(meta.targets).toEqual(settings.targets)
		expect(meta.shipped_loop_settings).toEqual({
			entry_condition: 'An insight arrives.',
			close_condition: 'The insight has a home.',
			tags: ['Product'],
		})
	})

	it('writes nothing for a loop that ships no settings', () => {
		expect(loopSettingsForInstall(null)).toEqual({})
		expect(loopSettingsForInstall({})).toEqual({})
	})
})

describe('loopSettingsPatch', () => {
	const next = { ...settings, entryCondition: 'A new insight arrives.' }

	it('refreshes a field that is still on the shipped text and keeps an edited one', () => {
		const installed = loopSettingsForInstall(settings)
		const edited = { ...installed, close_condition: 'Our own close rule.' }
		const patch = loopSettingsPatch(next, edited)
		expect(patch.entry_condition).toBe('A new insight arrives.')
		expect(patch).not.toHaveProperty('close_condition')
		expect(patch).not.toHaveProperty('targets')
		expect((patch.shipped_loop_settings as Record<string, unknown>).close_condition).toBe(
			'The insight has a home.',
		)
	})

	it('fills only the fields a pre-settings install lacks, and seeds targets once', () => {
		const patch = loopSettingsPatch(next, { close_condition: 'Our own close rule.' })
		expect(patch.entry_condition).toBe('A new insight arrives.')
		expect(patch).not.toHaveProperty('close_condition')
		expect(patch.targets).toEqual(settings.targets)
	})

	it('does not touch a loop that already has targets', () => {
		const patch = loopSettingsPatch(next, { targets: [{ label: 'x' }] })
		expect(patch).not.toHaveProperty('targets')
	})

	it('writes nothing when nothing changed or the loop ships no settings', () => {
		expect(loopSettingsPatch(settings, loopSettingsForInstall(settings))).toEqual({})
		expect(loopSettingsPatch(null, {})).toEqual({})
	})
})

describe('readLoopSettings', () => {
	it('reads a stored value and treats a malformed one as no settings', () => {
		expect(readLoopSettings(settings)?.entryCondition).toBe('An insight arrives.')
		expect(readLoopSettings(null)).toBeNull()
		expect(readLoopSettings({ targets: 'nope' })).toBeNull()
	})

	it('drops the owner from a shipped target', () => {
		const withOwner = {
			targets: [
				{
					label: 'x',
					source: 'y',
					actual: 0,
					target: 1,
					ownerActorId: '6a3e3c2a-ad56-4c06-aa1d-6b3879fad45c',
				},
			],
		}
		const parsed = loopSettingsSchema.parse(withOwner)
		expect(parsed.targets?.[0]).not.toHaveProperty('ownerActorId')
	})
})

describe('Product Discovery settings', () => {
	it('ships the conditions, the tag and only the target the CPO grading trigger keeps current', () => {
		const parsed = loopSettingsSchema.parse(DISCOVERY_LOOP.settings)
		expect(parsed.entryCondition).toBeTruthy()
		expect(parsed.closeCondition).toBeTruthy()
		expect(parsed.tags).toEqual(['Product'])
		expect(parsed.targets?.map((t) => t.label)).toEqual([
			'Understanding acceptance (items passed of 15)',
		])
	})
})
