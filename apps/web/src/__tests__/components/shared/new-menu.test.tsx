import { NewMenu } from '@/components/shared/new-menu'
import { CommandPaletteProvider } from '@/lib/command-palette-context'
import { WorkspaceContext, type WorkspaceContextValue } from '@/lib/workspace-context'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import { Pencil } from 'lucide-react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { buildWorkspaceWithRole } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-available-object-types', () => ({
	useAvailableObjectTypes: () => [{ value: 'insight', label: 'Insight' }],
}))

vi.mock('@/hooks/use-imports', () => ({
	useImportToast: () => ({ startTracking: vi.fn() }),
}))

function makeWrapper() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
	const workspace = buildWorkspaceWithRole()
	const ctxValue: WorkspaceContextValue = {
		workspace,
		workspaceId: workspace.id,
		sseStatus: 'connected',
	}
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<WorkspaceContext.Provider value={ctxValue}>
				<CommandPaletteProvider>{children}</CommandPaletteProvider>
			</WorkspaceContext.Provider>
		</QueryClientProvider>
	)
}

describe('NewMenu — D4 behaviour', () => {
	// On object-detail pages the object section is hidden, so the primary half
	// falls back to opening a new chat (see NewMenu's `hideObjectSection` note).
	// The verb-swap override needs to still land on top of THAT default.
	it('renders the fallback "New chat" primary on object-detail by default', () => {
		render(<NewMenu onNewChat={vi.fn()} primaryKind="object" hideObjectSection />, {
			wrapper: makeWrapper(),
		})
		expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument()
	})

	it('swaps the primary label + click when primaryOverride is set (D4 verb swap)', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const onAnswer = vi.fn()
		render(
			<NewMenu
				onNewChat={vi.fn()}
				primaryKind="object"
				hideObjectSection
				primaryOverride={{
					label: 'Answer this ask',
					icon: <Pencil aria-hidden />,
					onClick: onAnswer,
				}}
			/>,
			{ wrapper: makeWrapper() },
		)

		expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull()
		const primary = screen.getByRole('button', { name: 'Answer this ask' })
		await user.click(primary)
		expect(onAnswer).toHaveBeenCalledOnce()
	})

	it('disables both halves when disabled is set (D4 read-only rule)', () => {
		render(<NewMenu onNewChat={vi.fn()} primaryKind="object" hideObjectSection disabled />, {
			wrapper: makeWrapper(),
		})
		expect(screen.getByRole('button', { name: 'New chat' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'More ways to start' })).toBeDisabled()
	})

	it('leaves the chevron menu unchanged in override mode', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		render(
			<NewMenu
				onNewChat={vi.fn()}
				primaryKind="object"
				hideObjectSection
				primaryOverride={{
					label: 'Answer this ask',
					icon: <Pencil aria-hidden />,
					onClick: vi.fn(),
				}}
			/>,
			{ wrapper: makeWrapper() },
		)
		await user.click(screen.getByRole('button', { name: 'More ways to start' }))
		expect(await screen.findByRole('menuitem', { name: /new chat/i })).toBeInTheDocument()
	})
})
