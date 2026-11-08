import { messagePlanSchema, messageProposedEditSchema } from '@maskin/shared'
import { serialize } from './serialize'

/**
 * A chat message for the response: the usual serialization plus `plan` and `proposed_edit`
 * as typed fields when the metadata carries a block this server knows. A block that is
 * missing, malformed or in a version the server does not know is left out, so a message
 * without either returns neither field and the metadata is returned as it was stored.
 */
export function serializeMessage<T extends Record<string, unknown>>(record: T) {
	const base = serialize(record)
	const metadata = record.metadata
	if (!metadata || typeof metadata !== 'object') return base
	const { plan, proposed_edit: proposedEdit } = metadata as Record<string, unknown>
	const parsedPlan = plan === undefined ? null : messagePlanSchema.safeParse(plan)
	const parsedEdit =
		proposedEdit === undefined ? null : messageProposedEditSchema.safeParse(proposedEdit)
	return {
		...base,
		...(parsedPlan?.success ? { plan: parsedPlan.data } : {}),
		...(parsedEdit?.success ? { proposed_edit: parsedEdit.data } : {}),
	}
}
