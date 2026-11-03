import { render } from '@testing-library/react'
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

import { Route } from '@/routes/_authed/$workspaceId/triggers/index'

const TriggersPage = (Route as unknown as { component: React.FC }).component

describe('/$workspaceId/triggers', () => {
	beforeEach(() => {
		navigateMock.mockClear()
	})

	// v2 folds triggers into Loops, so this route exists only to keep old
	// bookmarks resolving — it always redirects.
	it('redirects to the workspace Loops list', () => {
		render(<TriggersPage />)

		expect(navigateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '/$workspaceId/loops',
				params: { workspaceId: 'ws-1' },
				replace: true,
			}),
		)
	})
})
