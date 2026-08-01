import {
	deriveEntryAgentRole,
	trackAgentCreated,
	trackAgentSessionCompleted,
	trackAgentSessionStarted,
	trackBetArchived,
	trackBetCreated,
	trackBetStatusChanged,
	trackChatImageUpload,
	trackChatSessionStarted,
	trackCommentPosted,
	trackEvent,
	trackForyouCardMarkedRead,
	trackForyouCardMarkedUnread,
	trackLoopGraduated,
	trackLoopViewed,
	trackNorthStarPromptImpression,
	trackNorthStarPromptResponse,
	trackObjectAttachedFile,
	trackObjectCreated,
	trackObjectsListArrived,
	trackObjectsListGroupToggled,
	trackRelationshipCreated,
	trackScrollToTop,
	trackSidebarAgentActivityExpanded,
	trackSidebarWorkspaceSwitcherOpened,
	trackSpecialistSummonedManually,
	trackTriggerCreated,
	trackTriggerFired,
} from '@/lib/analytics'
import { setStoredActor } from '@/lib/auth'
import { __setInitializedForTesting } from '@/lib/posthog'
import posthog from 'posthog-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
	localStorage.clear()
	vi.spyOn(console, 'info').mockImplementation(() => {})
})

afterEach(() => {
	__setInitializedForTesting(false)
	vi.restoreAllMocks()
})

describe('trackEvent', () => {
	it('always forwards to posthog.capture — even before posthog is initialised', () => {
		// Regression guard: prior versions silently dropped events when the
		// module-local `initialized` flag was false, which is exactly how the
		// north_star_prompt_impression / _response events were being lost in prod
		// (see task Instrument north_star_prompt_* on the For You onboarding
		// prompt bet). posthog-js is safe to call before init; do it anyway.
		const capture = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)

		trackEvent('objects_control_changed', { source: 'objects-page', control: 'status_filter' })

		expect(capture).toHaveBeenCalledTimes(1)
		expect(capture).toHaveBeenCalledWith('objects_control_changed', {
			source: 'objects-page',
			control: 'status_filter',
		})
	})

	it('also emits a console.info line tagged [analytics] when posthog is not initialised, for local dev diagnostics', () => {
		trackEvent('objects_control_changed', { source: 'objects-page', control: 'status_filter' })

		expect(console.info).toHaveBeenCalledTimes(1)
		const [tag, payload] = vi.mocked(console.info).mock.calls[0]
		expect(tag).toBe('[analytics]')
		expect(payload).toMatchObject({
			name: 'objects_control_changed',
			source: 'objects-page',
			control: 'status_filter',
			actorId: null,
		})
		expect(typeof (payload as { ts: string }).ts).toBe('string')
	})

	it('includes the stored actor id when authenticated', () => {
		setStoredActor({ id: 'actor-42', name: 'Sebastian', type: 'human', email: null })

		trackEvent('objects_control_changed', { control: 'sort_by' })

		const [, payload] = vi.mocked(console.info).mock.calls[0]
		expect((payload as { actorId: string | null }).actorId).toBe('actor-42')
	})

	it('never throws even if the actor lookup fails', () => {
		// Force localStorage.getItem to throw, simulating a broken environment
		const original = Storage.prototype.getItem
		Storage.prototype.getItem = () => {
			throw new Error('boom')
		}

		expect(() => trackEvent('objects_control_changed', {})).not.toThrow()

		Storage.prototype.getItem = original
	})

	it('routes through posthog.capture and skips the console fallback once posthog is initialised', () => {
		const capture = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)
		__setInitializedForTesting(true)

		trackEvent('objects_control_changed', { source: 'objects-page' })

		expect(capture).toHaveBeenCalledTimes(1)
		expect(capture).toHaveBeenCalledWith('objects_control_changed', { source: 'objects-page' })
		// The console fallback only fires when posthog isn't ready.
		expect(console.info).not.toHaveBeenCalled()
	})
})

