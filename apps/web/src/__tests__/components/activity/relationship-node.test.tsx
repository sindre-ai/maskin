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
