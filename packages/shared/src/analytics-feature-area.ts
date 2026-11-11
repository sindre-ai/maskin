/**
 * The product area an analytics event belongs to, sent as the `feature_area`
 * property. The values are the list on the "PostHog tracking plan: standard B2B
 * SaaS setup" page and are part of the contract the web, the server and the iPhone
 * app share: a new value or a rename splits every chart that groups by it.
 *
 * Property names the three surfaces agree on, on every event:
 *   workspace_id, actor_id, actor_type (human | agent | trigger | system),
 *   surface (web | backend | iphone), is_team (boolean), feature_area (below).
 * Person properties: signup_date, workspace_role, signup_source, is_team.
 * Group type `workspace`, group properties: created_at, member_count, agent_count,
 * integrations_connected_count, has_outside_member, is_team.
 * Never names, emails or message text.
 */
export const FEATURE_AREAS = [
	'chats',
	'for_you',
	'objects',
	'loops_triggers',
	'agents',
	'files_briefings',
	'integrations',
	'search',
	'voice',
	'billing',
	'settings',
] as const

export type FeatureArea = (typeof FEATURE_AREAS)[number]

// Exact names win over prefixes. Events with no product area (sign-up funnel,
// runtime and plumbing diagnostics, MCP traffic) are in neither and carry no
// feature_area, because the plan list has no value for them.
const EXACT: Record<string, FeatureArea> = {
	message_sent_tagged: 'chats',
	sindre_message_received: 'chats',
	sindre_message_sent: 'chats',
	foryou_card_action: 'for_you',
	mark_read_clicked: 'for_you',
	ask_banner_decide_clicked: 'for_you',
	object_updated: 'objects',
	object_created: 'objects',
	object_attached_file: 'objects',
	knowledge_object_created: 'objects',
	relationship_created: 'objects',
	comment_posted: 'objects',
	bulk_edit_commit: 'objects',
	task_created_invalid_initial_status: 'objects',
	agent_created: 'agents',
	agent_membership_added: 'agents',
	workspace_skill_attached: 'agents',
	workspace_skill_uploaded: 'agents',
	file_saved: 'files_briefings',
	editor_saved: 'files_briefings',
	mini_app_file_viewed: 'files_briefings',
	view_refreshed: 'files_briefings',
	files_display_property_toggled: 'files_briefings',
	change_review_opened: 'files_briefings',
	change_proposal_submitted: 'files_briefings',
	change_reviewed: 'files_briefings',
	unipile_webhook_received: 'integrations',
	command_palette_opened: 'search',
	live_call_started: 'voice',
	workspace_member_invited: 'settings',
	workspace_member_joined: 'settings',
	workspace_invite_revoked: 'settings',
}

// Checked in order, so the narrow prefix (agent_chat_) comes before the wide one (agent_).
const PREFIXES: ReadonlyArray<readonly [string, FeatureArea]> = [
	['chat_', 'chats'],
	['agent_chat_', 'chats'],
	['group_chat_', 'chats'],
	['foryou_', 'for_you'],
	['for_you_', 'for_you'],
	['handed_off_strip_', 'for_you'],
	['object_', 'objects'],
	['objects_', 'objects'],
	['bet_', 'objects'],
	['knowledge_', 'objects'],
	['loop_', 'loops_triggers'],
	['trigger_', 'loops_triggers'],
	['slack.trigger.', 'loops_triggers'],
	['agent_', 'agents'],
	['capability_', 'agents'],
	['workspace_skill_', 'agents'],
	['file_viewer_', 'files_briefings'],
	['editor_', 'files_briefings'],
	['briefing_', 'files_briefings'],
	['deck_', 'files_briefings'],
	['integration_', 'integrations'],
	['keychain_', 'integrations'],
	['extension_', 'integrations'],
	['drive_', 'integrations'],
	['slack.', 'integrations'],
	['slack_', 'integrations'],
	['search_', 'search'],
	['voice_', 'voice'],
	['checkout_', 'billing'],
	['trial_', 'billing'],
	['stripe_', 'billing'],
	['vies_', 'billing'],
]

/** The feature area of an event name, or undefined when the event has none. */
export function featureAreaForEvent(event: string): FeatureArea | undefined {
	const exact = EXACT[event]
	if (exact) return exact
	for (const [prefix, area] of PREFIXES) {
		if (event.startsWith(prefix)) return area
	}
	return undefined
}
