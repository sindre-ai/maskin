import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspaceWithRole } from '../../factories'
import { TestWrapper } from '../../setup'

const mockUpdateMutate = vi.fn()
const mockWorkspace = { current: buildWorkspaceWithRole({ settings: {} }) }

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspace: mockWorkspace.current,
		workspaceId: mockWorkspace.current.id,
		sseStatus: 'connected',
	}),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useUpdateWorkspace: () => ({ mutate: mockUpdateMutate, isPending: false }),
}))

vi.mock('@/hooks/use-custom-extensions', () => ({
	useCustomExtensions: () => [],
}))

vi.mock('@/hooks/use-enabled-modules', () => ({
	useEnabledModules: () => ['work'],
}))

vi.mock('@/lib/theme', () => ({
	useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
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

describe('Settings > General > Privacy & data', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockWorkspace.current = buildWorkspaceWithRole({ settings: {} })
	})

	it('renders the privacy heading, both switches, and the disclosure copy', () => {
		renderPage()

		expect(screen.getByText('Privacy & data')).toBeInTheDocument()
		expect(screen.getByText(/Product usage events are sent to PostHog/)).toBeInTheDocument()
		expect(
			screen.getByRole('switch', { name: 'Share product usage with Maskin' }),
		).toBeInTheDocument()
		expect(screen.getByRole('switch', { name: 'Anonymize this workspace' })).toBeInTheDocument()
	})

	it('defaults share-usage on and anonymize off when settings.privacy is missing', () => {
		renderPage()

		expect(screen.getByRole('switch', { name: 'Share product usage with Maskin' })).toBeChecked()
		expect(screen.getByRole('switch', { name: 'Anonymize this workspace' })).not.toBeChecked()
	})

	it('reflects existing privacy settings from the workspace', () => {
		mockWorkspace.current = buildWorkspaceWithRole({
			settings: { privacy: { share_usage: false, anonymize_workspace: true } },
		})
		renderPage()

		expect(
			screen.getByRole('switch', { name: 'Share product usage with Maskin' }),
		).not.toBeChecked()
		expect(screen.getByRole('switch', { name: 'Anonymize this workspace' })).toBeChecked()
	})

	it('persists share-usage opt-out through useUpdateWorkspace', async () => {
		const user = userEvent.setup()
		renderPage()

		await user.click(screen.getByRole('switch', { name: 'Share product usage with Maskin' }))

		expect(mockUpdateMutate).toHaveBeenCalledTimes(1)
		const [payload] = mockUpdateMutate.mock.calls[0]
		expect(payload).toEqual({
			settings: {
				privacy: { share_usage: false, anonymize_workspace: false },
			},
		})
	})

	it('persists the anonymize toggle while preserving share-usage', async () => {
		const user = userEvent.setup()
		renderPage()

		await user.click(screen.getByRole('switch', { name: 'Anonymize this workspace' }))

		expect(mockUpdateMutate).toHaveBeenCalledTimes(1)
		const [payload] = mockUpdateMutate.mock.calls[0]
		expect(payload).toEqual({
			settings: {
				privacy: { share_usage: true, anonymize_workspace: true },
			},
		})
	})

	it('preserves unrelated workspace settings when persisting privacy changes', async () => {
		mockWorkspace.current = buildWorkspaceWithRole({
			settings: { enabled_modules: ['work', 'growth'], display_names: { bet: 'Bet' } },
		})
		const user = userEvent.setup()
		renderPage()

		await user.click(screen.getByRole('switch', { name: 'Anonymize this workspace' }))

		const [payload] = mockUpdateMutate.mock.calls[0]
		expect(payload).toEqual({
			settings: {
				enabled_modules: ['work', 'growth'],
				display_names: { bet: 'Bet' },
				privacy: { share_usage: true, anonymize_workspace: true },
			},
		})
	})
})
