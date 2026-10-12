import { ConnectWizard } from '@/components/integrations/drive/connect-wizard'
import { DRIVE_SCOPES } from '@/lib/drive-humans'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

function setup(state: 'default' | 'loading' | 'error' = 'default') {
	const onContinue = vi.fn()
	const onCancel = vi.fn()
	render(<ConnectWizard state={state} onContinue={onContinue} onCancel={onCancel} />)
	return { onContinue, onCancel }
}

describe('ConnectWizard', () => {
	it('default: title, body, three steps and the scopes callout, copy from the design spec', () => {
		setup()
		expect(
			screen.getByRole('heading', { name: 'Connect your Google account for Drive' }),
		).toBeInTheDocument()
		expect(
			screen.getByText(/Your Maskin agents will get to read files you can see/),
		).toBeInTheDocument()
		const steps = screen.getAllByRole('listitem').filter((li) => li.closest('ol'))
		expect(steps).toHaveLength(3)
		expect(steps[0]).toHaveTextContent('Sign in with Google.')
		expect(steps[1]).toHaveTextContent('Confirm the permissions.')
		expect(steps[2]).toHaveTextContent("You're done.")
		expect(screen.queryByRole('alert')).not.toBeInTheDocument()
	})

	it('drops the three-scope, optional-scope and 6 of 8 wording (v1 requests one scope)', () => {
		setup()
		const text = document.body.textContent ?? ''
		expect(text).not.toMatch(/three/i)
		expect(text).not.toMatch(/optional/i)
		expect(text).not.toMatch(/6 of 8/)
		expect(text).not.toMatch(/same grant/i)
		expect(text).toMatch(/same Google account/)
	})

	it('lists one scope row per requested scope', () => {
		setup()
		const callout = screen.getByText('Permissions this adds to your Google account:').parentElement
		expect(callout).not.toBeNull()
		expect(within(callout as HTMLElement).getAllByRole('listitem')).toHaveLength(
			DRIVE_SCOPES.length,
		)
		expect(within(callout as HTMLElement).getByText('Edit & comment on any file')).toBeVisible()
	})

	it('default: Continue starts the connect and Cancel backs out', async () => {
		const { onContinue, onCancel } = setup()
		await userEvent.click(screen.getByRole('button', { name: 'Continue with Google →' }))
		expect(onContinue).toHaveBeenCalledTimes(1)
		await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		expect(onCancel).toHaveBeenCalledTimes(1)
	})

	it('loading: Opening Google…, both buttons disabled', () => {
		setup('loading')
		const primary = screen.getByRole('button', { name: 'Opening Google…' })
		expect(primary).toBeDisabled()
		expect(primary).toHaveAttribute('aria-busy', 'true')
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
	})

	it('error: announces the cancelled sign-in and keeps Continue enabled', () => {
		setup('error')
		expect(screen.getByRole('alert')).toHaveTextContent(
			'Sign-in was cancelled. Try again when ready.',
		)
		expect(screen.getByRole('button', { name: 'Continue with Google →' })).toBeEnabled()
	})

	it('footer buttons are reachable by keyboard in order', async () => {
		setup()
		await userEvent.tab()
		expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
		await userEvent.tab()
		expect(screen.getByRole('button', { name: 'Continue with Google →' })).toHaveFocus()
	})

	it('icons are decorative', () => {
		setup()
		const img = document.querySelector('img')
		expect(img).toHaveAttribute('aria-hidden', 'true')
		expect(img).toHaveAttribute('alt', '')
	})
})
