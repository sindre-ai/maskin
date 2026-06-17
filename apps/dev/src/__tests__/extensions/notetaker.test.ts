import notetakerExtension from '@maskin/ext-notetaker/server'
import { MEETING_FIELDS, NOTETAKER_DEFAULT_SETTINGS } from '@maskin/ext-notetaker/shared'
import { describe, expect, it } from 'vitest'

describe('notetaker extension', () => {
	const meetingType = notetakerExtension.objectTypes.find((t) => t.type === 'meeting')

	it('registers the meeting object type', () => {
		expect(meetingType).toBeDefined()
	})

	it('exposes the M1 fields on the meeting type', () => {
		const fieldNames = meetingType?.defaultFields?.map((f) => f.name) ?? []
		expect(fieldNames).toEqual([
			'meetingUrl',
			'startTime',
			'endTime',
			'language',
			'audioUrl',
			'transcriptUrl',
			'calendarProvider',
			'calendarEventId',
			'skjaldJoin',
			'botName',
			'autoJoin',
		])
	})

	it('mirrors MEETING_FIELDS into defaultSettings.field_definitions.meeting', () => {
		expect(NOTETAKER_DEFAULT_SETTINGS.field_definitions?.meeting).toBe(MEETING_FIELDS)
		expect(notetakerExtension.defaultSettings?.field_definitions?.meeting).toBe(MEETING_FIELDS)
	})

	it('constrains calendarProvider to known values and types booleans for join policy', () => {
		const byName = Object.fromEntries(MEETING_FIELDS.map((f) => [f.name, f]))
		expect(byName.calendarProvider).toMatchObject({ type: 'enum', values: ['google'] })
		expect(byName.skjaldJoin?.type).toBe('boolean')
		expect(byName.autoJoin?.type).toBe('boolean')
	})
})
