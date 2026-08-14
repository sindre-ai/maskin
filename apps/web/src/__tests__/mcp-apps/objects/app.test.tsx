import { ObjectDocument } from '@/mcp-apps/objects/app'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

// The MCP-Apps object viewer has no auth/localStorage bridge into the web
// app's api client, so the graph fetch that backs the Properties drawer's
// file-attachment lookup is stubbed here — the point of this suite is to
// prove the surface renders and the drawer opens, not to exercise the graph
// endpoint itself.
vi.mock('@/hooks/use-objects', () => ({
	useObjectGraph: () => ({ data: undefined }),
}))

vi.mock('@/mcp-apps/shared/mcp-app-provider', () => ({
	useWebAppContext: () => null,
}))

// Importing the module executes its top-level `renderMcpApp(...)` call (it
// mounts into `#root` as a side effect for the real MCP-Apps entry point) —
// stub it out so the import doesn't try to mount into a DOM node the test
// environment doesn't have.
vi.mock('@/mcp-apps/shared/render', () => ({
	renderMcpApp: vi.fn(),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/activity/object-activity', () => ({
	ObjectActivity: () => <div data-testid="object-activity" />,
}))

vi.mock('@/components/shared/markdown-content', () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}))

vi.mock('@/components/objects/metadata-properties', () => ({
	MetadataProperties: () => <div data-testid="metadata-properties" />,
}))

vi.mock('@/components/objects/object-files', () => ({
	ObjectFiles: () => <div data-testid="object-files" />,
}))

vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => false,
}))

const handlers = {
	onUpdateTitle: vi.fn(),
	onUpdateContent: vi.fn(),
	onUpdateStatus: vi.fn(),
	onUpdateDriver: vi.fn(),
	onDelete: vi.fn(),
}

describe('MCP-Apps ObjectDocument', () => {
	// Regression: this component previously rendered ObjectDocumentView with
	// no QueryClientProvider ancestor anywhere in the MCP-Apps render tree,
	// which crashes synchronously the moment a descendant hook (e.g.
	// ObjectActivity's useActors) calls useQueryClient(). The production fix
	// wraps `renderMcpApp('Objects', ...)` in a QueryClientProvider; this test
	// wraps with TestWrapper (also QueryClientProvider-backed) to prove the
	// component itself no longer assumes one is supplied elsewhere.
	it('renders without throwing when a QueryClientProvider ancestor is present', () => {
		const obj = buildObjectResponse({ title: 'MCP object', workspaceId: 'ws-1' })
		expect(() =>
			render(
				<TestWrapper>
					<ObjectDocument obj={obj} handlers={handlers} />
				</TestWrapper>,
			),
		).not.toThrow()
		expect(screen.getByDisplayValue('MCP object')).toBeInTheDocument()
	})

	it('opens the Properties drawer showing Properties + Files when the toggle is clicked', async () => {
		const user = userEvent.setup()
		const obj = buildObjectResponse({ title: 'MCP object', workspaceId: 'ws-1' })
		render(
			<TestWrapper>
				<ObjectDocument obj={obj} handlers={handlers} />
			</TestWrapper>,
		)

		expect(screen.queryByTestId('metadata-properties')).not.toBeInTheDocument()
		expect(screen.queryByTestId('object-files')).not.toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Properties' }))

		expect(screen.getByTestId('metadata-properties')).toBeInTheDocument()
		expect(screen.getByTestId('object-files')).toBeInTheDocument()
	})
})
