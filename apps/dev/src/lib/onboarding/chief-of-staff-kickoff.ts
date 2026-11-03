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

/**
 * True in an E2E stack — the same `MASKIN_TEST_GRANT_TOKEN` seam
 * `probeClaudeSubscription` (`lib/claude-failover.ts`) already uses to detect
 * one. E2E specs provision a brand-new workspace per test, and every one of
 * those workspaces has no real Claude/LLM credentials — the kickoff session
 * this module's prompt is used for is fated to fail with
 * `LlmCredentialsUnavailableError` after still paying for a real session-row
 * insert and container/sandbox launch attempt. Across a shard's ~150
 * per-test workspaces that churn was enough contention (DB connections, CPU,
 * Docker) to slow down unrelated API calls on the same runner and blow the
 * shard's time budget — not just the Claude-subscription specs the probe
 * bypass targeted. Skip the kickoff outright in this environment rather than
 * let it fail loudly and slowly; production never sets this var.
 */
export function shouldSkipOnboardingKickoff(): boolean {
	return Boolean(process.env.MASKIN_TEST_GRANT_TOKEN)
}
