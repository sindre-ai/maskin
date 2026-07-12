import { ObjectDocumentView } from '@/components/objects/object-document'
import { render, screen } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import { buildActorResponse, buildObjectResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>agent working</span>,
}))

vi.mock('@/components/shared/markdown-content', () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}))

vi.mock('@/components/activity/object-activity', () => ({
	ObjectActivity: () => <div data-testid="object-activity" />,
}))

vi.mock('@/components/shared/subscribe-toggle', () => ({
	SubscribeToggle: () => <div data-testid="subscribe-toggle" />,
}))

// The knowledge doc-header chip reads live counts through `useKnowledgeReferences`.
// Mock the whole use-objects module here so the ObjectDocumentView tests below
// can drive chip visibility deterministically (0 → hidden, N>0 → visible).
const mockUseKnowledgeReferences = vi.fn()
vi.mock('@/hooks/use-objects', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-objects')>('@/hooks/use-objects')
	return {
		...actual,
		useKnowledgeReferences: (...args: unknown[]) => mockUseKnowledgeReferences(...args),
	}
})

const baseProps = {
	workspaceId: 'ws-1',
	statuses: ['proposed', 'active', 'done'],
	onUpdateTitle: vi.fn(),
	onUpdateContent: vi.fn(),
	onUpdateStatus: vi.fn(),
	onUpdateDriver: vi.fn(),
	onDelete: vi.fn(),
}

