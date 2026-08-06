import { ObjectDocumentView } from '@/components/objects/object-document'
import { render, screen } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import { buildObjectResponse } from '../../factories'

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

// The knowledge doc-header chip reads live counts through `useKnowledgeReferences`.
// Mock the whole use-objects module here so the ObjectDocumentView tests below
// can drive chip visibility deterministically (0 → hidden, N>0 → visible).
const mockUseKnowledgeReferences = vi.fn()
mockUseKnowledgeReferences.mockReturnValue({ data: undefined })
vi.mock('@/hooks/use-objects', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-objects')>('@/hooks/use-objects')
	return {
		...actual,
		useKnowledgeReferences: (...args: unknown[]) => mockUseKnowledgeReferences(...args),
	}
})

beforeEach(() => {
	mockUseKnowledgeReferences.mockReturnValue({ data: undefined })
})

vi.mock('@/components/objects/loop-card', () => ({
	LoopCard: () => <div data-testid="loop-card" />,
}))

const baseProps = {
	workspaceId: 'ws-1',
	onUpdateTitle: vi.fn(),
	onUpdateContent: vi.fn(),
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

	it('does not render creator or timestamps in the header (moved to right sidebar)', () => {
		// Subscribe + created_by + created_at + updated_at all moved into the
		// right-side properties sidebar. `ObjectDocumentView` is the reading
		// path; those fields no longer appear here.
		const object = buildObjectResponse({
			createdAt: '2026-06-01T10:00:00.000Z',
			updatedAt: '2026-06-01T10:05:00.000Z',
		})
		const { container } = render(<ObjectDocumentView {...baseProps} object={object} />)
		expect(container.querySelectorAll('time').length).toBe(0)
		expect(container.textContent).not.toMatch(/updated \d/)
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

	describe('LoopCard wiring', () => {
		it('renders LoopCard when type is loop', () => {
			const object = buildObjectResponse({ type: 'loop', status: 'holding' })
			render(<ObjectDocumentView {...baseProps} object={object} />)
			expect(screen.getByTestId('loop-card')).toBeInTheDocument()
		})

		it('does not render LoopCard for other types', () => {
			const object = buildObjectResponse({ type: 'bet' })
			render(<ObjectDocumentView {...baseProps} object={object} />)
			expect(screen.queryByTestId('loop-card')).not.toBeInTheDocument()
		})
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

	describe('above-title header row order', () => {
		// The identity row above the <h1> textarea carries only TypeBadge and
		// the driver (OwnerSelect) — status and the bet-status chip moved to
		// the properties sidebar. This is the frame test — the per-viewport
		// fold assertion lives in the Playwright spec.
		it('renders TypeBadge and OwnerSelect above the title, without status controls', () => {
			const members = [
				{ actorId: 'actor-alice', role: 'owner', joinedAt: null, name: 'Alice', type: 'human' },
			]
			const object = buildObjectResponse({ type: 'bet', status: 'active' })
			const { container } = render(
				<ObjectDocumentView {...baseProps} object={object} members={members} />,
			)
			const textarea = container.querySelector('textarea')
			expect(textarea).not.toBeNull()
			if (!textarea) return
			const typeBadge = screen.getByText('bet')
			// Node.DOCUMENT_POSITION_FOLLOWING = 4 — bit set when `textarea`
			// follows `typeBadge` in DOM order.
			expect(typeBadge.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
				Node.DOCUMENT_POSITION_FOLLOWING,
			)
			expect(screen.getByRole('combobox')).toBeInTheDocument()
			expect(screen.queryAllByRole('combobox')).toHaveLength(1)
		})

		it('no longer renders SubscribeToggle, creator, or created/updated chips inline', () => {
			const object = buildObjectResponse({
				type: 'knowledge',
				createdAt: '2026-06-01T10:00:00.000Z',
				updatedAt: '2026-06-01T10:05:00.000Z',
			})
			const { container } = render(<ObjectDocumentView {...baseProps} object={object} />)
			expect(screen.queryByTestId('subscribe-toggle')).not.toBeInTheDocument()
			expect(container.querySelectorAll('time').length).toBe(0)
			expect(screen.queryByText(/Referenced by/)).not.toBeInTheDocument()
		})
	})
})
