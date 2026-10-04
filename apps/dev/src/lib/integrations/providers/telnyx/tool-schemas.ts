import { z } from '@hono/zod-openapi'

/** The five tools the assistant declares. send_followup_sms is deliberately absent (CTO ruling 2026-10-03). */
export const DECLARED_TOOL_NAMES = [
	'book_meeting_slot',
	'confirm_meeting_slot',
	'flag_interest',
	'end_call_polite',
	'request_followup_email',
] as const
export type DeclaredToolName = (typeof DECLARED_TOOL_NAMES)[number]

/** Declared in Rev 1.3 but switched off for the pilot: the router answers not_enabled and does nothing. */
export const DISABLED_TOOL_NAMES = ['send_followup_sms'] as const

export const E164_RE = /^\+[1-9]\d{6,14}$/

export const bookMeetingSlotInput = z.object({
	prospect_email: z.string().trim().email().max(254),
	prospect_name: z.string().trim().min(1).max(100),
	preferred_window: z.string().trim().min(1).max(100).optional(),
})

export const bookMeetingSlotOutput = z.object({
	slots: z.array(z.object({ start_iso: z.string(), end_iso: z.string() })).max(3),
})

export const confirmMeetingSlotInput = z.object({
	/** The number of the option read out: 1, 2 or 3. */
	slot_index: z.number().int().min(1).max(3),
	prospect_email: z.string().trim().email().max(254),
	prospect_name: z.string().trim().min(1).max(100),
})

export const confirmMeetingSlotOutput = z.object({
	event_id: z.string(),
	meet_link: z.string(),
})

export const flagInterestInput = z.object({
	strength: z.enum(['warm', 'hot']),
	reason: z.string().trim().min(1).max(500),
})

export const endCallPoliteInput = z.object({
	reason: z.string().trim().min(1).max(200),
})

export const acknowledgedOutput = z.object({ acknowledged: z.literal(true) })

export const requestFollowupEmailInput = z.object({
	prospect_quote: z.string().trim().min(1).max(280),
	/** Only used when Telnyx supplies no record of the agent's last turn. */
	agent_line: z.string().trim().min(1).max(500).optional(),
})

/** What the model is told when a tool did not run. Always a 200 body: Telnyx feeds it back to the model. */
export const toolErrorOutput = z.object({
	error: z.enum([
		'invalid_input',
		'unknown_tool',
		'not_enabled',
		'call_not_current',
		'calendar_unavailable',
		'unknown_slot',
		'no_address_on_file',
		'agent_line_required',
	]),
	issues: z.array(z.string()).optional(),
})
export type ToolError = z.infer<typeof toolErrorOutput>

interface ToolDeclaration {
	name: DeclaredToolName
	description: string
	parameters: Record<string, unknown>
}

const str = (description: string, extra: Record<string, unknown> = {}) => ({
	type: 'string',
	description,
	...extra,
})

/**
 * What the assistant is told about each tool. Descriptions are the model's only guidance on when
 * to call, so the email one carries the full consent condition.
 */
export const TOOL_DECLARATIONS: readonly ToolDeclaration[] = [
	{
		name: 'book_meeting_slot',
		description:
			'Get 3 free meeting times. Call when the prospect wants to meet. Read the options aloud, then call confirm_meeting_slot with the one they pick.',
		parameters: {
			type: 'object',
			properties: {
				prospect_email: str('The prospect email address.', { format: 'email' }),
				prospect_name: str('The prospect name.'),
				preferred_window: str('Optional. When they prefer, for example morning or afternoon.'),
			},
			required: ['prospect_email', 'prospect_name'],
		},
	},
	{
		name: 'confirm_meeting_slot',
		description:
			'Book the time the prospect picked from book_meeting_slot. slot_index is the number of the option: 1, 2 or 3. Only after they said which time works.',
		parameters: {
			type: 'object',
			properties: {
				slot_index: { type: 'integer', minimum: 1, maximum: 3 },
				prospect_email: str('The prospect email address.', { format: 'email' }),
				prospect_name: str('The prospect name.'),
			},
			required: ['slot_index', 'prospect_email', 'prospect_name'],
		},
	},
	{
		name: 'flag_interest',
		description:
			'Record that the prospect is interested. hot: wants to talk to a person now. warm: open to it later. Then book a slot.',
		parameters: {
			type: 'object',
			properties: {
				strength: { type: 'string', enum: ['warm', 'hot'] },
				reason: str('One sentence on what the prospect said that shows interest.'),
			},
			required: ['strength', 'reason'],
		},
	},
	{
		name: 'end_call_polite',
		description:
			'End the call politely. After a warm or hot signal, only after book_meeting_slot and confirm_meeting_slot have run.',
		parameters: {
			type: 'object',
			properties: { reason: str('Why the call is ending.') },
			required: ['reason'],
		},
	},
	{
		name: 'request_followup_email',
		description:
			'Record that the prospect asked for one follow-up email. Call only after the prospect raised email themselves, you confirmed the address and told them they can opt out any time, and they said yes. Pass their words. Never call it to offer or to be helpful.',
		parameters: {
			type: 'object',
			properties: {
				prospect_quote: str(
					'The prospect words answering your confirmation, 1 to 280 characters.',
					{
						maxLength: 280,
					},
				),
				agent_line: str('Your own last sentence before their yes, word for word.', {
					maxLength: 500,
				}),
			},
			required: ['prospect_quote', 'agent_line'],
		},
	},
]
