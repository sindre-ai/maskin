/**
 * Shared action prompt for the one-time Chief of Staff session kicked off
 * right after a brand-new workspace's owner actor is created. Hardcoded and
 * fired directly via `sessionManager.createSession()` at all three call
 * sites (`routes/workspaces.ts`, `services/workspace-bootstrap.ts`,
 * `lib/dev-bootstrap.ts`) rather than an `actor.created` event trigger —
 * actor creation doesn't emit an audit event, so that trigger can never fire
 * for this moment live.
 *
 * Explicitly names the `continuous-onboarding` skill (attached to Chief of
 * Staff by `CHIEF_OF_STAFF_DEFAULT.skills`) rather than re-describing its
 * steps here, so the skill stays the single source of truth for what the
 * welcome/kickoff/checklist arc actually does.
 */
export function buildChiefOfStaffKickoffPrompt(owner: {
	name?: string | null
	email?: string | null
}): string {
	const ownerName = owner.name ?? 'the workspace owner'
	const ownerEmail = owner.email ? ` (${owner.email})` : ''
	return `A human owner just joined this brand-new workspace: ${ownerName}${ownerEmail}. Run your \`continuous-onboarding\` skill now — it covers the welcome, the first-pass research kickoff, and the rest of the onboarding checklist.`
}
