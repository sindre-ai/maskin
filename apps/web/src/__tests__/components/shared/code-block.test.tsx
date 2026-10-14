import { CodeBlock } from '@/components/shared/code-block'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { success } = vi.hoisted(() => ({ success: vi.fn() }))

vi.mock('sonner', () => ({
	toast: { success },
}))

describe('CodeBlock', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders the label and the text', () => {
		render(<CodeBlock label="Terminal" text="echo hi" toastMessage="Copied" />)
		expect(screen.getByText('Terminal')).toBeInTheDocument()
		expect(screen.getByText('echo hi')).toBeInTheDocument()
	})

	it('copies the text, flips to Copied, toasts, and calls onCopy', async () => {
		const user = userEvent.setup()
		const onCopy = vi.fn()
		render(<CodeBlock label="Terminal" text="echo hi" toastMessage="Copied it" onCopy={onCopy} />)

		await user.click(screen.getByRole('button', { name: 'Copy' }))

		expect(await navigator.clipboard.readText()).toBe('echo hi')
		expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
		expect(success).toHaveBeenCalledWith('Copied it')
		expect(onCopy).toHaveBeenCalledTimes(1)
	})

	it('does not copy when Copy is disabled', async () => {
		const user = userEvent.setup()
		const onCopy = vi.fn()
		render(
			<CodeBlock label="Terminal" text="echo hi" toastMessage="x" copyDisabled onCopy={onCopy} />,
		)

		await user.click(screen.getByRole('button', { name: 'Copy' }))

		expect(onCopy).not.toHaveBeenCalled()
		expect(success).not.toHaveBeenCalled()
	})

	it('keeps a file-name label in its written case', () => {
		render(<CodeBlock label="~/.cursor/mcp.json" fileName text="{}" toastMessage="x" />)
		expect(screen.getByText('~/.cursor/mcp.json').className).toContain('normal-case!')
	})

	it('leaves a plain-word label to the uppercase eyebrow style', () => {
		render(<CodeBlock label="Headers" text="a: b" toastMessage="x" />)
		expect(screen.getByText('Headers').className).not.toContain('normal-case!')
	})
})
