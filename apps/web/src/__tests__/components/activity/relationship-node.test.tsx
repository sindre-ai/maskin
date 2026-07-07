import { RelationshipNode } from '@/components/activity/relationship-node'
import { render, screen } from '@testing-library/react'
import { buildObjectResponse, buildRelationshipResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

describe('RelationshipNode verb labeling', () => {
	// Past-participle for inbound edges — the original `${type}d by` pattern
	// rendered "informsd by" / "breaks intod by" / "relates tod by" on every
	// known relationship type. Pin the natural English forms here.
	const linked = buildObjectResponse({ id: 'obj-1', title: 'Other thing' })

	it.each([
		['informs', 'informed by'],
		['breaks_into', 'part of'],
		['blocks', 'blocked by'],
		['relates_to', 'related to'],
		['duplicates', 'duplicated by'],
		['attached', 'attached to'],
	])('labels inbound %s as "%s"', (type, expected) => {
		const rel = buildRelationshipResponse({
			id: `rel-${type}`,
			type,
			sourceId: 'obj-1',
			targetId: 'me',
			createdAt: '2026-06-23T10:00:00Z',
		})
		render(<RelationshipNode rel={rel} linked={linked} workspaceId="ws-1" direction="inbound" />)
		expect(screen.getByText(expected)).toBeInTheDocument()
	})

	it('falls back to "← {type}" for unknown inbound types', () => {
		const rel = buildRelationshipResponse({
			id: 'rel-custom',
			type: 'spawns',
			sourceId: 'obj-1',
			targetId: 'me',
			createdAt: '2026-06-23T10:00:00Z',
		})
		render(<RelationshipNode rel={rel} linked={linked} workspaceId="ws-1" direction="inbound" />)
		expect(screen.getByText('← spawns')).toBeInTheDocument()
	})

	it('renders the type verbatim for outbound edges', () => {
		const rel = buildRelationshipResponse({
			id: 'rel-out',
			type: 'breaks_into',
			sourceId: 'me',
			targetId: 'obj-1',
			createdAt: '2026-06-23T10:00:00Z',
		})
		render(<RelationshipNode rel={rel} linked={linked} workspaceId="ws-1" direction="outbound" />)
		expect(screen.getByText('breaks into')).toBeInTheDocument()
	})
})

describe('RelationshipNode missing linked object', () => {
	// The backend denormalizes both endpoints' titles onto every relationship,
	// including the currently-viewed object's own title. For an inbound edge
	// the missing object is the *source*, so the fallback must read
	// `sourceTitle` — reading `targetTitle` first would show the viewed
	// object's own title instead of the deleted link's.
	it("shows sourceTitle, not the viewed object's own targetTitle, for a missing inbound link", () => {
		const rel = buildRelationshipResponse({
			id: 'rel-missing-inbound',
			type: 'informs',
			sourceId: 'deleted-insight',
			targetId: 'me',
			sourceTitle: 'Deleted insight',
			targetTitle: 'My own bet title',
			createdAt: '2026-06-23T10:00:00Z',
		})
		render(<RelationshipNode rel={rel} linked={null} workspaceId="ws-1" direction="inbound" />)
		expect(screen.getByText('Deleted insight')).toBeInTheDocument()
		expect(screen.queryByText('My own bet title')).not.toBeInTheDocument()
	})

	it('shows targetTitle, not sourceTitle, for a missing outbound link', () => {
		const rel = buildRelationshipResponse({
			id: 'rel-missing-outbound',
			type: 'breaks_into',
			sourceId: 'me',
			targetId: 'deleted-task',
			sourceTitle: 'My own bet title',
			targetTitle: 'Deleted task',
			createdAt: '2026-06-23T10:00:00Z',
		})
		render(<RelationshipNode rel={rel} linked={null} workspaceId="ws-1" direction="outbound" />)
		expect(screen.getByText('Deleted task')).toBeInTheDocument()
		expect(screen.queryByText('My own bet title')).not.toBeInTheDocument()
	})

	it('falls back to "Unknown (id)" when neither side has a title', () => {
		const rel = buildRelationshipResponse({
			id: 'rel-missing-notitle',
			type: 'informs',
			sourceId: 'deleted-insight-id-12345',
			targetId: 'me',
			createdAt: '2026-06-23T10:00:00Z',
		})
		render(<RelationshipNode rel={rel} linked={null} workspaceId="ws-1" direction="inbound" />)
		expect(screen.getByText('Unknown (deleted-)')).toBeInTheDocument()
	})
})