describe('v1 taxonomy helpers', () => {
	function captureSpy() {
		__setInitializedForTesting(true)
		return vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)
	}

	it('bet_created carries the fixed property contract with web source', () => {
		const capture = captureSpy()

		trackBetCreated({ entity_id: 'bet-1', entity_type: 'bet' })

		expect(capture).toHaveBeenCalledWith('bet_created', {
			entity_id: 'bet-1',
			entity_type: 'bet',
			source: 'web',
			flow_id: null,
		})
	})

	it('bet_status_changed includes from/to alongside the property contract', () => {
		const capture = captureSpy()

		trackBetStatusChanged({
			entity_id: 'bet-1',
			entity_type: 'bet',
			from: 'define',
			to: 'active',
		})

		expect(capture).toHaveBeenCalledWith('bet_status_changed', {
			entity_id: 'bet-1',
			entity_type: 'bet',
			source: 'web',
			flow_id: null,
			from: 'define',
			to: 'active',
		})
	})

	it('bet_archived fires for bets only via its typed signature', () => {
		const capture = captureSpy()

		trackBetArchived({ entity_id: 'bet-9', entity_type: 'bet' })

		expect(capture).toHaveBeenCalledWith('bet_archived', expect.objectContaining({ source: 'web' }))
	})

	it('agent_session_* events use entity_type=session and carry outcome on completion', () => {
		const capture = captureSpy()

		trackAgentSessionStarted({ entity_id: 'sess-1', entity_type: 'session' })
		trackAgentSessionCompleted({
			entity_id: 'sess-1',
			entity_type: 'session',
			outcome: 'failed',
			flow_id: 'evt-77',
		})

		expect(capture).toHaveBeenNthCalledWith(
			1,
			'agent_session_started',
			expect.objectContaining({ entity_id: 'sess-1', entity_type: 'session' }),
		)
		expect(capture).toHaveBeenNthCalledWith(
			2,
			'agent_session_completed',
			expect.objectContaining({ outcome: 'failed', flow_id: 'evt-77' }),
		)
	})

	it('chat_session_started carries the entry point + entry_agent_role for the CoS bet', () => {
		const capture = captureSpy()

		trackChatSessionStarted({
			entity_id: 'sess-7',
			entity_type: 'session',
			entry_point: 'sindre_session',
			entry_agent_role: 'chief-of-staff',
		})
		trackChatSessionStarted({
			entity_id: 'sess-8',
			entity_type: 'session',
			entry_point: 'agent_one_shot',
			entry_agent_role: 'workspace-coach',
		})
		trackChatSessionStarted({
			entity_id: 'sess-9',
			entity_type: 'session',
			entry_point: 'sindre_session',
			entry_agent_role: null,
		})

		expect(capture).toHaveBeenNthCalledWith(1, 'chat_session_started', {
			entity_id: 'sess-7',
			entity_type: 'session',
			source: 'web',
			flow_id: null,
			entry_point: 'sindre_session',
			entry_agent_role: 'chief-of-staff',
		})
		expect(capture).toHaveBeenNthCalledWith(2, 'chat_session_started', {
			entity_id: 'sess-8',
			entity_type: 'session',
			source: 'web',
			flow_id: null,
			entry_point: 'agent_one_shot',
			entry_agent_role: 'workspace-coach',
		})
		expect(capture).toHaveBeenNthCalledWith(3, 'chat_session_started', {
			entity_id: 'sess-9',
			entity_type: 'session',
			source: 'web',
			flow_id: null,
			entry_point: 'sindre_session',
			entry_agent_role: null,
		})
	})

	it('specialist_summoned_manually names the picked agent and its kebab role', () => {
		const capture = captureSpy()

		trackSpecialistSummonedManually({
			entity_id: 'agent-42',
			entity_type: 'agent',
			agent_role: 'growth-strategist',
		})

		expect(capture).toHaveBeenCalledWith('specialist_summoned_manually', {
			entity_id: 'agent-42',
			entity_type: 'agent',
			source: 'web',
			flow_id: null,
			agent_role: 'growth-strategist',
		})
	})

	it('deriveEntryAgentRole kebab-cases actor names and squashes edge cases', () => {
		expect(deriveEntryAgentRole('Chief of Staff')).toBe('chief-of-staff')
		expect(deriveEntryAgentRole('Workspace Coach')).toBe('workspace-coach')
		expect(deriveEntryAgentRole('  Growth-Strategist  ')).toBe('growth-strategist')
		expect(deriveEntryAgentRole('Ops&Ledger')).toBe('ops-ledger')
		expect(deriveEntryAgentRole('')).toBeNull()
		expect(deriveEntryAgentRole('   ')).toBeNull()
		expect(deriveEntryAgentRole(null)).toBeNull()
		expect(deriveEntryAgentRole(undefined)).toBeNull()
	})

	it('comment_posted captures is_reply, attachment_count, and content', () => {
		const capture = captureSpy()

		trackCommentPosted({
			entity_id: 'task-1',
			entity_type: 'task',
			is_reply: true,
			attachment_count: 2,
			content: 'first line\nsecond line',
			flow_id: 'draft-99',
		})

		expect(capture).toHaveBeenCalledWith(
			'comment_posted',
			expect.objectContaining({
				entity_id: 'task-1',
				entity_type: 'task',
				is_reply: true,
				attachment_count: 2,
				content: 'first line\nsecond line',
				flow_id: 'draft-99',
			}),
		)
	})

	it('trigger_fired forces source=trigger', () => {
		const capture = captureSpy()

		trackTriggerFired({ entity_id: 'trg-1', entity_type: 'trigger' })

		expect(capture).toHaveBeenCalledWith(
			'trigger_fired',
			expect.objectContaining({ source: 'trigger', entity_type: 'trigger' }),
		)
	})

	it('relationship_created records the edge type as a custom prop', () => {
		const capture = captureSpy()

		trackRelationshipCreated({
			entity_id: 'rel-1',
			entity_type: 'relationship',
			relationship_type: 'informs',
		})

		expect(capture).toHaveBeenCalledWith(
			'relationship_created',
			expect.objectContaining({ relationship_type: 'informs' }),
		)
	})

	it('object_created carries object_subtype and the shared base contract', () => {
		const capture = captureSpy()

		trackObjectCreated({
			entity_id: 'obj-42',
			entity_type: 'object',
			object_subtype: 'bet',
		})

		expect(capture).toHaveBeenCalledWith(
			'object_created',
			expect.objectContaining({
				entity_id: 'obj-42',
				entity_type: 'object',
				object_subtype: 'bet',
				source: 'web',
			}),
		)
	})

	it('agent_created and trigger_created fire under their fixed entity types', () => {
		const capture = captureSpy()

		trackAgentCreated({ entity_id: 'agent-5', entity_type: 'agent' })
		trackTriggerCreated({ entity_id: 'trg-2', entity_type: 'trigger' })

		expect(capture).toHaveBeenNthCalledWith(
			1,
			'agent_created',
			expect.objectContaining({ entity_id: 'agent-5', entity_type: 'agent' }),
		)
		expect(capture).toHaveBeenNthCalledWith(
			2,
			'trigger_created',
			expect.objectContaining({ entity_id: 'trg-2', entity_type: 'trigger', source: 'web' }),
		)
	})

	it('object_attached_file carries file_id and parent entity type', () => {
		const capture = captureSpy()

		trackObjectAttachedFile({
			entity_id: 'bet-1',
			entity_type: 'bet',
			file_id: 'file-1',
			parent_entity_type: 'bet',
		})

		expect(capture).toHaveBeenCalledWith(
			'object_attached_file',
			expect.objectContaining({
				entity_id: 'bet-1',
				file_id: 'file-1',
				parent_entity_type: 'bet',
			}),
		)
	})

	it('sidebar.workspace_switcher.opened carries the workspaceId', () => {
		const capture = captureSpy()

		trackSidebarWorkspaceSwitcherOpened({ workspaceId: 'ws-42' })

		expect(capture).toHaveBeenCalledWith('sidebar.workspace_switcher.opened', {
			workspaceId: 'ws-42',
		})
	})

	it('sidebar.agent_activity.expanded carries the workspaceId', () => {
		const capture = captureSpy()

		trackSidebarAgentActivityExpanded({ workspaceId: 'ws-42' })

		expect(capture).toHaveBeenCalledWith('sidebar.agent_activity.expanded', {
			workspaceId: 'ws-42',
		})
	})

	it('north_star_prompt_impression fires with workspace_id via posthog.capture, bypassing the batch queue', () => {
		const capture = captureSpy()

		trackNorthStarPromptImpression({ workspace_id: 'ws-42' })

		expect(capture).toHaveBeenCalledWith(
			'north_star_prompt_impression',
			{ workspace_id: 'ws-42' },
			{ send_instantly: true },
		)
	})

	it('north_star_prompt_response fires with workspace_id via posthog.capture, bypassing the batch queue', () => {
		// send_instantly is load-bearing: without it, posthog-js batches events
		// for ~3s. The response event fires right before the card unmounts and
		// users typically tab away immediately, so the batched event never
		// reaches PostHog — that's why the event name was missing from the
		// project taxonomy after PR #1003. The impression event uses the same
		// flag for parity so the ratio isn't biased by asymmetric delivery.
		const capture = captureSpy()

		trackNorthStarPromptResponse({ workspace_id: 'ws-42' })

		expect(capture).toHaveBeenCalledWith(
			'north_star_prompt_response',
			{ workspace_id: 'ws-42' },
			{ send_instantly: true },
		)
	})

	it('scroll_to_top carries entity_id/entity_type/object_subtype so the correlation join runs without aliasing', () => {
		const capture = captureSpy()

		trackScrollToTop({
			entity_id: 'bet-42',
			entity_type: 'object',
			object_subtype: 'bet',
			scroll_depth_at_start_px: 1600,
			viewports_scrolled: 2,
		})

		expect(capture).toHaveBeenCalledWith('scroll_to_top', {
			entity_id: 'bet-42',
			entity_type: 'object',
			source: 'web',
			flow_id: null,
			object_subtype: 'bet',
			scroll_depth_at_start_px: 1600,
			viewports_scrolled: 2,
		})
	})

	it('loop_viewed carries entity_type=loop and the source_bet_id join key', () => {
		const capture = captureSpy()

		trackLoopViewed({
			entity_id: 'loop-1',
			entity_type: 'loop',
			source_bet_id: 'bet-99',
		})

		expect(capture).toHaveBeenCalledWith('loop_viewed', {
			entity_id: 'loop-1',
			entity_type: 'loop',
			source: 'web',
			flow_id: null,
			source_bet_id: 'bet-99',
		})
	})

	it('loop_viewed serialises a missing source_bet_id as null so the join key is always present', () => {
		const capture = captureSpy()

		trackLoopViewed({
			entity_id: 'loop-2',
			entity_type: 'loop',
			source_bet_id: null,
		})

		expect(capture).toHaveBeenCalledWith(
			'loop_viewed',
			expect.objectContaining({ entity_id: 'loop-2', source_bet_id: null }),
		)
	})

	it('objects_list_arrived carries nav_type and objectType for the bet denominator', () => {
		const capture = captureSpy()

		trackObjectsListArrived({ nav_type: 'back', objectType: 'bet' })

		expect(capture).toHaveBeenCalledWith('objects_list_arrived', {
			nav_type: 'back',
			objectType: 'bet',
		})
	})

	it('objects_list_arrived accepts direct and link for the always-emit path', () => {
		const capture = captureSpy()

		trackObjectsListArrived({ nav_type: 'direct', objectType: null })
		trackObjectsListArrived({ nav_type: 'link', objectType: 'task' })

		expect(capture).toHaveBeenNthCalledWith(1, 'objects_list_arrived', {
			nav_type: 'direct',
			objectType: null,
		})
		expect(capture).toHaveBeenNthCalledWith(2, 'objects_list_arrived', {
			nav_type: 'link',
			objectType: 'task',
		})
	})

	it('objects_list_group_toggled carries source, expanded, and objectType for the bet numerator', () => {
		const capture = captureSpy()

		trackObjectsListGroupToggled({ source: 'user', expanded: true, objectType: 'bet' })

		expect(capture).toHaveBeenCalledWith('objects_list_group_toggled', {
			source: 'user',
			expanded: true,
			objectType: 'bet',
		})
	})

	it('objects_list_group_toggled accepts the system source for restore wire-verification', () => {
		const capture = captureSpy()

		trackObjectsListGroupToggled({ source: 'system', expanded: false, objectType: null })

		expect(capture).toHaveBeenCalledWith('objects_list_group_toggled', {
			source: 'system',
			expanded: false,
			objectType: null,
		})
	})

	it('loop_graduated carries entity_type=loop and the source_bet_id join key', () => {
		const capture = captureSpy()

		trackLoopGraduated({
			entity_id: 'loop-3',
			entity_type: 'loop',
			source_bet_id: 'bet-77',
		})

		expect(capture).toHaveBeenCalledWith('loop_graduated', {
			entity_id: 'loop-3',
			entity_type: 'loop',
			source: 'web',
			flow_id: null,
			source_bet_id: 'bet-77',
		})
	})

	describe('foryou_card_marked_read / _unread', () => {
		const originalInnerWidth = window.innerWidth

		function setInnerWidth(value: number) {
			Object.defineProperty(window, 'innerWidth', { value, configurable: true, writable: true })
		}

		afterEach(() => {
			setInnerWidth(originalInnerWidth)
		})

		it('foryou_card_marked_read carries entity_type/entity_id/via, and mobile=true at ≤768px', () => {
			const capture = captureSpy()
			setInnerWidth(375)

			trackForyouCardMarkedRead({ entity_type: 'bet', entity_id: 'bet-1' })

			expect(capture).toHaveBeenCalledWith('foryou_card_marked_read', {
				entity_type: 'bet',
				entity_id: 'bet-1',
				mobile: true,
				via: 'swipe',
			})
		})

		it('foryou_card_marked_read reports mobile=false above 768px', () => {
			const capture = captureSpy()
			setInnerWidth(1024)

			trackForyouCardMarkedRead({ entity_type: 'insight', entity_id: 'ins-2' })

			expect(capture).toHaveBeenCalledWith(
				'foryou_card_marked_read',
				expect.objectContaining({ mobile: false, via: 'swipe' }),
			)
		})

		it('foryou_card_marked_read includes 768px in the mobile bucket (DoD boundary)', () => {
			const capture = captureSpy()
			setInnerWidth(768)

			trackForyouCardMarkedRead({ entity_type: 'bet', entity_id: 'bet-3' })

			expect(capture).toHaveBeenCalledWith(
				'foryou_card_marked_read',
				expect.objectContaining({ mobile: true }),
			)
		})

		it('foryou_card_marked_unread mirrors _read with the same property shape', () => {
			const capture = captureSpy()
			setInnerWidth(375)

			trackForyouCardMarkedUnread({ entity_type: 'task', entity_id: 'task-9' })

			expect(capture).toHaveBeenCalledWith('foryou_card_marked_unread', {
				entity_type: 'task',
				entity_id: 'task-9',
				mobile: true,
				via: 'swipe',
			})
		})
	})
})