describe('ObjectDocumentView', () => {
	it('renders title in textarea', () => {
		const object = buildObjectResponse({ title: 'My Bet' })
		render(<ObjectDocumentView {...baseProps} object={object} />)
		expect(screen.getByDisplayValue('My Bet')).toBeInTheDocument()
	})

	it('renders type badge', () => {
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDocumentView {...baseProps} object={object} />)
		expect(screen.getByText('bet')).toBeInTheDocument()
	})

	it('shows creator name and avatar when provided', () => {
		const object = buildObjectResponse()
		const creator = buildActorResponse({ name: 'Alice' })
		render(<ObjectDocumentView {...baseProps} object={object} creator={creator} />)
		expect(screen.getByText('Alice')).toBeInTheDocument()
	})

	it('wraps the provenance cluster on its own row below the sm breakpoint', () => {
		// Creator + createdAt must group into a sub-div with basis-full so
		// 375px never spills into a jagged partial wrap; sm:basis-auto lets
		// them flow inline again on wider phones.
		const object = buildObjectResponse()
		const creator = buildActorResponse({ name: 'Alice' })
		render(<ObjectDocumentView {...baseProps} object={object} creator={creator} />)
		const creatorLabel = screen.getByText('Alice')
		// creator span → provenance cluster (has basis-full sm:basis-auto)
		const cluster = creatorLabel.parentElement
		expect(cluster).not.toBeNull()
		expect(cluster?.className).toContain('basis-full')
		expect(cluster?.className).toContain('sm:basis-auto')
	})

	it('calls onUpdateTitle on blur when title changed', async () => {
		const user = userEvent.setup()
		const onUpdateTitle = vi.fn()
		const object = buildObjectResponse({ title: 'Original' })

		render(<ObjectDocumentView {...baseProps} object={object} onUpdateTitle={onUpdateTitle} />)

		const textarea = screen.getByDisplayValue('Original')
		await user.clear(textarea)
		await user.type(textarea, 'New Title')
		await user.tab()

		expect(onUpdateTitle).toHaveBeenCalledWith('New Title')
	})

	it('does not call onUpdateTitle on blur when title unchanged', async () => {
		const user = userEvent.setup()
		const onUpdateTitle = vi.fn()
		const object = buildObjectResponse({ title: 'Same' })

		render(<ObjectDocumentView {...baseProps} object={object} onUpdateTitle={onUpdateTitle} />)

		const textarea = screen.getByDisplayValue('Same')
		await user.click(textarea)
		await user.tab()

		expect(onUpdateTitle).not.toHaveBeenCalled()
	})

	it('updates displayed title when rerendered with a different object', () => {
		const objectA = buildObjectResponse({
			id: '11111111-1111-1111-1111-111111111111',
			title: 'Object A title',
		})
		const objectB = buildObjectResponse({
			id: '22222222-2222-2222-2222-222222222222',
			title: 'Object B title',
		})
		const { rerender } = render(<ObjectDocumentView {...baseProps} object={objectA} />)
		expect(screen.getByDisplayValue('Object A title')).toBeInTheDocument()
		rerender(<ObjectDocumentView {...baseProps} object={objectB} />)
		expect(screen.getByDisplayValue('Object B title')).toBeInTheDocument()
		expect(screen.queryByDisplayValue('Object A title')).not.toBeInTheDocument()
	})

	it('shows "Saved" indicator when showSaved is true', () => {
		const object = buildObjectResponse()
		render(<ObjectDocumentView {...baseProps} object={object} showSaved />)
		expect(screen.getByText('Saved')).toBeInTheDocument()
	})

	it('does not show "Saved" indicator by default', () => {
		const object = buildObjectResponse()
		render(<ObjectDocumentView {...baseProps} object={object} />)
		expect(screen.queryByText('Saved')).not.toBeInTheDocument()
	})

	it('does not render Properties, Files, or Linked Objects in the body', () => {
		const object = buildObjectResponse({ title: 'A bet' })
		render(<ObjectDocumentView {...baseProps} object={object} />)
		// AC-U5: the main reading path holds no property grid; properties + files
		// live in a right drawer (rendered by the parent ObjectDocument, not the View).
		// Linked objects are no longer here at all — they move into the timeline
		// in the sibling "Relationships into the timeline" task.
		expect(screen.queryByTestId('metadata-properties')).not.toBeInTheDocument()
		expect(screen.queryByTestId('object-files')).not.toBeInTheDocument()
		expect(screen.queryByTestId('linked-objects')).not.toBeInTheDocument()
	})

	it('shows AgentWorkingBadge when activeSessionId present', () => {
		const object = buildObjectResponse({ activeSessionId: 'session-1' })
		render(<ObjectDocumentView {...baseProps} object={object} />)
		expect(screen.getByText('agent working')).toBeInTheDocument()
	})

	it('does not show AgentWorkingBadge when no active session', () => {
		const object = buildObjectResponse({ activeSessionId: null })
		render(<ObjectDocumentView {...baseProps} object={object} />)
		expect(screen.queryByText('agent working')).not.toBeInTheDocument()
	})

	describe('updated chip', () => {
		it('renders an "updated" chip when updatedAt is materially after createdAt', () => {
			const createdAt = '2026-06-01T10:00:00.000Z'
			const updatedAt = '2026-06-01T10:05:00.000Z'
			const object = buildObjectResponse({ createdAt, updatedAt })
			const { container } = render(<ObjectDocumentView {...baseProps} object={object} />)
			const timeEls = container.querySelectorAll('time')
			expect(timeEls.length).toBe(2)
			expect(timeEls[0].getAttribute('datetime')).toBe(createdAt)
			expect(timeEls[1].getAttribute('datetime')).toBe(updatedAt)
			const chipParent = timeEls[1].parentElement
			expect(chipParent?.textContent?.startsWith('updated ')).toBe(true)
			expect(chipParent?.className).toContain('text-[11px]')
			expect(chipParent?.className).toContain('text-muted-foreground')
		})

		it('suppresses the updated chip when updatedAt is null', () => {
			const object = buildObjectResponse({
				createdAt: '2026-06-01T10:00:00.000Z',
				updatedAt: null,
			})
			const { container } = render(<ObjectDocumentView {...baseProps} object={object} />)
			expect(container.querySelectorAll('time').length).toBe(1)
			expect(container.textContent).not.toMatch(/updated \d/)
		})

		it('suppresses the updated chip when updatedAt − createdAt < 60s', () => {
			const object = buildObjectResponse({
				createdAt: '2026-06-01T10:00:00.000Z',
				updatedAt: '2026-06-01T10:00:30.000Z',
			})
			const { container } = render(<ObjectDocumentView {...baseProps} object={object} />)
			expect(container.querySelectorAll('time').length).toBe(1)
		})

		it('renders the chip when createdAt is null but updatedAt is present', () => {
			const updatedAt = '2026-06-01T10:00:00.000Z'
			const object = buildObjectResponse({ createdAt: null, updatedAt })
			const { container } = render(<ObjectDocumentView {...baseProps} object={object} />)
			const timeEls = container.querySelectorAll('time')
			expect(timeEls.length).toBe(1)
			expect(timeEls[0].getAttribute('datetime')).toBe(updatedAt)
		})
	})

	describe('OwnerSelect', () => {
		const members = [
			{ actorId: 'actor-alice', role: 'owner', joinedAt: null, name: 'Alice', type: 'human' },
			{ actorId: 'actor-bot', role: 'member', joinedAt: null, name: 'Bot', type: 'agent' },
		]

		it('does not render owner select when members are not provided', () => {
			const object = buildObjectResponse({ driver: null })
			render(<ObjectDocumentView {...baseProps} object={object} />)
			expect(screen.queryByText('Unassigned')).not.toBeInTheDocument()
		})

		it('shows "Unassigned" when owner is null', () => {
			const object = buildObjectResponse({ driver: null })
			render(<ObjectDocumentView {...baseProps} object={object} members={members} />)
			expect(screen.getByText('Driver: Unassigned')).toBeInTheDocument()
		})

		it('shows owner name when owner is a current member', () => {
			const object = buildObjectResponse({ driver: 'actor-alice' })
			render(<ObjectDocumentView {...baseProps} object={object} members={members} />)
			expect(screen.getByText('Alice')).toBeInTheDocument()
		})

		it('shows "Unknown" fallback when owner is set but not in members', () => {
			const object = buildObjectResponse({ driver: 'actor-removed-12345678-abcd' })
			render(<ObjectDocumentView {...baseProps} object={object} members={members} />)
			expect(screen.getByText(/Unknown \(actor-re\)/)).toBeInTheDocument()
		})

		it('calls onUpdateDriver with actor id when selecting a member', async () => {
			const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
			const onUpdateDriver = vi.fn()
			const object = buildObjectResponse({ driver: null })
			render(
				<ObjectDocumentView
					{...baseProps}
					object={object}
					members={members}
					onUpdateDriver={onUpdateDriver}
				/>,
			)

			const triggers = screen.getAllByRole('combobox')
			await user.click(triggers[triggers.length - 1])
			await user.click(screen.getByRole('option', { name: /Alice/ }))

			expect(onUpdateDriver).toHaveBeenCalledWith('actor-alice')
		})

		it('calls onUpdateDriver with null when selecting "Unassigned"', async () => {
			const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
			const onUpdateDriver = vi.fn()
			const object = buildObjectResponse({ driver: 'actor-alice' })
			render(
				<ObjectDocumentView
					{...baseProps}
					object={object}
					members={members}
					onUpdateDriver={onUpdateDriver}
				/>,
			)

			const triggers = screen.getAllByRole('combobox')
			await user.click(triggers[triggers.length - 1])
			await user.click(screen.getByRole('option', { name: /Unassigned/ }))

			expect(onUpdateDriver).toHaveBeenCalledWith(null)
		})
	})

	describe('Referenced-by-N-contexts chip on knowledge headers', () => {
		beforeEach(() => {
			mockUseKnowledgeReferences.mockReset()
		})

		it('renders the chip on knowledge objects when count > 0', () => {
			mockUseKnowledgeReferences.mockReturnValue({
				data: { window_days: 7, unique_contexts: 3 },
			})
			const object = buildObjectResponse({ type: 'knowledge', title: 'About Maskin' })
			render(<ObjectDocumentView {...baseProps} object={object} />)
			expect(screen.getByText('Referenced by 3 contexts/week')).toBeInTheDocument()
		})

		it('singularises the label at count === 1', () => {
			mockUseKnowledgeReferences.mockReturnValue({
				data: { window_days: 7, unique_contexts: 1 },
			})
			const object = buildObjectResponse({ type: 'knowledge' })
			render(<ObjectDocumentView {...baseProps} object={object} />)
			expect(screen.getByText('Referenced by 1 context/week')).toBeInTheDocument()
		})

		it('hides the chip when count is 0 (empty state stays invisible)', () => {
			mockUseKnowledgeReferences.mockReturnValue({
				data: { window_days: 7, unique_contexts: 0 },
			})
			const object = buildObjectResponse({ type: 'knowledge' })
			render(<ObjectDocumentView {...baseProps} object={object} />)
			expect(screen.queryByText(/Referenced by/)).not.toBeInTheDocument()
		})

		it('hides the chip while the count is still loading (no data yet)', () => {
			mockUseKnowledgeReferences.mockReturnValue({ data: undefined })
			const object = buildObjectResponse({ type: 'knowledge' })
			render(<ObjectDocumentView {...baseProps} object={object} />)
			expect(screen.queryByText(/Referenced by/)).not.toBeInTheDocument()
		})

		it('does not render on non-knowledge object types', () => {
			mockUseKnowledgeReferences.mockReturnValue({
				data: { window_days: 7, unique_contexts: 9 },
			})
			const object = buildObjectResponse({ type: 'bet' })
			render(<ObjectDocumentView {...baseProps} object={object} />)
			// The chip is not rendered on bets even though the hook would
			// return a positive count — the header prov row must stay
			// knowledge-only. The chip's own render guard is a safety net.
			expect(screen.queryByText(/Referenced by/)).not.toBeInTheDocument()
		})
	})
})
