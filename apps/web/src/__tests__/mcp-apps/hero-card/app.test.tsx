import { __resetSchemaCacheForTests } from '@/mcp-apps/shared/use-workspace-schema'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const callTool = vi.fn()
const useToolResultMock = vi.fn()

vi.mock('@/mcp-apps/shared/mcp-app-provider', () => ({
	useCallTool: () => callTool,
	useToolResult: () => useToolResultMock(),
	useWebAppContext: () => ({ baseUrl: 'https://maskin.test', workspaceId: 'ws-1' }),
}))

import { HeroCardApp, HeroCardRoot, extractHeroCard } from '@/mcp-apps/hero-card/app'

function makeBetToolResult() {
	return {
		toolName: 'get_objects',
		workspaceId: 'ws-1',
		webAppBaseUrl: 'https://maskin.test',
		input: null,
		result: {
			content: [{ type: 'text', text: '[]' }],
			structuredContent: {
				heroCard: {
					kind: 'single',
					tool: 'get_objects',
					object: {
						id: 'bet-9',
						type: 'bet',
						title: 'Best-in-class MCP widget UX for Maskin',
						status: 'active',
						owner: { id: 'actor-1', name: 'Sebastian' },
						contextLine: 'active · 6-week bet',
					},
				},
			},
		},
	}
}

function makeSchemaResponse() {
	return {
		content: [
			{
				type: 'text',
				text: JSON.stringify({
					workspace_id: 'ws-1',
					workspace_name: 'Test',
					relationship_types: [],
					types: {
						bet: { display_name: 'Bet', statuses: ['active'], fields: [] },
					},
				}),
			},
		],
	}
}

describe('HeroCardApp — bet single render', () => {
	beforeEach(() => {
		__resetSchemaCacheForTests()
		callTool.mockReset()
		useToolResultMock.mockReset()
		callTool.mockImplementation((name) => {
			if (name === 'get_workspace_schema') return Promise.resolve(makeSchemaResponse())
			return Promise.resolve({ content: [] })
		})
	})

	it('renders the bet title, status, context line and Open in Maskin CTA from structuredContent', async () => {
		useToolResultMock.mockReturnValue(makeBetToolResult())
		render(<HeroCardApp />)

		await waitFor(() => {
			expect(screen.getByText('Best-in-class MCP widget UX for Maskin')).toBeInTheDocument()
		})
		expect(screen.getByText('active')).toBeInTheDocument()
		expect(screen.getByText('active · 6-week bet')).toBeInTheDocument()
		expect(screen.getByText('Owner: Sebastian')).toBeInTheDocument()
		const cta = screen.getByRole('link', { name: /Open in Maskin/ })
		expect(cta).toHaveAttribute('href', 'https://maskin.test/ws-1/objects/bet-9')
	})

	it('uses the workspace schema display_name for the type label', async () => {
		useToolResultMock.mockReturnValue(makeBetToolResult())
		render(<HeroCardApp />)
		await waitFor(() => expect(screen.getByText('Bet')).toBeInTheDocument())
	})

	it('fires render_success telemetry on mount with the card_kind and object info', async () => {
		useToolResultMock.mockReturnValue(makeBetToolResult())
		render(<HeroCardApp />)
		await waitFor(() => {
			expect(callTool).toHaveBeenCalledWith(
				'record_widget_event',
				expect.objectContaining({
					widget_name: 'hero-card',
					event: 'render_success',
					tool_name: 'get_objects',
					card_kind: 'single',
					object_type: 'bet',
					object_id: 'bet-9',
				}),
			)
		})
	})

	it('fires click_through telemetry when the CTA is clicked', async () => {
		useToolResultMock.mockReturnValue(makeBetToolResult())
		render(<HeroCardApp />)
		const cta = await screen.findByRole('link', { name: /Open in Maskin/ })
		fireEvent.click(cta)
		await waitFor(() => {
			expect(callTool).toHaveBeenCalledWith(
				'record_widget_event',
				expect.objectContaining({
					widget_name: 'hero-card',
					event: 'click_through',
					tool_name: 'get_objects',
					card_kind: 'single',
					object_type: 'bet',
					object_id: 'bet-9',
				}),
			)
		})
	})

	it('renders the compact empty state when structuredContent.heroCard.kind is empty', async () => {
		useToolResultMock.mockReturnValue({
			toolName: 'get_objects',
			workspaceId: 'ws-1',
			webAppBaseUrl: 'https://maskin.test',
			input: null,
			result: {
				content: [{ type: 'text', text: '[]' }],
				structuredContent: { heroCard: { kind: 'empty', tool: 'get_objects' } },
			},
		})
		render(<HeroCardApp />)
		await waitFor(() => expect(screen.getByText(/no results/)).toBeInTheDocument())
	})

	it('falls back to raw text when structuredContent is missing', () => {
		useToolResultMock.mockReturnValue({
			toolName: 'get_objects',
			workspaceId: 'ws-1',
			webAppBaseUrl: 'https://maskin.test',
			input: null,
			result: { content: [{ type: 'text', text: 'raw payload' }] },
		})
		render(<HeroCardApp />)
		expect(screen.getByText('raw payload')).toBeInTheDocument()
	})
})

describe('HeroCardRoot — render_error telemetry', () => {
	beforeEach(() => {
		__resetSchemaCacheForTests()
		callTool.mockReset()
		useToolResultMock.mockReset()
		callTool.mockImplementation((name) => {
			if (name === 'get_workspace_schema') return Promise.resolve(makeSchemaResponse())
			return Promise.resolve({ content: [] })
		})
	})

	it('catches a child render throw, fires record_widget_event with event: "render_error", and renders the fallback', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		const betToolResult = makeBetToolResult()
		// HeroCardRoot calls useToolResult once; HeroCardApp (the child) calls it
		// again. Returning the bet result for the outer call lets the boundary's
		// onError include the card_kind + object metadata; throwing on the inner
		// call forces componentDidCatch to fire.
		useToolResultMock
			.mockReturnValueOnce(betToolResult)
			.mockImplementationOnce(() => {
				throw new Error('boom')
			})

		render(<HeroCardRoot />)

		expect(screen.getByText(/Card failed to render/)).toBeInTheDocument()
		expect(callTool).toHaveBeenCalledWith(
			'record_widget_event',
			expect.objectContaining({
				widget_name: 'hero-card',
				event: 'render_error',
				tool_name: 'get_objects',
				card_kind: 'single',
				object_type: 'bet',
				object_id: 'bet-9',
			}),
		)

		consoleError.mockRestore()
	})
})

describe('extractHeroCard', () => {
	it('returns null when structuredContent is absent', () => {
		expect(extractHeroCard({ content: [] })).toBeNull()
	})

	it('returns null when kind is invalid', () => {
		expect(
			extractHeroCard({ structuredContent: { heroCard: { kind: 'bogus', tool: 't' } } }),
		).toBeNull()
	})

	it('returns the heroCard payload when kind is valid', () => {
		const payload = { kind: 'single', tool: 'get_objects' } as const
		expect(extractHeroCard({ structuredContent: { heroCard: payload } })).toEqual(payload)
	})
})
