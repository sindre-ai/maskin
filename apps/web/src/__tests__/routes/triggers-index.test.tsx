import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateMutate = vi.fn()
let triggers: unknown[] = []
let loops: unknown[] = []

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1', workspace: {} }),
}))
vi.mock('@/hooks/use-can-write', () => ({ useCanWrite: () => true }))
vi.mock('@/hooks/use-document-title', () => ({ useDocumentTitle: () => {} }))
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [{ id: 'ag-1', name: 'SEO Researcher', type: 'agent' }] }),
}))
vi.mock('@/hooks/use-loops', () => ({
	useLoops: () => ({ data: loops, isLoading: false }),
}))
vi.mock('@/hooks/use-triggers', () => ({
	useTriggers: () => ({ data: triggers, isLoading: false, isError: false }),
	useUpdateTrigger: () => ({ mutate: updateMutate, isPending: false }),
}))
vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div>,
}))
vi.mock('@/components/shared/create-picker', () => ({
	CreatePicker: ({ open }: { open: boolean }) => (open ? <div>Create picker</div> : null),
}))
vi.mock('@/components/shared/route-error', () => ({ RouteError: () => <div>Error</div> }))
vi.mock('@/components/triggers/trigger-form', () => ({
	readEventStatusTransition: () => ({ fromStatus: '__any__', toStatus: '__any__' }),
}))

import { Route } from '@/routes/_authed/$workspaceId/triggers/index'

const TriggersPage = (Route as unknown as { component: React.FC }).component

const trigger = (id: string, name: string) => ({
	id,
	name,
	type: 'cron',
	config: { expression: '0 8 * * *' },
	enabled: true,
	targetActorId: 'ag-1',
})

describe('/$workspaceId/triggers', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		triggers = [trigger('t-1', 'Weekly report'), trigger('t-2', 'Ranking drop')]
		loops = [{ triggerIds: ['t-1'] }]
	})

	it('lists flow triggers and standalone triggers under their own headings', () => {
		render(<TriggersPage />)
		expect(screen.getByRole('heading', { name: 'In flows' })).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'Not tied to a flow' })).toBeInTheDocument()
		expect(screen.getByText('Weekly report')).toBeInTheDocument()
		expect(screen.getByText('Ranking drop')).toBeInTheDocument()
	})

	it('says so when every trigger belongs to a flow', () => {
		triggers = [trigger('t-1', 'Weekly report')]
		render(<TriggersPage />)
		expect(screen.getByText(/Every trigger belongs to a flow/)).toBeInTheDocument()
	})

	it('opens the create picker from New trigger', async () => {
		const user = userEvent.setup()
		render(<TriggersPage />)
		await user.click(screen.getByRole('button', { name: /New trigger/ }))
		expect(screen.getByText('Create picker')).toBeInTheDocument()
	})
})
