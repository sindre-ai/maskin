import { TriggerRow } from '@/components/triggers/trigger-row'
import type { TriggerResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const navigateSpy = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		params,
		children,
		...rest
	}: {
		to: string
		params?: Record<string, string>
		children: React.ReactNode
		[key: string]: unknown
	}) => {
		let href = to
		for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, v)
		return (
			<a href={href} onClick={() => navigateSpy(href)} {...rest}>
				{children}
			</a>
		)
	},
}))

function buildTrigger(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
	return {
		id: 't-1',
		workspaceId: 'ws-1',
		name: 'Nightly sweep',
		type: 'cron',
		targetActorId: 'actor-1',
		config: { expression: '0 3 * * *' },
		enabled: true,
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: '2026-08-04T00:00:00.000Z',
		...overrides,
	} as TriggerResponse
}

describe('TriggerRow', () => {
	it('renders the glyph tile, plain-language description, agent and state label', () => {
		render(<TriggerRow trigger={buildTrigger()} workspaceId="ws-1" agentName="Compass" />)

		expect(screen.getByText('Nightly sweep')).toBeInTheDocument()
		expect(screen.getByText(/^Runs /)).toBeInTheDocument()
		expect(screen.getByText('Compass')).toBeInTheDocument()
		expect(screen.getByText('On')).toBeInTheDocument()
	})

	it('reads "Off" for a disabled trigger', () => {
		render(
			<TriggerRow trigger={buildTrigger({ enabled: false })} workspaceId="ws-1" agentName="C" />,
		)
		expect(screen.getByText('Off')).toBeInTheDocument()
	})

	it('links the whole row to trigger detail', () => {
		render(<TriggerRow trigger={buildTrigger()} workspaceId="ws-1" agentName="Compass" />)
		expect(screen.getByRole('link', { name: /open nightly sweep/i })).toHaveAttribute(
			'href',
			'/ws-1/triggers/t-1',
		)
	})

	it('fires onToggleEnabled from the inline switch without navigating', async () => {
		const user = userEvent.setup()
		const onToggleEnabled = vi.fn()
		navigateSpy.mockClear()
		render(
			<TriggerRow
				trigger={buildTrigger()}
				workspaceId="ws-1"
				agentName="Compass"
				onToggleEnabled={onToggleEnabled}
			/>,
		)

		await user.click(screen.getByRole('switch', { name: 'Disable Nightly sweep' }))

		expect(onToggleEnabled).toHaveBeenCalledWith(false)
		expect(navigateSpy).not.toHaveBeenCalled()
	})

	it('omits the switch entirely when there is nothing to wire it to', () => {
		render(<TriggerRow trigger={buildTrigger()} workspaceId="ws-1" agentName="Compass" />)
		expect(screen.queryByRole('switch')).not.toBeInTheDocument()
	})
})
