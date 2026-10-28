import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Actor = {
	id: string
	name: string
	type: string
	description: string | null
	isSystem: boolean
	skills?: string[]
	avatar_url?: string | null
}
type Session = {
	actorId: string
	status: string
	createdAt: string
	updatedAt: string
}

let actors: Actor[] | undefined
let sessions: Session[] | undefined
let sessionsLoading = false

vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: actors }) }))
vi.mock('@/hooks/use-sessions', () => ({
	useWorkspaceSessions: () => ({ data: sessions, isLoading: sessionsLoading }),
}))
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		className,
		...rest
	}: { children: React.ReactNode; className?: string } & Record<string, unknown>) => (
		<a
			href="/x"
			className={className}
			aria-label={rest['aria-label'] as string | undefined}
			data-linked-card={rest['data-linked-card'] as string | undefined}
		>
			{children}
		</a>
	),
}))

import { AgentReferenceCard, AgentReferenceChip } from '@/components/chat/linked-object-reference'

const WS = 'ws-1'
const AGENT_ID = 'dc2ee1b4-5659-4038-be88-0a1b298ba373'
const fallback = <a href="/original">the original link</a>
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()

function agentRow(overrides: Partial<Actor> = {}): Actor {
	return {
		id: AGENT_ID,
		name: 'Developer',
		type: 'agent',
		description: 'Builds and ships the code.',
		isSystem: false,
		...overrides,
	}
}

function session(status: string, overrides: Partial<Session> = {}): Session {
	return {
		actorId: AGENT_ID,
		status,
		createdAt: hoursAgo(3),
		updatedAt: hoursAgo(2),
		...overrides,
	}
}

beforeEach(() => {
	actors = [agentRow()]
	sessions = []
	sessionsLoading = false
})

describe('AgentReferenceCard', () => {
	const renderCard = (preview = false) =>
		render(<AgentReferenceCard workspaceId={WS} agentId={AGENT_ID} preview={preview} />)

	it('shows tile, eyebrow, Working now, name, description, last active and the footer', () => {
		sessions = [session('running')]
		renderCard()
		const eyebrow = screen.getByText('Agent')
		expect(eyebrow).toHaveClass('eyebrow')
		expect(eyebrow.previousElementSibling?.className).toContain('bg-secondary')
		expect(screen.getByText('Working now')).toBeInTheDocument()
		expect(screen.queryByText('Idle')).not.toBeInTheDocument()
		expect(screen.getAllByText('Developer').length).toBeGreaterThan(0)
		expect(screen.getByText('Builds and ships the code.')).toBeInTheDocument()
		expect(screen.getByText('Last active')).toBeInTheDocument()
		expect(document.querySelector('[data-linked-card]')).not.toBeNull()
	})

	it('reads Idle for an agent with no active session, with the time of its newest session', () => {
		sessions = [
			session('completed', { createdAt: hoursAgo(30), updatedAt: hoursAgo(29) }),
			session('completed', { createdAt: hoursAgo(5), updatedAt: hoursAgo(4) }),
		]
		renderCard()
		expect(screen.getByText('Idle')).toBeInTheDocument()
		expect(screen.queryByText('Working now')).not.toBeInTheDocument()
		expect(screen.getAllByText('4h ago')).toHaveLength(2)
	})

	it('only counts sessions of this agent as working', () => {
		sessions = [session('running', { actorId: 'someone-else' })]
		renderCard()
		expect(screen.getByText('Idle')).toBeInTheDocument()
		expect(screen.queryByText('Last active')).not.toBeInTheDocument()
	})

	it('leaves Last active out when no session is on the list, and never says Never active', () => {
		const { container } = renderCard()
		expect(screen.queryByText('Last active')).not.toBeInTheDocument()
		expect(container.textContent).not.toMatch(/last active|never/i)
	})

	it('leaves the description out when there is none', () => {
		actors = [agentRow({ description: null })]
		renderCard()
		expect(screen.queryByText('Builds and ships the code.')).not.toBeInTheDocument()
		expect(screen.getByText('Idle')).toBeInTheDocument()
	})

	it('shows a retired agent with its description as written', () => {
		actors = [agentRow({ description: 'RETIRED. Replaced by the Strategist.' })]
		renderCard()
		expect(screen.getByText('RETIRED. Replaced by the Strategist.')).toBeInTheDocument()
	})

	it('shows the skill count only when the actor list carries skills', () => {
		actors = [agentRow({ skills: ['a', 'b', 'c'] })]
		const { unmount } = renderCard()
		expect(screen.getByText('Skills')).toBeInTheDocument()
		expect(screen.getByText('3')).toBeInTheDocument()
		unmount()
		actors = [agentRow()]
		renderCard()
		expect(screen.queryByText('Skills')).not.toBeInTheDocument()
	})

	it('shows a connected tool as an agent that is Idle, never Working', () => {
		actors = [agentRow({ name: 'GitHub', isSystem: true })]
		sessions = [session('running')]
		renderCard()
		expect(screen.getByText('Idle')).toBeInTheDocument()
		expect(screen.queryByText('Working now')).not.toBeInTheDocument()
	})

	it('names the card for assistive tech: Agent, state: name', () => {
		sessions = [session('running')]
		renderCard()
		expect(screen.getByRole('link', { name: 'Agent, Working now: Developer' })).toBeInTheDocument()
	})

	it('never shows instructions, tools, keys or email', () => {
		actors = [
			{
				...agentRow(),
				system_prompt: 'SECRET INSTRUCTIONS',
				tools: { mcp: 'SECRET TOOLS' },
				email: 'dev@secret.example',
			} as Actor,
		]
		const { container } = renderCard()
		for (const secret of ['SECRET INSTRUCTIONS', 'SECRET TOOLS', 'dev@secret.example']) {
			expect(container.textContent).not.toContain(secret)
		}
	})

	it('shows the skeleton while the lists load', () => {
		actors = undefined
		const { unmount } = renderCard()
		expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
		unmount()
		actors = [agentRow()]
		sessionsLoading = true
		renderCard()
		expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
	})

	it('says the agent was deleted, in the dashed look, when it is not on the list', () => {
		actors = []
		renderCard()
		const card = screen.getByText('This agent was deleted')
		expect(card).toHaveClass('italic', 'border-dashed')
	})

	it('draws nothing for a person: the caller keeps the original link', () => {
		actors = [agentRow({ type: 'human', name: 'Magnus' })]
		const { container } = renderCard()
		expect(container).toBeEmptyDOMElement()
	})

	it('is a preview that is a plain box and not counted as a card', () => {
		renderCard(true)
		expect(document.querySelector('[data-linked-card]')).toBeNull()
		expect(screen.queryByRole('link')).toBeNull()
	})

	it('folds to one row with the name and state, and unfolds', async () => {
		const user = userEvent.setup()
		sessions = [session('running')]
		renderCard()
		await user.click(screen.getByRole('button', { name: 'Fold card' }))
		const row = screen.getByRole('button', { name: 'Unfold card: Developer' })
		expect(row).toHaveTextContent('Working now')
		await user.click(row)
		expect(screen.getByRole('link')).toBeInTheDocument()
	})
})

