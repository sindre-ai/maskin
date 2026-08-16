import { AskPanel } from '@/components/asks/ask-panel'
import type { ActorListItem, NotificationResponse } from '@/lib/api'
import { fireEvent, render, screen } from '@testing-library/react'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_AGENT_ID = '22222222-2222-4222-8222-222222222222'

function buildActor(id: string, name: string): ActorListItem {
	return {
		id,
		type: 'agent',
		name,
		email: null,
		description: null,
		isSystem: false,
		agentState: {},
	} as ActorListItem
}

function buildAsk(overrides: Partial<NotificationResponse> = {}): NotificationResponse {
	return {
		id: '33333333-3333-4333-8333-333333333333',
		workspaceId: '44444444-4444-4444-8444-444444444444',
		type: 'needs_input',
		title: 'Approve the direction',
		content: 'Can you sign off on this approach?',
		metadata: null,
		sourceActorId: AGENT_ID,
		targetActorId: null,
		objectId: '55555555-5555-4555-8555-555555555555',
		sessionId: null,
		status: 'pending',
		resolvedAt: null,
		createdAt: '2026-08-12T00:00:00.000Z',
		updatedAt: '2026-08-12T00:00:00.000Z',
		...overrides,
	}
}

const actorsById = new Map([
	[AGENT_ID, buildActor(AGENT_ID, 'Framer Agent')],
	[OTHER_AGENT_ID, buildActor(OTHER_AGENT_ID, 'Strategist Agent')],
])

function renderPanel(asks: NotificationResponse[], onRespond = vi.fn()) {
	return render(
		<AskPanel
			open
			onOpenChange={vi.fn()}
			title="Asks"
			subtitle="2 agents waiting"
			asks={asks}
			actorsById={actorsById}
			onRespond={onRespond}
		/>,
	)
}

describe('AskPanel', () => {
	it('renders pending asks with agent name, ask text, and Approve/Hold buttons', () => {
		renderPanel([buildAsk()])

		expect(screen.getByText('Framer Agent')).toBeInTheDocument()
		expect(screen.getByText('Can you sign off on this approach?')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Approve/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Hold/ })).toBeInTheDocument()
	})

	it('shows an Approved done label for an already-resolved approve ask', () => {
		renderPanel([
			buildAsk({
				status: 'resolved',
				resolvedAt: '2026-08-12T01:00:00.000Z',
				metadata: { response: 'approve' },
			}),
		])

		expect(screen.getByText('Approved')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument()
	})

	it('shows a Held done label for a resolved hold ask', () => {
		renderPanel([
			buildAsk({
				status: 'resolved',
				resolvedAt: '2026-08-12T01:00:00.000Z',
				metadata: { response: 'hold' },
			}),
		])

		expect(screen.getByText('Held')).toBeInTheDocument()
	})

	it('calls onRespond with approve when Approve is clicked and flips to a done label', () => {
		const onRespond = vi.fn()
		renderPanel([buildAsk()], onRespond)

		fireEvent.click(screen.getByRole('button', { name: /Approve/ }))

		expect(onRespond).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333', 'approve')
		expect(screen.getByText('Approved')).toBeInTheDocument()
	})

	it('calls onRespond with hold when Hold is clicked', () => {
		const onRespond = vi.fn()
		renderPanel([buildAsk()], onRespond)

		fireEvent.click(screen.getByRole('button', { name: /Hold/ }))

		expect(onRespond).toHaveBeenCalledWith('33333333-3333-4333-8333-333333333333', 'hold')
		expect(screen.getByText('Held')).toBeInTheDocument()
	})

	it('shows an Approve all button only when more than one ask is pending', () => {
		renderPanel([buildAsk({ id: 'a-1' }), buildAsk({ id: 'a-2', sourceActorId: OTHER_AGENT_ID })])

		const approveAll = screen.getByRole('button', { name: 'Approve all 2' })
		expect(approveAll).toBeInTheDocument()
	})

	it('does not show an Approve all button for a single pending ask', () => {
		renderPanel([buildAsk()])

		expect(screen.queryByRole('button', { name: /Approve all/ })).not.toBeInTheDocument()
	})

	it('approve-all responds approve for every pending ask', () => {
		const onRespond = vi.fn()
		renderPanel(
			[buildAsk({ id: 'a-1' }), buildAsk({ id: 'a-2', sourceActorId: OTHER_AGENT_ID })],
			onRespond,
		)

		fireEvent.click(screen.getByRole('button', { name: 'Approve all 2' }))

		expect(onRespond).toHaveBeenCalledTimes(2)
		expect(onRespond).toHaveBeenCalledWith('a-1', 'approve')
		expect(onRespond).toHaveBeenCalledWith('a-2', 'approve')
	})

	it('shows the nothing-left-waiting note when there are no pending asks', () => {
		renderPanel([
			buildAsk({
				id: 'a-1',
				status: 'resolved',
				metadata: { response: 'approve' },
			}),
		])

		expect(screen.getByText('Nothing left waiting here')).toBeInTheDocument()
	})

	it('renders an empty state when there are no asks at all', () => {
		renderPanel([])

		expect(screen.getByText('Nothing waiting here')).toBeInTheDocument()
	})
})
