import {
	createViewChatLink,
	createViewMessage,
	createViewRequest,
	describeListFilters,
} from '@/lib/create-view-message'
import { defaultObjectsFilterModel } from '@/lib/objects-filter-model'

const agent = { id: 'agent-1', name: 'Design Studio' }

describe('createViewMessage', () => {
	it('names the type and the filters on the list page', () => {
		const filters = {
			...defaultObjectsFilterModel(),
			type: 'contact',
			status: 'active',
			metadata: { platform: 'linkedin' },
			q: 'acme',
		}
		const message = createViewMessage({ kind: 'list', filters })
		expect(message).toContain('the contact items')
		expect(message).toContain('status active, platform linkedin, search "acme"')
		expect(message).toContain('pinned_files')
		expect(message).not.toContain('set_loop_view')
	})

	it('says so when the list has no filters', () => {
		const message = createViewMessage({ kind: 'list', filters: defaultObjectsFilterModel() })
		expect(message).toContain('No filters are set on the list.')
		expect(message).toContain('the items in this workspace')
	})

	it('names the object on a detail page and pins to Favorites', () => {
		const message = createViewMessage({
			kind: 'object',
			id: 'obj-1',
			title: 'Big bet',
			type: 'bet',
		})
		expect(message).toContain('the bet "Big bet" (id obj-1)')
		expect(message).toContain('pinned_files')
		expect(message).not.toContain('set_loop_view')
	})

	it('names the flow on a flow page and pins it as a flow tab', () => {
		const message = createViewMessage({ kind: 'flow', id: 'loop-1', name: 'Weekly review' })
		expect(message).toContain('the flow "Weekly review" (id loop-1)')
		expect(message).toContain('set_loop_view (loop_id loop-1)')
		expect(message).not.toContain('pinned_files')
	})
})

describe('describeListFilters', () => {
	it('is empty when nothing is filtered', () => {
		expect(describeListFilters(defaultObjectsFilterModel())).toEqual([])
	})
})

describe('createViewChatLink', () => {
	it('opens New chat with Design Studio and the text filled in, attaching the object', () => {
		const link = createViewChatLink('ws-1', agent, {
			kind: 'object',
			id: 'obj-1',
			title: 'Big bet',
			type: 'bet',
		})
		expect(link.to).toBe('/$workspaceId/chats/new')
		expect(link.params).toEqual({ workspaceId: 'ws-1' })
		expect(link.search).toMatchObject({
			agentId: 'agent-1',
			agentName: 'Design Studio',
			objectId: 'obj-1',
			objectType: 'bet',
		})
		expect(link.search.text).toContain('Big bet')
	})

	it('attaches the flow as a loop and nothing for the list', () => {
		const flow = createViewChatLink('ws-1', agent, { kind: 'flow', id: 'loop-1', name: 'Weekly' })
		expect(flow.search).toMatchObject({ objectId: 'loop-1', objectType: 'loop' })
		const list = createViewChatLink('ws-1', agent, {
			kind: 'list',
			filters: defaultObjectsFilterModel(),
		})
		expect(list.search).not.toHaveProperty('objectId')
	})
})

describe('createViewRequest', () => {
	it('is undefined when the item should not show', () => {
		expect(createViewRequest(null, { id: 'o', title: 't', type: 'task' })).toBeUndefined()
	})

	it('opens with the object as the scope', () => {
		const open = vi.fn()
		createViewRequest(open, { id: 'o', title: null, type: 'task' })?.()
		expect(open).toHaveBeenCalledWith({ kind: 'object', id: 'o', title: 'Untitled', type: 'task' })
	})
})
