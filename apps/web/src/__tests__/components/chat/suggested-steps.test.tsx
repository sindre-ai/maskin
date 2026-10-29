import { SuggestedSteps } from '@/components/chat/suggested-steps'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const STEPS = [
	{ label: 'Read my inbox', prompt: 'Read my inbox', action: 'send' as const },
	{ label: 'Draft a reply', prompt: 'Draft a reply to: ', action: 'fill' as const },
]

function renderSteps(props: Partial<React.ComponentProps<typeof SuggestedSteps>> = {}) {
	const onSendStep = vi.fn()
	const onPickStep = vi.fn()
	const view = render(
		<SuggestedSteps
			steps={STEPS}
			onSendStep={onSendStep}
			onPickStep={onPickStep}
			sending={false}
			{...props}
		/>,
	)
	return { onSendStep, onPickStep, ...view }
}

describe('SuggestedSteps', () => {
	it('names the group for screen readers and says what each tap does', () => {
		renderSteps()

		expect(screen.getByRole('group', { name: 'Suggested first steps' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Read my inbox, sends now' })).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: 'Draft a reply…, fills the message box' }),
		).toBeInTheDocument()
	})

	it('sends a send step with its index and fills nothing', async () => {
		const { onSendStep, onPickStep } = renderSteps()

		await userEvent.click(screen.getByRole('button', { name: /Read my inbox/ }))

		expect(onSendStep).toHaveBeenCalledTimes(1)
		expect(onSendStep).toHaveBeenCalledWith(STEPS[0], 0)
		expect(onPickStep).not.toHaveBeenCalled()
	})

	it('fills the box from a fill step and sends nothing', async () => {
		const { onSendStep, onPickStep } = renderSteps()

		await userEvent.click(screen.getByRole('button', { name: /Draft a reply/ }))

		expect(onPickStep).toHaveBeenCalledWith('Draft a reply to: ')
		expect(onSendStep).not.toHaveBeenCalled()
	})

	it('sends once when a send step is clicked twice in the same tick', () => {
		const { onSendStep } = renderSteps()
		const button = screen.getByRole('button', { name: /Read my inbox/ })

		fireEvent.click(button)
		fireEvent.click(button)

		expect(onSendStep).toHaveBeenCalledTimes(1)
	})

	it('lets a failed send be tapped again once the send settles', () => {
		const onSendStep = vi.fn()
		const { rerender } = render(
			<SuggestedSteps steps={STEPS} onSendStep={onSendStep} onPickStep={vi.fn()} sending={false} />,
		)
		fireEvent.click(screen.getByRole('button', { name: /Read my inbox/ }))
		rerender(
			<SuggestedSteps steps={STEPS} onSendStep={onSendStep} onPickStep={vi.fn()} sending={true} />,
		)
		rerender(
			<SuggestedSteps steps={STEPS} onSendStep={onSendStep} onPickStep={vi.fn()} sending={false} />,
		)

		fireEvent.click(screen.getByRole('button', { name: /Read my inbox/ }))

		expect(onSendStep).toHaveBeenCalledTimes(2)
	})

	it('disables the send steps while a send is pending but leaves fill steps usable', () => {
		renderSteps({ sending: true })

		expect(screen.getByRole('button', { name: /Read my inbox/ })).toBeDisabled()
		expect(screen.getByRole('button', { name: /Draft a reply/ })).toBeEnabled()
	})

	it('disables every step when the agent is not in the workspace', async () => {
		const { onSendStep, onPickStep } = renderSteps({ disabled: true })

		for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
		await userEvent.click(screen.getByRole('button', { name: /Draft a reply/ }))
		expect(onSendStep).not.toHaveBeenCalled()
		expect(onPickStep).not.toHaveBeenCalled()
	})
})
