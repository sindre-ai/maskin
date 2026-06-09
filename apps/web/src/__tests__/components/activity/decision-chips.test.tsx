import { DecisionChips, hasDecisionChips } from '@/components/activity/decision-chips'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildEventResponse } from '../../factories'

const mockMutate = vi.fn()
let mockIsPending = false

vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: mockMutate, isPending: mockIsPending }),
}))

function chipEvent(chips: unknown, id = 42) {
	return buildEventResponse({
		id,
		action: 'commented',
		data: { content: 'Pick one', metadata: { chips } },
	})
}

describe('hasDecisionChips', () => {
	it('returns false for non-commented events', () => {
		const event = buildEventResponse({ action: 'created' })
		expect(hasDecisionChips(event)).toBe(false)
	})

	it('returns false when metadata has no chips', () => {
		const event = buildEventResponse({ action: 'commented', data: { content: 'hi' } })
		expect(hasDecisionChips(event)).toBe(false)
	})

	it('returns false when chips is an empty array', () => {
		expect(hasDecisionChips(chipEvent([]))).toBe(false)
	})

	it('returns true when chips array has string items', () => {
		expect(hasDecisionChips(chipEvent(['Yes', 'No']))).toBe(true)
	})
})

describe('DecisionChips', () => {
	const defaultProps = { workspaceId: 'ws-1', objectId: 'obj-1' }

	beforeEach(() => {
		mockMutate.mockReset()
		mockIsPending = false
	})

	it('renders nothing when chips metadata is absent', () => {
		const event = buildEventResponse({ action: 'commented', data: { content: 'hi' } })
		const { container } = render(<DecisionChips event={event} {...defaultProps} />)
		expect(container).toBeEmptyDOMElement()
	})

	it('renders nothing when chips is an empty array', () => {
		const { container } = render(<DecisionChips event={chipEvent([])} {...defaultProps} />)
		expect(container).toBeEmptyDOMElement()
	})

	it('renders chip buttons when chips are present', () => {
		render(<DecisionChips event={chipEvent(['Approve', 'Reject'])} {...defaultProps} />)
		expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
	})

	it('caps chips at 5 even when more are provided', () => {
		const event = chipEvent(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
		render(<DecisionChips event={event} {...defaultProps} />)
		const chipButtons = screen.getAllByRole('button').filter((b) => /^[A-E]$/.test(b.textContent ?? ''))
		expect(chipButtons).toHaveLength(5)
		expect(screen.queryByRole('button', { name: 'F' })).not.toBeInTheDocument()
	})

	it('truncates chip labels longer than 20 characters', () => {
		render(<DecisionChips event={chipEvent(['This label is way too long for a chip'])} {...defaultProps} />)
		expect(screen.getByRole('button', { name: 'This label is way to' })).toBeInTheDocument()
	})

	it('renders free-text input and Send button when chips are visible', () => {
		render(<DecisionChips event={chipEvent(['Yes'])} {...defaultProps} />)
		expect(screen.getByPlaceholderText(/type a reply/i)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument()
	})

	it('calls createComment.mutate with chip label and parent_event_id on chip click', async () => {
		const user = userEvent.setup()
		render(<DecisionChips event={chipEvent(['Approve'], 99)} {...defaultProps} />)
		await user.click(screen.getByRole('button', { name: 'Approve' }))
		expect(mockMutate).toHaveBeenCalledWith(
			{ entity_id: 'obj-1', content: 'Approve', parent_event_id: 99 },
			expect.objectContaining({ onSuccess: expect.any(Function) }),
		)
	})

	it('dismisses after successful chip selection', async () => {
		mockMutate.mockImplementation((_data: unknown, { onSuccess }: { onSuccess: () => void }) => onSuccess())
		const { container } = render(<DecisionChips event={chipEvent(['Approve'])} {...defaultProps} />)
		await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
		expect(container).toBeEmptyDOMElement()
	})

	it('submits free-text reply on form submit', async () => {
		const user = userEvent.setup()
		render(<DecisionChips event={chipEvent(['Yes'], 55)} {...defaultProps} />)
		await user.type(screen.getByPlaceholderText(/type a reply/i), 'custom answer')
		await user.click(screen.getByRole('button', { name: /send/i }))
		expect(mockMutate).toHaveBeenCalledWith(
			{ entity_id: 'obj-1', content: 'custom answer', parent_event_id: 55 },
			expect.objectContaining({ onSuccess: expect.any(Function) }),
		)
	})

	it('disables Send when free-text input is empty', () => {
		render(<DecisionChips event={chipEvent(['Yes'])} {...defaultProps} />)
		expect(screen.getByRole('button', { name: /send/i })).toBeDisabled()
	})

	it('disables chip buttons and input when isPending', () => {
		mockIsPending = true
		render(<DecisionChips event={chipEvent(['Yes'])} {...defaultProps} />)
		expect(screen.getByRole('button', { name: 'Yes' })).toBeDisabled()
		expect(screen.getByPlaceholderText(/type a reply/i)).toBeDisabled()
	})

	it('skips non-string chip values', () => {
		const event = chipEvent([123, null, 'Valid'])
		render(<DecisionChips event={event} {...defaultProps} />)
		expect(screen.getByRole('button', { name: 'Valid' })).toBeInTheDocument()
		// Valid chip + Send
		expect(screen.getAllByRole('button')).toHaveLength(2)
	})
})
