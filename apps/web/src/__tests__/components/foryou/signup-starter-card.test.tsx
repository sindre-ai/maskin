import type { ComposerProps } from '@/components/chat/chat'
import { SignupStarterCard } from '@/components/foryou/signup-starter-card'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const openWithContextMock = vi.fn()
const useActorsMock = vi.fn()

vi.mock('@/lib/chat-context', () => ({
	useChat: () => ({ openWithContext: openWithContextMock }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: (workspaceId?: string) => useActorsMock(workspaceId),
}))

// Minimal Composer stub — the real component's Enter/slash-picker behaviour
// is covered by chat's own tests. Here we care about the submit call shape.
vi.mock('@/components/chat/chat', () => ({
	Composer: ({ onSend, textareaLabel, placeholder }: ComposerProps) => {
		const [value, setValue] = useState('')
		return (
			<form
				onSubmit={(e) => {
					e.preventDefault()
					if (!value.trim()) return
					void onSend(value).then(() => setValue(''))
				}}
			>
				<textarea
					aria-label={textareaLabel}
					placeholder={placeholder}
					value={value}
					onChange={(e) => setValue(e.target.value)}
				/>
				<button type="submit" aria-label="Send message" disabled={!value.trim()} />
			</form>
		)
	},
}))

describe('SignupStarterCard', () => {
	beforeEach(() => {
		openWithContextMock.mockReset()
		openWithContextMock.mockResolvedValue(undefined)
		useActorsMock.mockReset()
	})

	it('renders the Strategist bubble and reply input', () => {
		useActorsMock.mockReturnValue({ data: [] })
		render(<SignupStarterCard workspaceId="ws-1" />)
		expect(screen.getByText('Strategist')).toBeInTheDocument()
		expect(screen.getByText('What would you like to create?')).toBeInTheDocument()
		expect(screen.getByLabelText('Reply to the Strategist')).toBeInTheDocument()
	})

	it('submit attaches the seeded Strategist actor and stages the message', async () => {
		const user = userEvent.setup()
		useActorsMock.mockReturnValue({
			data: [
				{ id: 'agent-strategist-1', name: 'Strategist', type: 'agent' },
				{ id: 'agent-other-1', name: 'Other', type: 'agent' },
			],
		})
		render(<SignupStarterCard workspaceId="ws-1" />)

		await user.type(screen.getByLabelText('Reply to the Strategist'), 'Plan my launch')
		await user.click(screen.getByLabelText('Send message'))

		await waitFor(() => expect(openWithContextMock).toHaveBeenCalledTimes(1))
		expect(openWithContextMock).toHaveBeenCalledWith(
			[{ kind: 'agent', id: 'agent-strategist-1', name: 'Strategist' }],
			'Plan my launch',
		)
	})

	it('falls back to no agent attachment when the Strategist is not seeded', async () => {
		const user = userEvent.setup()
		useActorsMock.mockReturnValue({ data: [{ id: 'a-1', name: 'Other', type: 'agent' }] })
		render(<SignupStarterCard workspaceId="ws-1" />)

		await user.type(screen.getByLabelText('Reply to the Strategist'), 'Hello')
		await user.click(screen.getByLabelText('Send message'))

		await waitFor(() => expect(openWithContextMock).toHaveBeenCalledTimes(1))
		expect(openWithContextMock).toHaveBeenCalledWith([], 'Hello')
	})
})
