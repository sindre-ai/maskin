import { ObjectCreateForm } from '@/components/objects/object-create-form'
import { render, screen } from '@testing-library/react'

const mockGetTabs = vi.fn()

vi.mock('@/hooks/use-enabled-modules', () => ({
	useEnabledModules: () => [],
}))

vi.mock('@ai-native/module-sdk', () => ({
	getEnabledObjectTypeTabs: () => mockGetTabs(),
}))

vi.mock('@/components/shared/markdown-content', () => ({
	MarkdownContent: () => <div data-testid="markdown-content" />,
}))

vi.mock('@/components/objects/metadata-properties', () => ({
	MetadataProperties: () => <div data-testid="metadata-properties" />,
}))

vi.mock('@/components/objects/linked-objects', () => ({
	LinkedObjects: () => <div data-testid="linked-objects" />,
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspaceId: 'ws-1',
		workspace: { id: 'ws-1', settings: {} },
	}),
}))

vi.mock('@/hooks/use-objects', () => ({
	useObjects: () => ({ data: [] }),
	useUpdateObject: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-relationships', () => ({
	useCreateRelationship: () => ({ mutate: vi.fn() }),
	useDeleteRelationship: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useUpdateWorkspace: () => ({ mutate: vi.fn() }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

describe('ObjectCreateForm', () => {
	it('shows empty state when no available types', () => {
		mockGetTabs.mockReturnValue([])
		render(<ObjectCreateForm objectId="new-1" onAutoCreate={vi.fn()} />)
		expect(screen.getByText('No object types available')).toBeInTheDocument()
	})

	it('shows creating indicator when isPending', () => {
		mockGetTabs.mockReturnValue([{ label: 'Bet', value: 'bet' }])
		render(<ObjectCreateForm objectId="new-1" onAutoCreate={vi.fn()} isPending />)
		expect(screen.getByText('Creating...')).toBeInTheDocument()
	})

	it('shows error message when error provided', () => {
		mockGetTabs.mockReturnValue([{ label: 'Bet', value: 'bet' }])
		render(
			<ObjectCreateForm
				objectId="new-1"
				onAutoCreate={vi.fn()}
				error={new Error('Validation failed')}
			/>,
		)
		expect(screen.getByText('Validation failed')).toBeInTheDocument()
	})

	it('renders title textarea', () => {
		mockGetTabs.mockReturnValue([{ label: 'Bet', value: 'bet' }])
		render(<ObjectCreateForm objectId="new-1" onAutoCreate={vi.fn()} />)
		expect(screen.getByPlaceholderText('Untitled')).toBeInTheDocument()
	})

	it('renders type selector buttons', () => {
		mockGetTabs.mockReturnValue([
			{ label: 'Bet', value: 'bet' },
			{ label: 'Task', value: 'task' },
		])
		render(<ObjectCreateForm objectId="new-1" onAutoCreate={vi.fn()} />)
		expect(screen.getByRole('button', { name: 'Bet' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Task' })).toBeInTheDocument()
	})
})
