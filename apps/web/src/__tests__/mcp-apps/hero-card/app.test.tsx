import { __resetSchemaCacheForTests } from '@/mcp-apps/shared/use-workspace-schema'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const callTool = vi.fn()
const useToolResultMock = vi.fn()

vi.mock('@/mcp-apps/shared/mcp-app-provider', () => ({
	useCallTool: () => callTool,
	useToolResult: () => useToolResultMock(),
	useWebAppContext: () => ({ baseUrl: 'https://maskin.test', workspaceId: 'ws-1' }),
}))

import { HeroCardApp, extractHeroCard } from '@/mcp-apps/hero-card/app'

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

function makeToolResult(object: {
	id: string
	type: string
	title: string
	status: string
	owner: { id: string; name: string } | null
	contextLine: string
}) {
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
					object,
				},
			},
		},
	}
}

function makeMultiTypeSchemaResponse() {
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
						task: { display_name: 'Task', statuses: ['in_progress'], fields: [] },
						insight: { display_name: 'Insight', statuses: ['clustered'], fields: [] },
						trigger: { display_name: 'Trigger', statuses: ['enabled'], fields: [] },
					},
				}),
			},
		],
	}
}

// Customer variant — both `organization` and `person` render through the
// same widget code as `bet`, driven purely by structuredContent + schema. A
// hypothetical future `customer` type with the same annotation shape would
// reach the widget through the same path with no widget edit.
function makeCustomerToolResult(
	type: 'organization' | 'person' | 'customer',
	overrides: Partial<{ title: string; status: string; contextLine: string; id: string }> = {},
) {
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
						id: overrides.id ?? `${type}-1`,
						type,
						title: overrides.title ?? 'Acme Co',
						status: overrides.status ?? 'qualifying',
						owner: { id: 'actor-1', name: 'Sebastian' },
						contextLine: overrides.contextLine ?? 'last touch 3d ago · qualifying',
					},
				},
			},
		},
	}
}

describe('HeroCardApp — schema-driven render per type', () => {
	beforeEach(() => {
		__resetSchemaCacheForTests()
		callTool.mockReset()
		useToolResultMock.mockReset()
		callTool.mockImplementation((name) => {
			if (name === 'get_workspace_schema') return Promise.resolve(makeMultiTypeSchemaResponse())
			return Promise.resolve({ content: [] })
		})
	})

	const cases = [
		{
			label: 'task',
			object: {
				id: 'task-9',
				type: 'task',
				title: 'Write tests',
				status: 'in_progress',
				owner: { id: 'actor-2', name: 'Magnus' },
				contextLine: 'in_progress · owner Magnus',
			},
			expectedTypeLabel: 'Task',
			expectedOwner: 'Owner: Magnus',
		},
		{
			label: 'insight',
			object: {
				id: 'insight-7',
				type: 'insight',
				title: 'Pricing pain',
				status: 'clustered',
				owner: null,
				contextLine: 'clustered · anchor #3+#6 · 4 sources',
			},
			expectedTypeLabel: 'Insight',
			expectedOwner: null,
		},
		{
			label: 'trigger',
			object: {
				id: 'trig-1',
				type: 'trigger',
				title: 'Nightly sweep',
				status: 'enabled',
				owner: { id: 'actor-3', name: 'Observer' },
				contextLine: 'enabled · 0 0 * * * · next in 6h',
			},
			expectedTypeLabel: 'Trigger',
			expectedOwner: 'Owner: Observer',
		},
	] as const

	for (const c of cases) {
		it(`renders the ${c.label} variant from structuredContent + schema with no widget code changes`, async () => {
			useToolResultMock.mockReturnValue(makeToolResult(c.object))
			const { container } = render(<HeroCardApp />)

			await waitFor(() => {
				expect(screen.getByText(c.expectedTypeLabel)).toBeInTheDocument()
			})

			expect(screen.getByText(c.object.title)).toBeInTheDocument()
			expect(screen.getByText(c.object.status)).toBeInTheDocument()
			expect(screen.getByText(c.object.contextLine)).toBeInTheDocument()

			if (c.expectedOwner) {
				expect(screen.getByText(c.expectedOwner)).toBeInTheDocument()
			} else {
				expect(screen.queryByText(/^Owner:/)).toBeNull()
			}

			const cta = screen.getByRole('link', { name: /Open in Maskin/ })
			expect(cta).toHaveAttribute('href', `https://maskin.test/ws-1/objects/${c.object.id}`)

			expect(container.firstChild).toMatchSnapshot()
		})
	}
})

describe('HeroCardApp — customer variant (organization + person + new type parity)', () => {
	beforeEach(() => {
		__resetSchemaCacheForTests()
		callTool.mockReset()
		useToolResultMock.mockReset()
		callTool.mockImplementation((name) => {
			if (name === 'get_workspace_schema') {
				return Promise.resolve({
					content: [
						{
							type: 'text',
							text: JSON.stringify({
								workspace_id: 'ws-1',
								workspace_name: 'Test',
								relationship_types: [],
								types: {
									organization: { display_name: 'Organization', statuses: [], fields: [] },
									person: { display_name: 'Person', statuses: [], fields: [] },
									customer: { display_name: 'Customer', statuses: [], fields: [] },
								},
							}),
						},
					],
				})
			}
			return Promise.resolve({ content: [] })
		})
	})

	it('renders an organization without any widget code changes', async () => {
		useToolResultMock.mockReturnValue(makeCustomerToolResult('organization'))
		render(<HeroCardApp />)
		await waitFor(() => expect(screen.getByText('Acme Co')).toBeInTheDocument())
		expect(screen.getByText('last touch 3d ago · qualifying')).toBeInTheDocument()
		expect(screen.getByText('Organization')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Open in Maskin/ })).toHaveAttribute(
			'href',
			'https://maskin.test/ws-1/objects/organization-1',
		)
	})

	it('renders a person via the same widget code path', async () => {
		useToolResultMock.mockReturnValue(
			makeCustomerToolResult('person', {
				id: 'person-1',
				title: 'Jane Doe',
				status: 'engaged',
				contextLine: 'last touch 1d ago · engaged',
			}),
		)
		render(<HeroCardApp />)
		await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument())
		expect(screen.getByText('last touch 1d ago · engaged')).toBeInTheDocument()
		expect(screen.getByText('Person')).toBeInTheDocument()
	})

	it('renders a hypothetical new object type (e.g. `customer`) identically given the same payload shape', async () => {
		useToolResultMock.mockReturnValue(
			makeCustomerToolResult('customer', {
				id: 'customer-1',
				title: 'Hypothetical Customer',
			}),
		)
		render(<HeroCardApp />)
		// Same surface: title, context line, schema-driven type label, CTA — no per-type widget branch.
		await waitFor(() => expect(screen.getByText('Hypothetical Customer')).toBeInTheDocument())
		expect(screen.getByText('last touch 3d ago · qualifying')).toBeInTheDocument()
		expect(screen.getByText('Customer')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Open in Maskin/ })).toHaveAttribute(
			'href',
			'https://maskin.test/ws-1/objects/customer-1',
		)
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
