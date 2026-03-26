import { z } from 'zod'

/** Object types provided by the Meetings module */
export const MEETINGS_OBJECT_TYPES = [
	{
		type: 'meeting',
		label: 'Meeting',
		pluralLabel: 'Meetings',
		icon: 'video',
		defaultStatuses: [
			'scheduled',
			'in_progress',
			'recording',
			'processing',
			'completed',
			'cancelled',
		],
	},
] as const

/** Meeting attendee schema */
export const meetingAttendeeSchema = z.object({
	email: z.string().email(),
	name: z.string().optional(),
	response_status: z.enum(['accepted', 'declined', 'tentative', 'needs_action']).optional(),
	actor_id: z.string().uuid().optional(),
})

/** Recording reference (stored in S3) */
export const meetingRecordingSchema = z.object({
	storage_key: z.string(),
	format: z.string(),
	duration_seconds: z.number().optional(),
	size_bytes: z.number().optional(),
})

/** Transcript reference (stored in S3) */
export const meetingTranscriptRefSchema = z.object({
	storage_key: z.string(),
	format: z.enum(['json', 'srt', 'vtt', 'txt']),
	language: z.string().optional(),
	word_count: z.number().optional(),
})

/** Full meeting metadata schema — stored in objects.metadata JSONB */
export const meetingMetadataSchema = z.object({
	// Calendar source
	calendar_event_id: z.string().optional(),
	calendar_provider: z.enum(['google_calendar', 'outlook_calendar']).optional(),
	ical_uid: z.string().optional(),

	// Meeting details
	meeting_url: z.string().optional(),
	meeting_platform: z.enum(['google_meet', 'zoom', 'teams', 'webex', 'other']).optional(),
	organizer_email: z.string().optional(),

	// Scheduling
	start_time: z.string().datetime().optional(),
	end_time: z.string().datetime().optional(),
	timezone: z.string().optional(),
	duration_minutes: z.number().optional(),
	is_recurring: z.boolean().optional(),
	recurrence_id: z.string().optional(),

	// Attendees
	attendees: z.array(meetingAttendeeSchema).optional(),

	// Bot provider
	bot_provider: z.enum(['recall', 'fireflies', 'meetingbaas']).optional(),
	bot_id: z.string().optional(),
	bot_status: z
		.enum(['pending', 'joining', 'in_meeting', 'recording', 'processing', 'done', 'failed'])
		.optional(),

	// Recording (S3 reference)
	recording: meetingRecordingSchema.optional(),

	// Transcript (S3 reference)
	transcript: meetingTranscriptRefSchema.optional(),

	// Integration reference
	integration_id: z.string().uuid().optional(),
})

export type MeetingAttendee = z.infer<typeof meetingAttendeeSchema>
export type MeetingRecording = z.infer<typeof meetingRecordingSchema>
export type MeetingTranscriptRef = z.infer<typeof meetingTranscriptRefSchema>
export type MeetingMetadata = z.infer<typeof meetingMetadataSchema>