describe('trackChatImageUpload', () => {
	const originalUserAgentDescriptor = Object.getOwnPropertyDescriptor(navigator, 'userAgent')
	const originalMaxTouchDescriptor = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')

	function setUserAgent(value: string) {
		Object.defineProperty(navigator, 'userAgent', { value, configurable: true })
	}

	function setMaxTouchPoints(value: number) {
		Object.defineProperty(navigator, 'maxTouchPoints', { value, configurable: true })
	}

	afterEach(() => {
		if (originalUserAgentDescriptor) {
			Object.defineProperty(navigator, 'userAgent', originalUserAgentDescriptor)
		}
		if (originalMaxTouchDescriptor) {
			Object.defineProperty(navigator, 'maxTouchPoints', originalMaxTouchDescriptor)
		}
	})

	function captureSpy() {
		__setInitializedForTesting(true)
		return vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)
	}

	it('emits platform=ios for an iPhone user-agent', () => {
		const capture = captureSpy()
		setUserAgent(
			'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
		)

		trackChatImageUpload({ outcome: 'success' })

		expect(capture).toHaveBeenCalledWith('chat_image_upload', {
			platform: 'ios',
			outcome: 'success',
		})
	})

	it('emits platform=ios for an iPadOS 13+ user-agent that masquerades as Macintosh', () => {
		const capture = captureSpy()
		setUserAgent(
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
		)
		setMaxTouchPoints(5)

		trackChatImageUpload({ outcome: 'failure' })

		expect(capture).toHaveBeenCalledWith('chat_image_upload', {
			platform: 'ios',
			outcome: 'failure',
		})
	})

	it('emits platform=web for desktop Chrome on Windows', () => {
		const capture = captureSpy()
		setUserAgent(
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
		)
		setMaxTouchPoints(0)

		trackChatImageUpload({ outcome: 'success' })

		expect(capture).toHaveBeenCalledWith('chat_image_upload', {
			platform: 'web',
			outcome: 'success',
		})
	})

	it('emits platform=web for Android Chrome (not conflated with iOS)', () => {
		const capture = captureSpy()
		setUserAgent(
			'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
		)
		setMaxTouchPoints(5)

		trackChatImageUpload({ outcome: 'success' })

		expect(capture).toHaveBeenCalledWith('chat_image_upload', {
			platform: 'web',
			outcome: 'success',
		})
	})
})
