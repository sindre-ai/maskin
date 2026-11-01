import { AgentCallButton } from '@/components/agents/agent-call-button'
import { VoiceCallHost } from '@/components/agents/voice-call-host'
import { TooltipProvider } from '@/components/ui/tooltip'
import { endVoiceCall } from '@/lib/voice-active-call'
import { markVoiceUnavailable, resetVoiceAvailability } from '@/lib/voice-availability'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

// The dialog is covered by its own suite; here it is only a presence marker.
vi.mock('@/components/agents/voice-call-dialog', () => ({
	VoiceCallDialog: ({ open, agent }: { open: boolean; agent: { name: string } }) =>
		open ? <p>Call dialog for {agent.name}</p> : null,
}))

const agent = { id: 'agent-1', name: 'Chief of Staff', type: 'agent' as const }

// VoiceCallHost owns the dialog in the app; mount it so a click has somewhere to land.
const wrap = (ui: ReactNode) =>
	render(
		<TooltipProvider>
			{ui}
			<VoiceCallHost />
		</TooltipProvider>,
	)

beforeEach(() => {
	resetVoiceAvailability()
	endVoiceCall()
})

describe('AgentCallButton', () => {
	it('row variant: a labelled Call button that opens the dialog', async () => {
		wrap(<AgentCallButton agent={agent} variant="row" shortcut={false} />)
		const button = screen.getByRole('button', { name: 'Call Chief of Staff' })
		expect(button).toHaveTextContent('Call')
		// Hover-reveal only from md up; below md it is plain inline (no opacity-0).
		expect(button.className).toContain('md:opacity-0')
		expect(button.className).not.toMatch(/(^|\s)opacity-0/)
		await userEvent.click(button)
		expect(screen.getByText('Call dialog for Chief of Staff')).toBeInTheDocument()
	})

	it('icon variant: icon-only button with the SPEC tooltip, V opens the dialog', async () => {
		wrap(<AgentCallButton agent={agent} variant="icon" />)
		const button = screen.getByRole('button', { name: 'Call Chief of Staff' })
		expect(button).toHaveTextContent('')
		await userEvent.hover(button)
		expect((await screen.findAllByText('Call Chief of Staff · V')).length).toBeGreaterThan(0)
		await userEvent.keyboard('v')
		expect(screen.getByText('Call dialog for Chief of Staff')).toBeInTheDocument()
	})

	it('row buttons leave V alone, so a list of many does not open several dialogs', async () => {
		wrap(<AgentCallButton agent={agent} variant="row" shortcut={false} />)
		await userEvent.keyboard('v')
		expect(screen.queryByText('Call dialog for Chief of Staff')).not.toBeInTheDocument()
	})

	it('disables with the SPEC tooltip after a 429, and re-enables when the window passes', async () => {
		wrap(<AgentCallButton agent={agent} variant="row" shortcut={false} />)
		expect(screen.getByRole('button', { name: 'Call Chief of Staff' })).toBeEnabled()

		act(() => markVoiceUnavailable(60))
		const button = screen.getByRole('button', { name: 'Call Chief of Staff' })
		expect(button).toBeDisabled()
		await userEvent.hover(button.parentElement as HTMLElement)
		expect(
			(await screen.findAllByText('Voice temporarily unavailable — try again in a moment.')).length,
		).toBeGreaterThan(0)

		act(() => resetVoiceAvailability())
		expect(screen.getByRole('button', { name: 'Call Chief of Staff' })).toBeEnabled()
	})
})

describe('AgentCallButton — call outlives the button', () => {
	it('keeps the call open after the button that started it unmounts', async () => {
		const { rerender } = wrap(<AgentCallButton agent={agent} variant="row" shortcut={false} />)
		await userEvent.click(screen.getByRole('button', { name: 'Call Chief of Staff' }))
		expect(screen.getByText('Call dialog for Chief of Staff')).toBeInTheDocument()

		// Navigating away unmounts the page (and its Call button); the host stays.
		rerender(
			<TooltipProvider>
				<VoiceCallHost />
			</TooltipProvider>,
		)
		expect(screen.getByText('Call dialog for Chief of Staff')).toBeInTheDocument()
	})

	it('composer variant: a round icon button that starts the call', async () => {
		wrap(<AgentCallButton agent={agent} variant="composer" shortcut={false} />)
		await userEvent.click(screen.getByRole('button', { name: 'Call Chief of Staff' }))
		expect(screen.getByText('Call dialog for Chief of Staff')).toBeInTheDocument()
	})

	it('viewer: the button is off and V does not start a call', async () => {
		render(
			<>
				<AgentCallButton agent={agent} variant="icon" />
				<VoiceCallHost />
			</>,
			{ wrapper: createWorkspaceWrapper({ role: 'viewer' }) },
		)
		expect(screen.getByRole('button', { name: 'Call Chief of Staff' })).toBeDisabled()
		await userEvent.keyboard('v')
		expect(screen.queryByText('Call dialog for Chief of Staff')).not.toBeInTheDocument()
	})
})
