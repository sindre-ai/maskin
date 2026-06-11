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
						driver: { id: 'actor-1', name: 'Sebastian', type: 'human' },
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
		expect(screen.getByText('Driver: Sebastian')).toBeInTheDocument()
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

	it('links a single actor card to the agent detail page', async () => {
		useToolResultMock.mockReturnValue({
			toolName: 'get_actor',
			workspaceId: 'ws-1',
			webAppBaseUrl: 'https://maskin.test',
			input: null,
			result: {
				content: [{ type: 'text', text: '[]' }],
				structuredContent: {
					heroCard: {
						kind: 'single',
						tool: 'get_actor',
						object: {
							id: 'actor-1',
							type: 'actor',
							title: 'Designer',
							status: 'running',
							driver: null,
							contextLine: 'Mocking up MCP widget directions',
						},
					},
				},
			},
		})
		render(<HeroCardApp />)
		const card = await screen.findByRole('link', { name: /Designer/ })
		expect(card).toHaveAttribute('href', 'https://maskin.test/ws-1/agents/actor-1')
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
	driver: { id: string; name: string; type: string } | null
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
	totalCount = objects.length,
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
					totalCount,
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
						driver: { id: 'actor-1', name: 'Sebastian', type: 'human' },
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
		expect(screen.getByText('Alpha launch')).toBeInTheDocument()
		expect(screen.getByText('Beta polish')).toBeInTheDocument()
		expect(screen.getByText('Gamma test')).toBeInTheDocument()
		expect(screen.getByText('Delta roll-out')).toBeInTheDocument()
		expect(screen.queryByText('Epsilon revisit')).not.toBeInTheDocument()
		expect(screen.getByText('+1 more')).toBeInTheDocument()
		expect(screen.queryByRole('textbox', { name: /Filter rows/ })).not.toBeInTheDocument()
		expect(screen.queryByRole('combobox', { name: /Sort rows/ })).not.toBeInTheDocument()
		const cta = screen.getByRole('link', { name: /Open in Maskin/ })
		expect(cta).toHaveAttribute('href', 'https://maskin.test/ws-1/objects?type=bet')
	})

	it('uses server totalCount in the +N more footer when only one page is loaded', async () => {
		useToolResultMock.mockReturnValue(makeListToolResult('list_objects', betRows.slice(0, 1), 1234))
		render(<HeroCardApp />)
		await waitFor(() => expect(screen.getByText('Bets')).toBeInTheDocument())
		expect(screen.getByText('+1233 more')).toBeInTheDocument()
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

	it('renders the list_workspaces envelope and links rows to their workspace roots', async () => {
		useToolResultMock.mockReturnValue(
			makeListToolResult('list_workspaces', [
				{
					id: 'ws-1',
					type: 'workspace',
					title: 'Maskin',
					status: 'owner',
					owner: null,
					contextLine: 'workspace · 4m ago',
				},
				{
					id: 'ws-2',
					type: 'workspace',
					title: 'Reflect Studio',
					status: 'member',
					owner: null,
					contextLine: 'workspace · 1h ago',
				},
			]),
		)
		render(<HeroCardApp />)
		await waitFor(() => expect(screen.getByText('Workspaces')).toBeInTheDocument())
		expect(screen.getByText('2')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /^M\s*Maskin/ })).toHaveAttribute(
			'href',
			'https://maskin.test/ws-1',
		)
		expect(screen.getByRole('link', { name: /Reflect Studio/ })).toHaveAttribute(
			'href',
			'https://maskin.test/ws-2',
		)
		const cta = screen.getByRole('link', { name: /Open in Maskin/ })
		expect(cta).toHaveAttribute('href', 'https://maskin.test/ws-1')
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

	it('keeps the list compact when totalCount ≤ MAX_VISIBLE_ROWS', async () => {
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
				driver: { id: 'actor-2', name: 'Magnus', type: 'human' },
				contextLine: 'in_progress · driver Magnus',
			},
			expectedTypeLabel: 'Task',
			expectedDriver: 'Driver: Magnus',
		},
		{
			label: 'insight',
			object: {
				id: 'insight-7',
				type: 'insight',
				title: 'Pricing pain',
				status: 'clustered',
				driver: null,
				contextLine: 'clustered · anchor #3+#6 · 4 sources',
			},
			expectedTypeLabel: 'Insight',
			expectedDriver: null,
		},
		{
			label: 'trigger',
			object: {
				id: 'trig-1',
				type: 'trigger',
				title: 'Nightly sweep',
				status: 'enabled',
				driver: { id: 'actor-3', name: 'Observer', type: 'human' },
				contextLine: 'enabled · 0 0 * * * (UTC) · next in 6h',
			},
			expectedTypeLabel: 'Trigger',
			expectedDriver: 'Driver: Observer',
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

			if (c.expectedDriver) {
				expect(screen.getByText(c.expectedDriver)).toBeInTheDocument()
			} else {
				expect(screen.queryByText(/^Driver:/)).toBeNull()
			}

			const cta = screen.getByRole('link', { name: /Open in Maskin/ })
			expect(cta).toHaveAttribute(
				'href',
				c.label === 'trigger'
					? `https://maskin.test/ws-1/triggers/${c.object.id}`
					: `https://maskin.test/ws-1/objects/${c.object.id}`,
			)

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
		await waitFor(() => expect(screen.getByText('Organization')).toBeInTheDocument())
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
		await waitFor(() => expect(screen.getByText('Person')).toBeInTheDocument())
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

describe('HeroCardSingle — driver type pill', () => {
	beforeEach(() => {
		__resetSchemaCacheForTests()
		callTool.mockReset()
		useToolResultMock.mockReset()
		callTool.mockImplementation((name) => {
			if (name === 'get_workspace_schema') return Promise.resolve(makeSchemaResponse())
			return Promise.resolve({ content: [] })
		})
	})

	function makeDriverSingleResult(driver: { id: string; name: string; type: string } | null) {
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
							id: 'bet-1',
							type: 'bet',
							title: 'Test bet',
							status: 'active',
							driver,
							contextLine: 'active',
						},
					},
				},
			},
		}
	}

	it('renders an amber pill when driver.type is not "agent" (human driver)', async () => {
		useToolResultMock.mockReturnValue(
			makeDriverSingleResult({ id: 'human-1', name: 'Sebastian', type: 'human' }),
		)
		render(<HeroCardApp />)
		const pill = await screen.findByText('Driver: Sebastian')
		expect(pill.closest('span')).toHaveClass('bg-amber-100')
		expect(pill.closest('span')).toHaveClass('text-amber-800')
	})

	it('renders muted text without amber pill when driver.type is "agent"', async () => {
		useToolResultMock.mockReturnValue(
			makeDriverSingleResult({ id: 'agent-1', name: 'Strategist', type: 'agent' }),
		)
		render(<HeroCardApp />)
		const span = await screen.findByText('Driver: Strategist')
		expect(span).toHaveClass('text-muted-foreground')
		expect(span).not.toHaveClass('bg-amber-100')
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
		let calls = 0
		useToolResultMock.mockImplementation(() => {
			calls += 1
			if (calls % 2 === 0) {
				throw new Error('boom')
			}
			return betToolResult
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
