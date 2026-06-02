import { __resetSchemaCacheForTests } from '@/mcp-apps/shared/use-workspace-schema'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

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

function makeListSchemaResponse() {
	return {
		content: [
			{
				type: 'text',
				text: JSON.stringify({
					workspace_id: 'ws-1',
					workspace_name: 'Test',
					relationship_types: [],
					types: {
						bet: { display_name: 'Bet', statuses: ['active', 'shaping'], fields: [] },
						actor: { display_name: 'Actor', statuses: [], fields: [] },
					},
				}),
			},
		],
	}
}

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

function makeListToolResult(
	tool: string,
	objects: Array<{
		id: string
		type: string
		title: string | null
		status: string | null
		owner: { id: string; name: string | null } | null
		contextLine: string
	}>,
) {
	return {
		toolName: tool,
		workspaceId: 'ws-1',
		webAppBaseUrl: 'https://maskin.test',
		input: null,
		result: {
			content: [{ type: 'text', text: '[]' }],
			structuredContent: {
				heroCard: {
					kind: 'list',
					tool,
					objects,
					totalCount: objects.length,
				},
			},
		},
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

describe('HeroCardApp — list envelope', () => {
	beforeEach(() => {
		__resetSchemaCacheForTests()
		callTool.mockReset()
		useToolResultMock.mockReset()
		callTool.mockImplementation((name) => {
			if (name === 'get_workspace_schema') return Promise.resolve(makeListSchemaResponse())
			return Promise.resolve({ content: [] })
		})
	})

	const betRows = [
		{
			id: 'bet-1',
			type: 'bet',
			title: 'Alpha launch',
			status: 'active',
			owner: { id: 'a-1', name: 'Sebastian' },
			contextLine: 'active · 6-week bet',
		},
		{
			id: 'bet-2',
			type: 'bet',
			title: 'Beta polish',
			status: 'shaping',
			owner: { id: 'a-2', name: 'Magnus' },
			contextLine: 'shaping · 4-week bet',
		},
		{
			id: 'bet-3',
			type: 'bet',
			title: 'Gamma test',
			status: 'active',
			owner: { id: 'a-1', name: 'Sebastian' },
			contextLine: 'active · 6-week bet',
		},
		{
			id: 'bet-4',
			type: 'bet',
			title: 'Delta roll-out',
			status: 'shaping',
			owner: { id: 'a-3', name: 'Anders' },
			contextLine: 'shaping · 2-week bet',
		},
		{
			id: 'bet-5',
			type: 'bet',
			title: 'Epsilon revisit',
			status: 'active',
			owner: { id: 'a-2', name: 'Magnus' },
			contextLine: 'active · 6-week bet',
		},
	]

	const actorRows = [
		{
			id: 'actor-1',
			type: 'actor',
			title: 'Designer',
			status: 'agent',
			owner: null,
			contextLine: 'agent · admin',
		},
		{
			id: 'actor-2',
			type: 'actor',
			title: 'Workspace Observer',
			status: 'agent',
			owner: null,
			contextLine: 'agent · member',
		},
		{
			id: 'actor-3',
			type: 'actor',
			title: 'Pricing Analyst',
			status: 'agent',
			owner: null,
			contextLine: 'agent · member',
		},
		{
			id: 'actor-4',
			type: 'actor',
			title: 'Onboarding',
			status: 'agent',
			owner: null,
			contextLine: 'agent · member',
		},
		{
			id: 'actor-5',
			type: 'actor',
			title: 'Retention',
			status: 'agent',
			owner: null,
			contextLine: 'agent · member',
		},
	]

	it('collapses kind:single to the existing hero card (N=1 branch)', async () => {
		useToolResultMock.mockReturnValue(makeBetToolResult())
		render(<HeroCardApp />)
		await waitFor(() =>
			expect(screen.getByText('Best-in-class MCP widget UX for Maskin')).toBeInTheDocument(),
		)
		// No list envelope header in single mode.
		expect(screen.queryByText('Bets')).not.toBeInTheDocument()
	})

	it('renders the empty-state for kind:empty (N=0 branch)', async () => {
		useToolResultMock.mockReturnValue({
			toolName: 'list_objects',
			workspaceId: 'ws-1',
			webAppBaseUrl: 'https://maskin.test',
			input: null,
			result: {
				content: [{ type: 'text', text: '[]' }],
				structuredContent: { heroCard: { kind: 'empty', tool: 'list_objects' } },
			},
		})
		render(<HeroCardApp />)
		await waitFor(() => expect(screen.getByText(/no results/)).toBeInTheDocument())
		expect(screen.getByText('list_objects')).toBeInTheDocument()
	})

	it('renders the list envelope with header, up to 4 visible bet rows, and +N more footer for N=5', async () => {
		useToolResultMock.mockReturnValue(makeListToolResult('list_objects', betRows))
		render(<HeroCardApp />)
		await waitFor(() => expect(screen.getByText('Bets')).toBeInTheDocument())
		expect(screen.getByText('5')).toBeInTheDocument()
		// Sort defaults to title ascending → Alpha, Beta, Delta, Epsilon visible;
		// Gamma is below the fold.
		expect(screen.getByText('Alpha launch')).toBeInTheDocument()
		expect(screen.getByText('Beta polish')).toBeInTheDocument()
		expect(screen.getByText('Delta roll-out')).toBeInTheDocument()
		expect(screen.getByText('Epsilon revisit')).toBeInTheDocument()
		expect(screen.queryByText('Gamma test')).not.toBeInTheDocument()
		expect(screen.getByText('+1 more')).toBeInTheDocument()
		const cta = screen.getByRole('link', { name: /Open in Maskin/ })
		expect(cta).toHaveAttribute('href', 'https://maskin.test/ws-1/objects?type=bet')
	})

	it('reorders rows by status when the sort control changes', async () => {
		useToolResultMock.mockReturnValue(makeListToolResult('list_objects', betRows))
		render(<HeroCardApp />)
		await waitFor(() => expect(screen.getByText('Bets')).toBeInTheDocument())
		const sortSelect = screen.getByRole('combobox', { name: /Sort rows/ })
		await act(async () => {
			fireEvent.change(sortSelect, { target: { value: 'status' } })
		})
		// active rows come before shaping (a < s); within ties insertion order
		// is preserved by Array.prototype.sort being stable in modern Node.
		const rowNames = screen.getAllByRole('link').map((a) => a.textContent ?? '')
		const firstFour = rowNames.filter(
			(t) =>
				t.includes('launch') ||
				t.includes('test') ||
				t.includes('polish') ||
				t.includes('roll-out') ||
				t.includes('revisit'),
		)
		expect(firstFour[0]).toContain('Alpha launch') // active
		expect(firstFour[1]).toContain('Gamma test') // active
		expect(firstFour[2]).toContain('Epsilon revisit') // active
		expect(firstFour[3]).toContain('Beta polish') // shaping
	})

	it('narrows rows when the filter input changes (filter-and-show behaviour)', async () => {
		useToolResultMock.mockReturnValue(makeListToolResult('list_objects', betRows))
		render(<HeroCardApp />)
		await waitFor(() => expect(screen.getByText('Bets')).toBeInTheDocument())
		const filterInput = screen.getByRole('textbox', { name: /Filter rows/ })
		await act(async () => {
			fireEvent.change(filterInput, { target: { value: 'gamma' } })
		})
		expect(screen.getByText('Gamma test')).toBeInTheDocument()
		expect(screen.queryByText('Alpha launch')).not.toBeInTheDocument()
		expect(screen.getByText(/1 of 5 shown/)).toBeInTheDocument()
	})

	it('renders the list envelope for list_actors (different type) and routes CTA to /agents', async () => {
		useToolResultMock.mockReturnValue(makeListToolResult('list_actors', actorRows))
		render(<HeroCardApp />)
		await waitFor(() => expect(screen.getByText('Actors')).toBeInTheDocument())
		const rows = screen
			.getAllByRole('link')
			.filter((a) => /actor/.test(a.getAttribute('href') ?? ''))
		expect(rows).toHaveLength(4) // 4 visible rows out of 5
		expect(rows[0]).toHaveAttribute('href', expect.stringMatching(/\/ws-1\/agents\/actor-\d/))
		expect(screen.getByText('+1 more')).toBeInTheDocument()
		const cta = screen.getByRole('link', { name: /Open in Maskin/ })
		expect(cta).toHaveAttribute('href', 'https://maskin.test/ws-1/agents')
	})

	it('fires click_through telemetry on the footer CTA with card_kind:list', async () => {
		useToolResultMock.mockReturnValue(makeListToolResult('list_objects', betRows))
		render(<HeroCardApp />)
		await waitFor(() => expect(screen.getByText('Bets')).toBeInTheDocument())
		const cta = screen.getByRole('link', { name: /Open in Maskin/ })
		fireEvent.click(cta)
		await waitFor(() => {
			expect(callTool).toHaveBeenCalledWith(
				'record_widget_event',
				expect.objectContaining({
					widget_name: 'hero-card',
					event: 'click_through',
					tool_name: 'list_objects',
					card_kind: 'list',
				}),
			)
		})
	})

	it('hides sort+filter controls when totalCount ≤ MAX_VISIBLE_ROWS (no need)', async () => {
		useToolResultMock.mockReturnValue(makeListToolResult('list_objects', betRows.slice(0, 3)))
		render(<HeroCardApp />)
		await waitFor(() => expect(screen.getByText('Bets')).toBeInTheDocument())
		expect(screen.queryByRole('textbox', { name: /Filter rows/ })).not.toBeInTheDocument()
		expect(screen.queryByRole('combobox', { name: /Sort rows/ })).not.toBeInTheDocument()
	})
})

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
				contextLine: 'enabled · 0 0 * * * (UTC) · next in 6h',
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
		useToolResultMock.mockReturnValueOnce(betToolResult).mockImplementationOnce(() => {
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
