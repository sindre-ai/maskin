import { describe, expect, it } from 'vitest'
import {
	messageMetadataSchema,
	messagePlanSchema,
	messageProposedEditSchema,
	proposedEditToUpdate,
	stripServerOwnedMetadata,
} from '../schemas/conversations'

const OBJECT_ID = '11111111-1111-1111-1111-111111111111'
const plan = { version: 1, steps: [{ title: 'Draft', status: 'pending' }, { title: 'Send' }] }
const edit = (field: string, after: string | number | boolean | null) => ({
	version: 1,
	object_id: OBJECT_ID,
	field,
	before: 'old',
	after,
})

describe('message plan', () => {
	it('accepts steps with an optional status', () => {
		expect(messagePlanSchema.safeParse(plan).success).toBe(true)
	})

	it('rejects an unknown version, no steps and an unknown status', () => {
		expect(messagePlanSchema.safeParse({ ...plan, version: 2 }).success).toBe(false)
		expect(messagePlanSchema.safeParse({ version: 1, steps: [] }).success).toBe(false)
		expect(
			messagePlanSchema.safeParse({ version: 1, steps: [{ title: 'x', status: 'blocked' }] })
				.success,
		).toBe(false)
	})
})

describe('message proposed edit', () => {
	it('accepts a field and a metadata key, and rejects anything else', () => {
		expect(messageProposedEditSchema.safeParse(edit('title', 'New')).success).toBe(true)
		expect(messageProposedEditSchema.safeParse(edit('metadata.cadence', 'daily')).success).toBe(
			true,
		)
		expect(messageProposedEditSchema.safeParse(edit('driver', 'x')).success).toBe(false)
		expect(messageProposedEditSchema.safeParse(edit('metadata.a.b', 'x')).success).toBe(false)
	})
})

describe('proposedEditToUpdate', () => {
	it('builds the normal object update body', () => {
		expect(proposedEditToUpdate(edit('title', 'New') as never)).toEqual({ title: 'New' })
		expect(proposedEditToUpdate(edit('status', 'done') as never)).toEqual({ status: 'done' })
		expect(proposedEditToUpdate(edit('metadata.cadence', 'daily') as never)).toEqual({
			metadata: { cadence: 'daily' },
		})
	})

	it('returns null for a non-text title, content or status', () => {
		expect(proposedEditToUpdate(edit('title', 3) as never)).toBeNull()
	})
})

describe('stripServerOwnedMetadata with plan and proposed_edit', () => {
	const metadata = { plan, proposed_edit: edit('title', 'New'), mentions: [OBJECT_ID] }

	it('drops them for a person and for an unspecified caller', () => {
		expect(stripServerOwnedMetadata(metadata, { callerType: 'human' })).toEqual({
			mentions: [OBJECT_ID],
		})
		expect(stripServerOwnedMetadata(metadata)).toEqual({ mentions: [OBJECT_ID] })
	})

	it('keeps them for an agent, but still drops the cards only the server writes', () => {
		const kept = stripServerOwnedMetadata(
			{ ...metadata, source: 'final_output' },
			{ callerType: 'agent' },
		)
		expect(kept).toEqual(metadata)
	})

	it('leaves old clients unaffected: metadata without the keys parses as before', () => {
		expect(messageMetadataSchema.parse({ mentions: [OBJECT_ID] })).toEqual({
			mentions: [OBJECT_ID],
		})
	})
})
