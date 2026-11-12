import { describe, expect, it } from 'vitest'
import { FEATURE_AREAS, featureAreaForEvent } from '../analytics-feature-area'

describe('featureAreaForEvent', () => {
	it.each([
		['chat_session_started', 'chats'],
		['chat_reply_posted', 'chats'],
		['turn_sent_back', 'chats'],
		['turn_check_cap_hit', 'chats'],
		['agent_chat_started_message', 'chats'],
		['foryou_card_shown', 'for_you'],
		['foryou_card_action', 'for_you'],
		['object_updated', 'objects'],
		['bet_status_changed', 'objects'],
		['knowledge_page_viewed', 'objects'],
		['loop_installed', 'loops_triggers'],
		['trigger_updated', 'loops_triggers'],
		['agent_created', 'agents'],
		['agent_session_started', 'agents'],
		['workspace_skill_uploaded', 'agents'],
		['file_saved', 'files_briefings'],
		['file_viewer_page_navigated', 'files_briefings'],
		['integration_connected', 'integrations'],
		['keychain_credential_created', 'integrations'],
		['slack.message.posted', 'integrations'],
		['search_performed', 'search'],
		['command_palette_opened', 'search'],
		['voice_session_started', 'voice'],
		['checkout_session_completed', 'billing'],
		['workspace_member_joined', 'settings'],
	])('puts %s in %s', (event, area) => {
		expect(featureAreaForEvent(event)).toBe(area)
	})

	it('keeps the narrow agent_chat_ prefix ahead of agent_', () => {
		expect(featureAreaForEvent('agent_chat_message_refused')).toBe('chats')
		expect(featureAreaForEvent('agent_comment_posted')).toBe('agents')
	})

	it('leaves events with no product area without one', () => {
		for (const event of ['$pageview', 'signup_completed', 'workspace_created', 'mcp_tool_call']) {
			expect(featureAreaForEvent(event)).toBeUndefined()
		}
	})

	it('only ever returns a value from the plan list', () => {
		for (const event of ['chat_x', 'foryou_x', 'trigger_x', 'drive_x', 'stripe_x', 'voice_x']) {
			expect(FEATURE_AREAS).toContain(featureAreaForEvent(event))
		}
	})
})