describe('AgentReferenceChip', () => {
	const renderChip = () =>
		render(<AgentReferenceChip workspaceId={WS} agentId={AGENT_ID} fallback={fallback} />)

	it('keeps the original link while the lists load', () => {
		actors = undefined
		renderChip()
		expect(screen.getByText('the original link')).toBeInTheDocument()
	})

	it('reads kind, state and name as one link, with only the icon and name on the plate', () => {
		sessions = [session('running')]
		renderChip()
		const link = screen.getByRole('link', { name: 'Agent, Working now: Developer' })
		expect(link).toHaveTextContent(/^\u2060?Developer$/)
		expect(link.className).toContain('bg-muted')
		expect(link.querySelector('svg')?.getAttribute('class')).toContain('lucide-bot')
		expect(screen.queryByText('the original link')).not.toBeInTheDocument()
	})

	it('reads Idle in the name for an agent that is not working', () => {
		renderChip()
		expect(screen.getByRole('link', { name: 'Agent, Idle: Developer' })).toBeInTheDocument()
	})

	it('shows the short name before a long dash', () => {
		actors = [agentRow({ name: 'Developer — builds things' })]
		renderChip()
		const link = screen.getByRole('link', { name: 'Agent, Idle: Developer — builds things' })
		expect(link).toHaveTextContent(/^\u2060?Developer$/)
	})

	it('says Deleted agent when the agent is not on the list', () => {
		actors = []
		renderChip()
		expect(screen.getByText('Deleted agent')).toBeInTheDocument()
	})

	it('stays the original link for a person', () => {
		actors = [agentRow({ type: 'human', name: 'Magnus' })]
		renderChip()
		expect(screen.getByText('the original link')).toBeInTheDocument()
		expect(screen.queryByRole('link', { name: /^Agent/ })).not.toBeInTheDocument()
	})
})

describe('agent chip preview and sheet', () => {
	const realMatchMedia = window.matchMedia
	const preview = () => document.querySelector('[data-linked-preview]')
	const setCapable = (capable: boolean) => {
		window.matchMedia = ((query: string) => ({
			matches: capable,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		})) as unknown as typeof window.matchMedia
	}
	afterEach(() => {
		window.matchMedia = realMatchMedia
	})

	it('opens the agent card on hover with Copy link and Open, and closes on Escape', async () => {
		setCapable(true)
		const user = userEvent.setup()
		sessions = [session('running')]
		render(<AgentReferenceChip workspaceId={WS} agentId={AGENT_ID} fallback={fallback} />)
		await user.hover(screen.getByRole('link', { name: /^Agent, Working now/ }))
		expect(preview()?.textContent).toContain('Builds and ships the code.')
		expect(preview()?.textContent).toContain('Working now')
		expect(screen.getByRole('dialog', { name: 'Object preview' })).toBe(preview())
		expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Open' })).toBeInTheDocument()
		await user.keyboard('{Escape}')
		expect(preview()).toBeNull()
	})

	it('has no preview for a deleted agent', () => {
		setCapable(true)
		actors = []
		render(<AgentReferenceChip workspaceId={WS} agentId={AGENT_ID} fallback={fallback} />)
		act(() => {
			fireEvent.mouseEnter(screen.getByText('Deleted agent'))
		})
		expect(preview()).toBeNull()
	})

	it('opens the agent card in the sheet on a tap where there is no preview', async () => {
		setCapable(false)
		const user = userEvent.setup()
		render(<AgentReferenceChip workspaceId={WS} agentId={AGENT_ID} fallback={fallback} />)
		await user.click(screen.getByRole('link', { name: /^Agent, Idle/ }))
		const sheet = screen.getByRole('dialog', { name: 'Object preview' })
		expect(sheet.textContent).toContain('Builds and ships the code.')
		expect(screen.getByRole('link', { name: 'Open' })).toBeInTheDocument()
	})
})
