// Copy strings for the Slack trigger setup UX, keyed by the raw Slack error
// code we persist in `triggers.metadata.slack_setup.join_attempts[i].error`
// (or the derived per-channel status). Kept as a frontend constants file so
// wording can be iterated without a backend release — the service records only
// the raw code (see spec §3).
//
// `#{channelName}` and `{slack_error}` are placeholders — resolve them at
// render time via the picker's `useSlackConversations` and the stored error.

import type { SlackSetupJoinStatus } from '@maskin/shared'

export interface SlackSetupCopyContext {
	/** Bot's name of the channel — used in the `#{channelName}` placeholder. */
	channelName: string
	/** Raw Slack error code, populated when status is `'error'`. */
	slackError?: string
}

/** Render a copy string for a given per-channel join outcome. Order matches
 *  the spec's failure-copy mapping table (Architect §3). All-good statuses
 *  (`'joined'`, `'already_in'`) are handled by the caller — they render the
 *  banner as null; this helper is only called for the failure statuses. */
export function slackSetupCopyForStatus(
	status: SlackSetupJoinStatus,
	ctx: SlackSetupCopyContext,
): string {
	const channel = `#${ctx.channelName}`
	switch (status) {
		case 'not_public':
			return `Private channel — Slack won't let Maskin auto-join. In Slack: /invite @Maskin ${channel}, then reopen this trigger.`
		case 'channel_not_found':
			return 'Channel not found — it may have been archived or renamed. Edit the trigger to pick a current channel.'
		case 'not_authed':
			return 'Reconnect Slack from Settings → Integrations — Maskin lost authorization for this workspace.'
		case 'restricted_action':
			return `Slack workspace policy blocks Maskin from auto-joining ${channel}. Ask a workspace admin, or /invite @Maskin manually.`
		case 'error':
			return `Couldn't verify ${channel}: ${ctx.slackError ?? 'unknown error'}. Reload to retry.`
		case 'joined':
		case 'already_in':
			// Success rows aren't rendered as banner copy — the banner returns null
			// when every channel is in one of these states. Keeping the branch here
			// exhaustively so a future non-success status added to the union
			// forces this switch to update.
			return ''
	}
}

/** Post-runtime `not_in_channel` copy — not persisted in `join_attempts` (it
 *  fires after save, when the trigger runner tries to post), so it has no
 *  status-mapped switch case. Exposed as a named helper so the (future) runtime
 *  banner and any future integration audit page can share it. */
export function slackNotInChannelCopy(channelName: string): string {
	return `Maskin isn't a member of #${channelName} — reinvite the app or edit the trigger to remove this channel.`
}

/** Copy for the auto-paused banner (state (1) in spec §6). PR C (Task 3) is
 *  the surface that renders this — the string lives here so B, C, and any
 *  audit page all share one source of truth. */
export function slackMemberLeftCopy(channelName: string): string {
	return `Auto-paused — Maskin was removed from #${channelName}. Reinvite the app in Slack, then resume the trigger.`
}
