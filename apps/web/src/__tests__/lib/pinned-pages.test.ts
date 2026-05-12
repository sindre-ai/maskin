import { ALL_PAGES, DEFAULT_PINNED_IDS, getPageById } from '@/lib/pinned-pages'

describe('pinned-pages', () => {
	it('includes tasks page in ALL_PAGES', () => {
		const tasks = ALL_PAGES.find((p) => p.id === 'tasks')
		expect(tasks).toBeDefined()
		expect(tasks?.label).toBe('Tasks')
		expect(tasks?.to).toBe('/$workspaceId/tasks')
	})

	it('includes tasks in DEFAULT_PINNED_IDS', () => {
		expect(DEFAULT_PINNED_IDS).toContain('tasks')
	})

	it('getPageById returns tasks page', () => {
		const page = getPageById('tasks')
		expect(page).toBeDefined()
		expect(page?.id).toBe('tasks')
	})

	it('tasks page is in workspace category', () => {
		const page = getPageById('tasks')
		expect(page?.category).toBe('workspace')
	})
})
