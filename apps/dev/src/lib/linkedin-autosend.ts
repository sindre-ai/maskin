// Shared helper for the Sales Rep loop's LinkedIn autosend path:
// buildLinkedinAutosendIdempotencyKey({ contactId, draftId }) is the single
// source of truth for the `{contact_id}:{draft_id}` format that
// `linkedin_send_message` expects on the autosend path (per parent bet spec §5).

export interface LinkedinAutosendIdempotencyKeyInput {
	contactId: string
	draftId: string
}

// `{contact_id}:{draft_id}` per parent bet spec §5. Trims whitespace but
// otherwise leaves the ids opaque; the format collides with nothing else the
// server treats as an idempotency key because everything else the loop hands
// to `linkedin_send_message` for the same (contact, draft) pair will hash
// through this helper. Throws on empty ids so a silently-empty key can't slip
// past the loop step's validation and land on the server as `":"`.
export function buildLinkedinAutosendIdempotencyKey({
	contactId,
	draftId,
}: LinkedinAutosendIdempotencyKeyInput): string {
	const contact = contactId.trim()
	const draft = draftId.trim()
	if (!contact)
		throw new Error('contactId is required to build the LinkedIn autosend idempotency key')
	if (!draft) throw new Error('draftId is required to build the LinkedIn autosend idempotency key')
	return `${contact}:${draft}`
}
