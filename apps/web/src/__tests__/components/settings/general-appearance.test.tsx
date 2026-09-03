import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspaceWithRole } from '../../factories'
import { TestWrapper } from '../../setup'

const mockSetTheme = vi.fn()
const mockTheme = { current: 'light' as 'light' | 'dark' | 'system' }
const mockWorkspace = { current: buildWorkspaceWithRole({ settings: {} }) }

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspace: mockWorkspace.current,
		workspaceId: mockWorkspace.current.id,
		sseStatus: 'connected',
	}),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useUpdateWorkspace: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/lib/theme', () => ({
	useTheme: () => ({ theme: mockTheme.current, setTheme: mockSetTheme }),
}))

import { Route } from '@/routes/_authed/$workspaceId/settings/index'

const GeneralPage = Route.options.component as () => React.ReactElement

function renderPage() {
	return render(
		<TestWrapper>
			<GeneralPage />
		</TestWrapper>,
	)
}

describe('Settings > General > section labels', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockTheme.current = 'light'
	})

	// Mockup 2697/2704/2710 sets these at 11px sans, not the 8px mono `.eyebrow`
	// used for the "VIEW / SHOW / SORT" micro-labels elsewhere in the app.
	it('renders the three section labels with the settings label style', () => {
		renderPage()

		for (const name of ['WORKSPACE NAME', 'APPEARANCE', 'PRIVACY & DATA']) {
			const heading = screen.getByRole('heading', { name })
			expect(heading).toHaveClass('settings-label')
			expect(heading).not.toHaveClass('eyebrow')
		}
	})
})

describe('Settings > General > Appearance', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockTheme.current = 'light'
	})

	// Mockup 2706 fills the selected option with #18181b / white text. `--secondary`
	// is #f6f6f7 in light mode, so a secondary fill on a white card reads as no
	// selection at all — the same class of bug as the `bg-accent` indicator in
	// `.claude/rules/known-pitfalls.md`.
	it('fills the selected theme option with primary, not a near-white surface', () => {
		renderPage()

		const light = screen.getByRole('button', { name: 'Light' })
		expect(light).toHaveClass('bg-primary')
		expect(light).toHaveClass('text-primary-foreground')
		expect(light).not.toHaveClass('bg-secondary')
	})

	it('leaves the unselected options unfilled', () => {
		renderPage()

		for (const name of ['Dark', 'System']) {
			const option = screen.getByRole('button', { name })
			expect(option).not.toHaveClass('bg-primary')
			expect(option).toHaveClass('text-muted-foreground')
		}
	})

	it('moves the fill to whichever option is active', () => {
		mockTheme.current = 'dark'
		renderPage()

		expect(screen.getByRole('button', { name: 'Dark' })).toHaveClass('bg-primary')
		expect(screen.getByRole('button', { name: 'Light' })).not.toHaveClass('bg-primary')
	})

	it('selects a theme when its option is clicked', async () => {
		const user = userEvent.setup()
		renderPage()

		await user.click(screen.getByRole('button', { name: 'System' }))

		expect(mockSetTheme).toHaveBeenCalledWith('system')
	})
})
