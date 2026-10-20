import { describe, expect, it } from 'vitest'
import {
	fromSuggestedStepSchema,
	messageMetadataSchema,
	neededToolsSchema,
	stripServerOwnedMetadata,
	suggestedStepSchema,
	suggestedStepsSchema,
} from '../schemas/conversations'

const SESSION_ID = '11111111-1111-1111-1111-111111111111'

describe('stripServerOwnedMetadata', () => {
	it('removes integration_connect so a client cannot forge a Connect card', () => {
		const stripped = stripServerOwnedMetadata({
			mentions: [SESSION_ID],
			integration_connect: { session_id: SESSION_ID, provider: 'linear' },
		})

		expect(stripped).toEqual({ mentions: [SESSION_ID] })
	})

	it('removes helper_return so a client cannot forge the marker that hides a message', () => {
		const stripped = stripServerOwnedMetadata({
			mentions: [SESSION_ID],
			helper_return: SESSION_ID,
		})

		expect(stripped).toEqual({ mentions: [SESSION_ID] })
	})

	it('still removes the markers it already owned', () => {
		const stripped = stripServerOwnedMetadata({
			source: 'final_output',
			question: { session_id: SESSION_ID, questions: [] },
			question_answer: { question_message_id: 1, answers: [] },
		})

		// question_answer is client-supplied by design, so it must survive.
		expect(stripped).toEqual({ question_answer: { question_message_id: 1, answers: [] } })
	})
})

describe('messageMetadataSchema integration_connect', () => {
	it('accepts a session id and a provider name', () => {
		const parsed = messageMetadataSchema.safeParse({
			integration_connect: { session_id: SESSION_ID, provider: 'linear' },
		})

		expect(parsed.success).toBe(true)
	})

	it('rejects a card with no provider or a non-uuid session', () => {
		expect(
			messageMetadataSchema.safeParse({
				integration_connect: { session_id: SESSION_ID, provider: '' },
			}).success,
		).toBe(false)
		expect(
			messageMetadataSchema.safeParse({
				integration_connect: { session_id: 'nope', provider: 'linear' },
			}).success,
		).toBe(false)
	})
})

describe('stripServerOwnedMetadata intro keys', () => {
	it('removes suggested_steps, needed_tools and plain_tail but keeps from_suggested_step', () => {
		const stripped = stripServerOwnedMetadata({
			mentions: [SESSION_ID],
			suggested_steps: [{ label: 'Wire money', prompt: 'Wire money', action: 'send' }],
			needed_tools: [{ provider: 'linear' }],
			plain_tail: 2,
			from_suggested_step: { intro_message_id: 7, index: 1 },
		})

		expect(stripped).toEqual({
			mentions: [SESSION_ID],
			from_suggested_step: { intro_message_id: 7, index: 1 },
		})
	})
})

describe('suggestedStepSchema', () => {
	const fill = { label: 'Draft a reply', prompt: 'Draft a reply to: ', action: 'fill' }

	it('accepts a fill step whose prompt ends in a space and is not the label', () => {
		expect(suggestedStepSchema.safeParse(fill).success).toBe(true)
	})

	it('accepts a send step whose prompt equals its label', () => {
		expect(
			suggestedStepSchema.safeParse({
				label: 'Read my inbox',
				prompt: 'Read my inbox',
				action: 'send',
			}).success,
		).toBe(true)
	})

	it('rejects a send step whose prompt differs from its label', () => {
		expect(
			suggestedStepSchema.safeParse({
				label: 'Read my inbox',
				prompt: 'Delete my inbox',
				action: 'send',
			}).success,
		).toBe(false)
	})

	it('rejects a send step whose prompt ends in a space', () => {
		expect(
			suggestedStepSchema.safeParse({
				label: 'Read my inbox',
				prompt: 'Read my inbox ',
				action: 'send',
			}).success,
		).toBe(false)
	})

	it('rejects control characters and line breaks in label or prompt', () => {
		expect(suggestedStepSchema.safeParse({ ...fill, label: 'two\nlines' }).success).toBe(false)
		expect(suggestedStepSchema.safeParse({ ...fill, prompt: 'tab\there' }).success).toBe(false)
	})

	it('requires the action', () => {
		expect(suggestedStepSchema.safeParse({ label: 'x', prompt: 'x' }).success).toBe(false)
	})

	it('holds 1 to 4 steps', () => {
		expect(suggestedStepsSchema.safeParse([]).success).toBe(false)
		expect(suggestedStepsSchema.safeParse(Array(4).fill(fill)).success).toBe(true)
		expect(suggestedStepsSchema.safeParse(Array(5).fill(fill)).success).toBe(false)
	})
})

describe('neededToolsSchema', () => {
	it('holds 1 to 3 provider names', () => {
		expect(neededToolsSchema.safeParse([]).success).toBe(false)
		expect(
			neededToolsSchema.safeParse([{ provider: 'a' }, { provider: 'b' }, { provider: 'c' }])
				.success,
		).toBe(true)
		expect(
			neededToolsSchema.safeParse([
				{ provider: 'a' },
				{ provider: 'b' },
				{ provider: 'c' },
				{ provider: 'd' },
			]).success,
		).toBe(false)
	})

	it('rejects an empty or over-long provider name', () => {
		expect(neededToolsSchema.safeParse([{ provider: '' }]).success).toBe(false)
		expect(neededToolsSchema.safeParse([{ provider: 'x'.repeat(101) }]).success).toBe(false)
	})
})

describe('fromSuggestedStepSchema', () => {
	it('takes an intro message id and an index from 0 to 3', () => {
		expect(fromSuggestedStepSchema.safeParse({ intro_message_id: 5, index: 3 }).success).toBe(true)
		expect(fromSuggestedStepSchema.safeParse({ intro_message_id: 5, index: 4 }).success).toBe(false)
		expect(fromSuggestedStepSchema.safeParse({ intro_message_id: 5, index: -1 }).success).toBe(
			false,
		)
		expect(fromSuggestedStepSchema.safeParse({ intro_message_id: 1.5, index: 0 }).success).toBe(
			false,
		)
	})
})

describe('messageMetadataSchema intro keys', () => {
	it('accepts suggested_steps, needed_tools, plain_tail and from_suggested_step', () => {
		const parsed = messageMetadataSchema.safeParse({
			suggested_steps: [{ label: 'Read my inbox', prompt: 'Read my inbox', action: 'send' }],
			needed_tools: [{ provider: 'gmail' }],
			plain_tail: 2,
			from_suggested_step: { intro_message_id: 9, index: 0 },
		})

		expect(parsed.success).toBe(true)
	})
})
