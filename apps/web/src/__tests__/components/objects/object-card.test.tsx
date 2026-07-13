import { ObjectCard } from '@/components/objects/data-table/object-card'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildObjectResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>agent working</span>,
}))

function renderCard(object = buildObjectResponse()) {
	return render(
		<ObjectCard
			object={object}
			workspaceId="ws-1"
			isSelected={false}
			onSelect={() => {}}
			onClick={() => {}}
		/>,
	)
}

describe('ObjectCard archived variant', () => {
	it('paused rows render at full opacity with no is-archived marker', () => {
		const { container } = renderCard(buildObjectResponse({ status: 'paused' }))
		const row = container.querySelector('[data-archived]')
		expect(row).toBeNull()
		const card = container.firstElementChild as HTMLElement
		expect(card.className).not.toContain('is-archived')
		expect(card.className).not.toContain('opacity-')
	})

	it('archived rows carry the .is-archived variant with 0.62 default and 0.9 hover opacity', () => {
		const { container } = renderCard(buildObjectResponse({ status: 'archived' }))
		const card = container.querySelector('[data-archived]') as HTMLElement
		expect(card).not.toBeNull()
		expect(card.className).toContain('is-archived')
		expect(card.className).toContain('opacity-[0.62]')
		expect(card.className).toContain('hover:opacity-90')
	})

	it('archived rows render "was <prior>" meta when metadata.previous_status is set', () => {
		renderCard(
			buildObjectResponse({ status: 'archived', metadata: { previous_status: 'succeeded' } }),
		)
		expect(screen.getByText('was succeeded')).toBeInTheDocument()
	})

	it('replaces underscores with spaces in the prior status label', () => {
		renderCard(
			buildObjectResponse({ status: 'archived', metadata: { previous_status: 'in_progress' } }),
		)
		expect(screen.getByText('was in progress')).toBeInTheDocument()
	})

	it('omits the "was …" meta when previous_status is missing (avoids "was archived")', () => {
		const { container } = renderCard(buildObjectResponse({ status: 'archived', metadata: null }))
		expect(container.textContent).not.toContain('was ')
	})

	it('does not render the "was …" meta on non-archived rows even if previous_status is set', () => {
		renderCard(
			buildObjectResponse({ status: 'paused', metadata: { previous_status: 'succeeded' } }),
		)
		expect(screen.queryByText('was succeeded')).not.toBeInTheDocument()
	})
})
