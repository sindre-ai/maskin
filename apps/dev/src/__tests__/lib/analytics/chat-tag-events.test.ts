import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	resolveChatTagClient,
	tagsAreInText,
	trackMessageEditedWithTags,
	trackMessageSentTagged,
} from '../../../lib/analytics/chat-tag-events'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

describe('resolveChatTagClient', () => {
	it('tells the web UI from the iOS app and files everything else as other', () => {
		expect(resolveChatTagClient('ui')).toBe('web')
		expect(resolveChatTagClient('ios')).toBe('ios')
		expect(resolveChatTagClient(' IOS ')).toBe('ios')
		expect(resolveChatTagClient('mcp')).toBe('other')
		expect(resolveChatTagClient('something-typed-by-a-caller')).toBe('other')
		expect(resolveChatTagClient(undefined)).toBe('other')
	})
})

describe('tagsAreInText', () => {
	it('is true when every tagged name appears as @name, ignoring case', () => {
		expect(tagsAreInText('ask @cto and @Developer to start', ['CTO', 'Developer'])).toBe(true)
	})

	it('is false when a name is missing from the text, as with the old pill row', () => {
		expect(tagsAreInText('please start', ['CTO'])).toBe(false)
		expect(tagsAreInText('ask @CTO, not Developer', ['CTO', 'Developer'])).toBe(false)
	})

	it('is false with no tagged names', () => {
		expect(tagsAreInText('hello', [])).toBe(false)
	})
})

describe('trackMessageEditedWithTags', () => {
	it('sends the added count and the client', async () => {
		await trackMessageEditedWithTags({
			workspaceId: 'ws',
			actorId: 'actor',
			conversationId: 'conv',
			client: 'web',
			addedCount: 2,
		})
		expect(capturePosthogEventMock).toHaveBeenCalledWith('message_edited_with_tags', 'actor', {
			workspace_id: 'ws',
			conversation_id: 'conv',
			added_count: 2,
			client: 'web',
		})
	})
})

describe('trackMessageSentTagged', () => {
	it('sends the in-text flag and the client', async () => {
		const db = {
			select: () => ({ from: () => ({ where: async () => [{ name: 'CTO' }] }) }),
		}
		await trackMessageSentTagged(db as never, {
			workspaceId: 'ws',
			actorId: 'actor',
			conversationId: 'conv',
			client: 'ios',
			content: 'ask @CTO to start',
			taggedIds: ['id-1'],
		})
		expect(capturePosthogEventMock).toHaveBeenCalledWith('message_sent_tagged', 'actor', {
			workspace_id: 'ws',
			conversation_id: 'conv',
			tag_in_text: true,
			client: 'ios',
		})
	})

	it('still resolves when the name lookup fails', async () => {
		const db = {
			select: () => ({
				from: () => ({
					where: async () => {
						throw new Error('db down')
					},
				}),
			}),
		}
		await expect(
			trackMessageSentTagged(db as never, {
				workspaceId: 'ws',
				actorId: 'actor',
				conversationId: 'conv',
				client: 'web',
				content: 'x',
				taggedIds: ['id-1'],
			}),
		).resolves.toBeUndefined()
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})
})
