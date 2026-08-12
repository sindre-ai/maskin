import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspaceWithRole } from '../../factories'
import { TestWrapper } from '../../setup'

const mockMutate = vi.fn()
const mockWorkspace = { current: buildWorkspaceWithRole({ settings: {} }) }
const mockEnabledModules = { current: ['work'] }
const mockCustomExtensions = { current: [] as CustomExtensionInfo[] }
const mockGetAllWebModules = vi.fn()
const mockGetWebModule = vi.fn()

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspace: mockWorkspace.current, workspaceId: mockWorkspace.current.id }),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useUpdateWorkspace: () => ({ mutate: mockMutate, isPending: false }),
}))

vi.mock('@/hooks/use-enabled-modules', () => ({
	useEnabledModules: () => mockEnabledModules.current,
}))

vi.mock('@/hooks/use-custom-extensions', () => ({
	useCustomExtensions: () => mockCustomExtensions.current,
}))

vi.mock('@maskin/module-sdk', () => ({
	getAllWebModules: () => mockGetAllWebModules(),
	getWebModule: (id: string) => mockGetWebModule(id),
}))

vi.mock('@/components/extensions/extension-removal-dialog', () => ({
	ExtensionRemovalDialog: ({
		onConfirmed,
	}: {
		onConfirmed: () => void
	}) => (
		<button type="button" onClick={onConfirmed}>
			Confirm removal
		</button>
	),
}))

vi.mock('sonner', () => ({
	toast: { error: vi.fn() },
}))

import { ExtensionsManager } from '@/components/extensions/extensions-manager'
import type { CustomExtensionInfo } from '@/hooks/use-custom-extensions'

function renderManager() {
	return render(
		<TestWrapper>
			<ExtensionsManager />
		</TestWrapper>,
	)
}

describe('ExtensionsManager', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockWorkspace.current = buildWorkspaceWithRole({ settings: {} })
		mockEnabledModules.current = ['work']
		mockCustomExtensions.current = []
		mockGetAllWebModules.mockReturnValue([
			{ id: 'work', name: 'Work', objectTypeTabs: [{ label: 'Insights', value: 'insight' }] },
			{ id: 'crm', name: 'CRM', objectTypeTabs: [{ label: 'Contacts', value: 'contact' }] },
		])
		mockGetWebModule.mockReturnValue({
			objectTypeTabs: [{ label: 'Contacts', value: 'contact' }],
			defaultSettings: { display_names: { contact: 'Contact' }, statuses: {} },
		})
	})

	it('lists every registered module with its name and type tabs', () => {
		renderManager()
		expect(screen.getByText('Work')).toBeInTheDocument()
		expect(screen.getByText('CRM')).toBeInTheDocument()
		expect(screen.getByText('Insights')).toBeInTheDocument()
		expect(screen.getByText('Contacts')).toBeInTheDocument()
	})

	it('reflects the enabled state of each module in its switch', () => {
		renderManager()
		const switches = screen.getAllByRole('switch')
		// 'work' is in enabled_modules -> checked; 'crm' is not -> unchecked
		expect(switches[0]).toHaveAttribute('data-state', 'checked')
		expect(switches[1]).toHaveAttribute('data-state', 'unchecked')
	})

	it('persists enabling a module by merging it into enabled_modules and its defaults', async () => {
		const user = userEvent.setup()
		renderManager()
		const crmSwitch = screen.getAllByRole('switch')[1]
		await user.click(crmSwitch)

		expect(mockMutate).toHaveBeenCalledWith(
			expect.objectContaining({
				settings: expect.objectContaining({
					enabled_modules: ['work', 'crm'],
					display_names: expect.objectContaining({ contact: 'Contact' }),
				}),
			}),
			expect.anything(),
		)
	})

	it('persists disabling a module after confirming the removal dialog', async () => {
		const user = userEvent.setup()
		renderManager()
		await user.click(screen.getAllByRole('switch')[0])

		// Disabling a built-in module with object types opens the removal dialog.
		expect(screen.getByRole('button', { name: 'Confirm removal' })).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Confirm removal' }))

		expect(mockMutate).toHaveBeenCalledWith(
			expect.objectContaining({
				settings: expect.objectContaining({ enabled_modules: [] }),
			}),
			expect.anything(),
		)
	})

	it('persists toggling a custom extension off', async () => {
		const user = userEvent.setup()
		mockCustomExtensions.current = [
			{
				id: 'myext',
				name: 'My Ext',
				types: ['foo'],
				tabs: [{ label: 'Foo', value: 'foo' }],
				enabled: true,
			},
		]
		renderManager()

		expect(screen.getByText('My Ext')).toBeInTheDocument()

		const myExtRow = screen.getByText('My Ext').closest('div')?.parentElement as HTMLElement
		await user.click(within(myExtRow).getByRole('switch'))
		await user.click(screen.getByRole('button', { name: 'Confirm removal' }))

		expect(mockMutate).toHaveBeenCalledWith(
			expect.objectContaining({
				settings: expect.objectContaining({
					custom_extensions: expect.objectContaining({
						myext: expect.objectContaining({ enabled: false }),
					}),
				}),
			}),
			expect.anything(),
		)
	})
})
