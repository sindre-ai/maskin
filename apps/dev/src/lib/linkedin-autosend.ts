// Shared helpers for the Sales Rep loop's LinkedIn autosend gate.
// The flag itself lives in feature-flags.ts (SALES_REP_LINKEDIN_AUTOSEND);
// this module holds the two adjacent pieces the loop step needs on the
// on-flag path:
//
//   1. isSalesRepLinkedinAutosendEnabled(actorId) — the flag lookup, wrapped
//      so callers don't have to remember to pass the registry key.
//   2. buildLinkedinAutosendIdempotencyKey({ contactId, draftId }) — the
//      single source of truth for the `{contact_id}:{draft_id}` format that
//      `linkedin__send_message` expects on the autosend path (per parent
//      bet spec §5 + task acceptance criterion 5).
//
// Kept separate from feature-flags.ts so that shipping/retiring the autosend
// flag never sprawls across the shared flag file, and separate from the (not
// yet in this repo) linkedin__send_message tool handler so the caller — the
// loop step, wherever it eventually lands — has a stable, testable shim.

import { FLAGS, type FeatureFlagConfig, resolveFlags } from './feature-flags'

export function isSalesRepLinkedinAutosendEnabled(
	actorId: string,
	config: FeatureFlagConfig,
): boolean {
	return resolveFlags(actorId, config)[FLAGS.SALES_REP_LINKEDIN_AUTOSEND] === true
}

export interface LinkedinAutosendIdempotencyKeyInput {
	contactId: string
	draftId: string
}

// `{contact_id}:{draft_id}` per parent bet spec §5. Trims whitespace but
// otherwise leaves the ids opaque; the format collides with nothing else the
// server treats as an idempotency key because everything else the loop hands
// to `linkedin__send_message` for the same (contact, draft) pair will hash
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
