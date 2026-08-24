import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigateMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	createFileRoute: () => (options: Record<string, unknown>) => options,
	useParams: () => ({ workspaceId: 'ws-1' }),
	Navigate: (props: Record<string, unknown>) => {
		navigateMock(props)
		return null
	},
}))

vi.mock('@/components/triggers/legacy/triggers-index-page', () => ({
	LegacyTriggersIndexPage: () => <div>Legacy triggers</div>,
}))

const mockNewDesign = vi.fn()
vi.mock('@/lib/new-design-context', () => ({
	useNewDesign: () => mockNewDesign(),
}))

import { Route } from '@/routes/_authed/$workspaceId/triggers/index'

const TriggersPage = (Route as unknown as { component: React.FC }).component

describe('/$workspaceId/triggers', () => {
	beforeEach(() => {
		navigateMock.mockClear()
	})

	it('redirects to the workspace Loops list under the new design', () => {
		mockNewDesign.mockReturnValue(true)
		render(<TriggersPage />)

		expect(navigateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '/$workspaceId/loops',
				params: { workspaceId: 'ws-1' },
				replace: true,
			}),
		)
	})

	it('renders the pre-v2 Triggers index when the new design is off', () => {
		mockNewDesign.mockReturnValue(false)
		render(<TriggersPage />)

		expect(screen.getByText('Legacy triggers')).toBeInTheDocument()
		expect(navigateMock).not.toHaveBeenCalled()
	})
})
