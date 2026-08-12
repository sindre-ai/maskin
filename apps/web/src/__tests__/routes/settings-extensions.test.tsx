import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { buildWorkspaceWithRole } from '../factories'

const mockMutate = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspaceId: 'ws-1',
		workspace: buildWorkspaceWithRole({
			settings: {
				enabled_modules: ['work'],
				custom_extensions: {
					'ext-crm': { name: 'CRM', types: ['lead', 'deal'], enabled: false },
				},
				display_names: { lead: 'Leads', deal: 'Deals' },
			},
		}),
	}),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useUpdateWorkspace: () => ({ mutate: mockMutate, isPending: false }),
}))

vi.mock('@/hooks/use-enabled-modules', () => ({
	useEnabledModules: () => ['work'],
}))

vi.mock('@/hooks/use-custom-extensions', () => ({
	useCustomExtensions: () => [
		{
			id: 'ext-crm',
			name: 'CRM',
			types: ['lead', 'deal'],
			tabs: [
				{ label: 'Leads', value: 'lead' },
				{ label: 'Deals', value: 'deal' },
			],
			enabled: false,
		},
	],
}))

vi.mock('@maskin/module-sdk', () => ({
	getAllWebModules: () => [
		{
			id: 'work',
			name: 'Work',
			objectTypeTabs: [{ label: 'Tasks', value: 'task' }],
			defaultSettings: { display_names: { task: 'Tasks' }, statuses: { task: ['todo', 'done'] } },
		},
	],
	getWebModule: (id: string) =>
		id === 'work'
			? {
					id: 'work',
					name: 'Work',
					objectTypeTabs: [{ label: 'Tasks', value: 'task' }],
					defaultSettings: {
						display_names: { task: 'Tasks' },
						statuses: { task: ['todo', 'done'] },
					},
				}
			: null,
}))

vi.mock('sonner', () => ({
	toast: { error: vi.fn() },
}))

vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

vi.mock('@/components/extensions/extension-removal-dialog', () => ({
	ExtensionRemovalDialog: () => <div>RemovalDialog</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/settings/extensions'

const ExtensionsPage = (Route as unknown as { component: React.FC }).component

describe('ExtensionsPage', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders the extensions rail section', () => {
		render(<ExtensionsPage />)
		expect(screen.getByText('Extensions')).toBeInTheDocument()
	})

	it('lists registered modules with their object types', () => {
		render(<ExtensionsPage />)
		expect(screen.getByText('Work')).toBeInTheDocument()
		expect(screen.getByText('Tasks')).toBeInTheDocument()
	})

	it('lists custom extensions with their display names', () => {
		render(<ExtensionsPage />)
		expect(screen.getByText('CRM')).toBeInTheDocument()
		expect(screen.getByText('Leads, Deals')).toBeInTheDocument()
	})

	it('persists a custom extension toggle across reload via workspace update', async () => {
		const user = userEvent.setup()
		render(<ExtensionsPage />)
		const switches = screen.getAllByRole('switch')
		// First switch is the CRMDisabled module (enabled_modules: ['work']), last is the custom extension
		const crmSwitch = switches[switches.length - 1]
		await user.click(crmSwitch)
		expect(mockMutate).toHaveBeenCalledWith(
			expect.objectContaining({
				settings: expect.objectContaining({
					custom_extensions: expect.objectContaining({
						'ext-crm': expect.objectContaining({ enabled: true }),
					}),
				}),
			}),
			expect.anything(), // mutate options (onError)
		)
	})
})
