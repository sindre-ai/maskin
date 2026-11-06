import type { IntegrationResponse, ProviderInfo } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

// Fills the route params into the path so the test can read where the link goes.
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		to,
		params,
	}: { children: React.ReactNode; to: string; params: Record<string, string> }) => (
		<a href={to.replace(/\$(\w+)/g, (_, key: string) => params[key] ?? '')}>{children}</a>
	),
}))

let providers: ProviderInfo[] | undefined
let integrations: IntegrationResponse[] | undefined
let canGiveAccess = false
let agentTools: { mcpServers?: Record<string, unknown> } | undefined

vi.mock('@/hooks/use-integrations', () => ({
	useProviders: () => ({ data: providers }),
	useIntegrations: () => ({ data: integrations }),
}))
vi.mock('@/hooks/use-actors', () => ({ useActor: () => ({ data: { tools: agentTools } }) }))
vi.mock('@/components/chat/add-to-agent-button', () => ({
	useCanGiveAgentAccess: () => () => canGiveAccess,
}))
// The card has its own tests; here it stands in for "a row".
vi.mock('@/components/chat/integration-connect-card', () => ({
	IntegrationConnectCard: ({ provider }: { provider: string }) => (
		<div data-testid="connect-card">{provider}</div>
	),
}))

import { NeededTools } from '@/components/chat/needed-tools'

function provider(name: string, displayName: string, autoInject = false): ProviderInfo {
	return {
		name,
		displayName,
		authType: 'oauth2',
		events: [],
		mcp: {
			envKey: `${name.toUpperCase()}_TOKEN`,
			autoInject,
			server: { type: 'http', url: `https://${name}.example/mcp` },
		},
	}
}

function active(name: string, config: Record<string, unknown> = {}): IntegrationResponse {
	return { id: `i-${name}`, provider: name, status: 'active', config } as IntegrationResponse
}

function renderTools(tools: Array<{ provider: string }>) {
	return render(
		<NeededTools
			workspaceId="ws-1"
			conversationId="conv-1"
			agentId="agent-1"
			agentName="Scout"
			tools={tools}
		/>,
		{ wrapper: TestWrapper },
	)
}

describe('NeededTools', () => {
	beforeEach(() => {
		providers = [
			provider('linear', 'Linear'),
			provider('gmail', 'Gmail'),
			provider('slack', 'Slack', true),
		]
		integrations = []
		agentTools = { mcpServers: {} }
		canGiveAccess = false
	})

	it('draws nothing until providers and integrations have both loaded', () => {
		integrations = undefined
		const { container } = renderTools([{ provider: 'linear' }])
		expect(container).toBeEmptyDOMElement()
	})

	it('draws one connect row per tool in the writer order, three at most', () => {
		providers = [...(providers ?? []), provider('posthog', 'PostHog')]
		renderTools([
			{ provider: 'gmail' },
			{ provider: 'linear' },
			{ provider: 'slack' },
			{ provider: 'posthog' },
		])

		expect(screen.getAllByTestId('connect-card').map((el) => el.textContent)).toEqual([
			'gmail',
			'linear',
			'slack',
		])
		expect(screen.getByRole('heading', { name: 'Tools for this job' })).toBeInTheDocument()
	})

	it('skips a provider that is unknown', () => {
		renderTools([{ provider: 'not-a-provider' }, { provider: 'linear' }])
		expect(screen.getAllByTestId('connect-card')).toHaveLength(1)
	})

	it('links to the agent tools page when a tool is connected but the agent cannot use it', () => {
		integrations = [active('linear')]
		renderTools([{ provider: 'linear' }])

		const link = screen.getByRole('link', { name: "Set up Scout's tools →" })
		expect(link).toHaveAttribute('href', '/ws-1/agents/agent-1')
	})

	it('drops the tools-page link when the viewer can add the tool from its row', () => {
		integrations = [active('linear')]
		canGiveAccess = true
		renderTools([{ provider: 'linear' }])

		expect(screen.getByTestId('connect-card')).toBeInTheDocument()
		expect(screen.queryByRole('link')).not.toBeInTheDocument()
	})

	it('has no tools-page link while a tool is simply not connected', () => {
		renderTools([{ provider: 'linear' }])
		expect(screen.queryByRole('link')).not.toBeInTheDocument()
	})

	it('collapses into one line only when every tool is ready', () => {
		integrations = [active('gmail'), active('slack')]
		agentTools = { mcpServers: { gmail: { type: 'http', url: 'https://gmail.example/mcp' } } }
		renderTools([{ provider: 'gmail' }, { provider: 'slack' }])

		expect(screen.getByText('Connected: Gmail, Slack')).toBeInTheDocument()
		expect(screen.queryByTestId('connect-card')).not.toBeInTheDocument()
		expect(screen.queryByRole('link')).not.toBeInTheDocument()
	})

	it('keeps the rows when one tool is connected to the workspace but not the agent', () => {
		integrations = [active('slack'), active('linear')]
		renderTools([{ provider: 'slack' }, { provider: 'linear' }])

		expect(screen.queryByText(/^Connected:/)).not.toBeInTheDocument()
		expect(screen.getAllByTestId('connect-card')).toHaveLength(2)
		expect(screen.getByRole('link', { name: "Set up Scout's tools →" })).toBeInTheDocument()
	})

	it('says sharing is off for an injected provider the workspace stopped sharing', () => {
		integrations = [active('slack', { expose_to_agent_sessions: false })]
		renderTools([{ provider: 'slack' }])

		expect(
			screen.getByText(/Connected, but sharing with agents is off\. An admin can switch it on/),
		).toBeInTheDocument()
		expect(screen.queryByRole('link')).not.toBeInTheDocument()
	})
})
