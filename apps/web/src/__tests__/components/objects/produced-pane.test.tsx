import { ProducedPane } from '@/components/objects/produced-pane'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@tanstack/react-router', () => ({
	Link: ({ children, ...props }: { children: React.ReactNode }) => (
		<span {...(props as Record<string, unknown>)}>{children}</span>
	),
}))

vi.mock('@/components/shared/object-reference', () => ({
	ObjectReference: ({ objectId }: { objectId: string }) => (
		<span data-testid="object-ref">{objectId}</span>
	),
}))

function renderPane(props: Partial<React.ComponentProps<typeof ProducedPane>> = {}) {
	const Wrapper = createWorkspaceWrapper()
	return render(
		<Wrapper>
			<ProducedPane
				workspaceId="ws-1"
				producedObjects={[]}
				producedFiles={[]}
				isLoading={false}
				{...props}
			/>
		</Wrapper>,
	)
}

describe('ProducedPane · states', () => {
	it('renders the empty state with the verbatim Designer copy when both counts are 0', () => {
		renderPane()
		expect(screen.getByText('Nothing produced yet')).toBeInTheDocument()
		expect(screen.getByText(/This chat hasn't spawned any sessions/i)).toBeInTheDocument()
	})

	it('shows skeleton placeholders while loading', () => {
		const { container } = renderPane({ isLoading: true })
		// Skeletons render as an unlabelled placeholder element — pick them by
		// their known height rather than by role (they have no role by design).
		const skeletons = container.querySelectorAll('.h-14')
		expect(skeletons.length).toBeGreaterThan(0)
	})

	it('renders both Objects and Files groups with their counts when both have items', () => {
		renderPane({
			producedObjects: [
				{ entityId: 'obj-a', entityType: 'bet', title: 'Bet A' },
				{ entityId: 'obj-b', entityType: 'task', title: 'Task B' },
			],
			producedFiles: [
				{ fileId: 'f-1', name: 'plan.md', mimeType: 'text/markdown', sizeBytes: 812 },
			],
		})
		expect(screen.getByText('Objects · 2')).toBeInTheDocument()
		expect(screen.getByText('Files · 1')).toBeInTheDocument()
		expect(screen.getByText('plan.md')).toBeInTheDocument()
	})

	it('omits the Files heading when files array is empty', () => {
		renderPane({
			producedObjects: [{ entityId: 'obj-a', entityType: 'bet', title: 'Bet A' }],
			producedFiles: [],
		})
		expect(screen.getByText('Objects · 1')).toBeInTheDocument()
		expect(screen.queryByText(/Files · 0/)).not.toBeInTheDocument()
	})

	it('omits the Objects heading when objects array is empty (files-only chat)', () => {
		renderPane({
			producedObjects: [],
			producedFiles: [
				{ fileId: 'f-1', name: 'notes.md', mimeType: 'text/markdown', sizeBytes: 42 },
			],
		})
		expect(screen.queryByText(/Objects · 0/)).not.toBeInTheDocument()
		expect(screen.getByText('Files · 1')).toBeInTheDocument()
	})

	it('shows the System-tracked footer verbatim', () => {
		renderPane()
		expect(screen.getByText('System-tracked · not editable')).toBeInTheDocument()
	})

	it('renders the close button only when onClose is passed (bottom-sheet variant)', async () => {
		const onClose = vi.fn()
		const user = userEvent.setup()
		renderPane({ onClose })
		const closeButton = screen.getByRole('button', { name: /Close Produced pane/i })
		await user.click(closeButton)
		expect(onClose).toHaveBeenCalledOnce()
	})

	it('does not render the close button on the right-rail variant (no onClose)', () => {
		renderPane()
		expect(screen.queryByRole('button', { name: /Close Produced pane/i })).not.toBeInTheDocument()
	})
})
