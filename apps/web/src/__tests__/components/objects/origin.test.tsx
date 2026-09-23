import { Origin, resolveLineage } from '@/components/objects/origin'
import { render, screen } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import { buildActorListItem, buildRelationshipResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({
		data: [buildActorListItem({ id: 'session-actor', name: 'Strategist', type: 'agent' })],
	}),
}))

vi.mock('@/hooks/use-sessions', () => ({
	useSession: () => ({ data: null }),
	useSessionLogs: () => ({ data: [], isLoading: false }),
	useStopSession: () => ({ mutate: vi.fn(), isPending: false }),
	usePauseSession: () => ({ mutate: vi.fn(), isPending: false }),
	useResumeSession: () => ({ mutate: vi.fn(), isPending: false }),
	useSessionErrorLog: () => ({ data: null, isLoading: false }),
}))

vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		to,
		params,
		search,
		className,
	}: {
		children: React.ReactNode
		to: string
		params?: Record<string, string>
		search?: Record<string, unknown>
		className?: string
	}) => {
		const href = to
			.replace(/\$([a-zA-Z]+)/g, (_m, key: string) => params?.[key] ?? '')
			.concat(
				search?.msg != null
					? `?msg=${encodeURIComponent(String((search as { msg: unknown }).msg))}`
					: '',
			)
		return (
			<a href={href} className={className}>
				{children}
			</a>
		)
	},
}))

describe('resolveLineage', () => {
	it('returns null when there is no produced_by edge (absence contract)', () => {
		const rels = [
			buildRelationshipResponse({
				sourceType: 'bet',
				targetType: 'task',
				sourceId: 'bet-1',
				targetId: 'obj-1',
				type: 'breaks_into',
			}),
		]
		expect(resolveLineage(rels, 'obj-1')).toBeNull()
	})

	it('resolves session and chat when both edges are present', () => {
		const rels = [
			buildRelationshipResponse({
				sourceType: 'session',
				sourceId: 'session-1',
				sourceTitle: 'Draft the outline',
				targetType: 'bet',
				targetId: 'obj-1',
				type: 'produced_by',
				createdBy: 'session-actor',
				createdAt: '2026-09-23T10:00:00Z',
			}),
			buildRelationshipResponse({
				sourceType: 'conversation',
				sourceId: 'conv-1',
				sourceTitle: 'Kickoff chat',
				targetType: 'session',
				targetId: 'session-1',
				type: 'spawned',
				metadata: { messageId: 4242 },
			}),
		]
		const lineage = resolveLineage(rels, 'obj-1')
		expect(lineage).toEqual({
			sessionId: 'session-1',
			sessionTitle: 'Draft the outline',
			sessionActorId: 'session-actor',
			spawnedAt: '2026-09-23T10:00:00Z',
			conversation: { id: 'conv-1', title: 'Kickoff chat', messageId: 4242 },
		})
	})

	it('resolves session-only lineage when the spawn edge is absent (file-origin variant)', () => {
		const rels = [
			buildRelationshipResponse({
				sourceType: 'session',
				sourceId: 'session-1',
				sourceTitle: 'Cron trigger run',
				targetType: 'bet',
				targetId: 'obj-1',
				type: 'produced_by',
				createdBy: 'session-actor',
			}),
		]
		const lineage = resolveLineage(rels, 'obj-1')
		expect(lineage?.conversation).toBeNull()
	})
})

describe('<Origin>', () => {
	it('renders nothing when there is no lineage', () => {
		const { container } = render(
			<Origin object={{ id: 'obj-1' }} relationships={[]} workspaceId="ws-1" />,
			{ wrapper: createWorkspaceWrapper() },
		)
		expect(container.firstChild).toBeNull()
	})

	it('renders the compact form and expands on click into the two-column card', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		render(
			<Origin
				object={{ id: 'obj-1' }}
				relationships={[
					buildRelationshipResponse({
						sourceType: 'session',
						sourceId: 'session-1',
						sourceTitle: 'Draft the outline',
						targetType: 'bet',
						targetId: 'obj-1',
						type: 'produced_by',
						createdBy: 'session-actor',
					}),
					buildRelationshipResponse({
						sourceType: 'conversation',
						sourceId: 'conv-1',
						sourceTitle: 'Kickoff chat',
						targetType: 'session',
						targetId: 'session-1',
						type: 'spawned',
						metadata: { messageId: 4242 },
					}),
				]}
				workspaceId="ws-1"
			/>,
			{ wrapper: createWorkspaceWrapper() },
		)

		// Compact form: Origin eyebrow + chat title in the row.
		const compact = screen.getByRole('button', { name: /origin.*expand/i })
		expect(compact).toHaveAttribute('aria-expanded', 'false')
		expect(screen.getByText('Origin')).toBeInTheDocument()
		expect(screen.getByText('Kickoff chat')).toBeInTheDocument()

		await user.click(compact)

		// Expanded form: Chat and Session cell headings, plus the deep-link
		// wired to /chats/<id>?msg=<messageId>.
		expect(screen.getByRole('button', { name: /origin.*collapse/i })).toHaveAttribute(
			'aria-expanded',
			'true',
		)
		expect(screen.getByText('Chat')).toBeInTheDocument()
		expect(screen.getByText('Session')).toBeInTheDocument()
		const deepLink = screen.getByRole('link', { name: /open chat at this moment/i })
		expect(deepLink).toHaveAttribute('href', '/ws-1/chats/conv-1?msg=4242')
		expect(screen.getByText(/System-written · not editable/i)).toBeInTheDocument()
	})

	it('drops the Chat cell (file-origin variant) when the session has no parent conversation', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		render(
			<Origin
				object={{ id: 'obj-1' }}
				relationships={[
					buildRelationshipResponse({
						sourceType: 'session',
						sourceId: 'session-1',
						sourceTitle: 'Cron trigger run',
						targetType: 'bet',
						targetId: 'obj-1',
						type: 'produced_by',
						createdBy: 'session-actor',
					}),
				]}
				workspaceId="ws-1"
			/>,
			{ wrapper: createWorkspaceWrapper() },
		)

		await user.click(screen.getByRole('button', { name: /origin.*expand/i }))

		expect(screen.queryByText('Chat')).not.toBeInTheDocument()
		expect(screen.getByText('Session')).toBeInTheDocument()
		expect(
			screen.queryByRole('link', { name: /open chat at this moment/i }),
		).not.toBeInTheDocument()
	})
})
