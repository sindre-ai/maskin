import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DisconnectDriveModal } from '@/components/integrations/drive/disconnect-modal'
import { installDialogPolyfill } from '../../../mocks/dialog'

installDialogPolyfill()

function setup(overrides: Partial<React.ComponentProps<typeof DisconnectDriveModal>> = {}) {
	const props = {
		name: 'Kai',
		connected: ['gmail', 'google-calendar', 'google-meet', 'google-drive'],
		pending: false,
		failed: false,
		onCancel: vi.fn(),
		onConfirm: vi.fn(),
		...overrides,
	}
	render(<DisconnectDriveModal {...props} />)
	return props
}

describe('DisconnectDriveModal', () => {
	it('opens as a modal dialog on mount, labelled by its title and described by its body', () => {
		const show = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
		setup()
		expect(show).toHaveBeenCalledTimes(1)
		const dialog = screen.getByRole('dialog', { name: 'Disconnect Drive for Kai?' })
		const describedBy = dialog.getAttribute('aria-describedby')
		expect(describedBy && document.getElementById(describedBy)).toHaveTextContent(
			'Kai currently has Google connected with Gmail, Calendar, Meet and Drive. Choose how much to remove.',
		)
		show.mockRestore()
	})

	it('has three radios in a named radiogroup, Drive only preselected', () => {
		setup()
		const group = screen.getByRole('radiogroup', { name: 'Choose how much to disconnect' })
		const radios = within(group).getAllByRole('radio')
		expect(radios.map((r) => r.getAttribute('value'))).toEqual(['drive', 'drive-meet', 'google'])
		expect(radios.map((r) => (r as HTMLInputElement).checked)).toEqual([true, false, false])
	})

	it('puts the primary label in a polite live region and updates it with the radio', async () => {
		setup()
		const confirm = screen.getByRole('button', { name: 'Disconnect Drive' })
		const live = confirm.querySelector('[aria-live="polite"]')
		expect(live).toHaveTextContent('Disconnect Drive')

		await userEvent.click(screen.getByRole('radio', { name: /Disconnect Drive and Meet/ }))
		expect(live).toHaveTextContent('Disconnect Drive + Meet')
		await userEvent.click(screen.getByRole('radio', { name: /whole Google account/ }))
		expect(live).toHaveTextContent('Disconnect Google account')
	})

	it('keeps the radios in one name group so arrow keys move between them', async () => {
		setup()
		const [first] = screen.getAllByRole('radio')
		first?.focus()
		await userEvent.keyboard('{ArrowDown}')
		expect(screen.getByRole('radio', { name: /Disconnect Drive and Meet/ })).toBeChecked()
	})

	it('Escape (the dialog cancel event) closes it', () => {
		const props = setup()
		fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }))
		expect(props.onCancel).toHaveBeenCalledTimes(1)
	})

	it('a click on the backdrop closes it, a click inside does not', async () => {
		const props = setup()
		const dialog = screen.getByRole('dialog')
		await userEvent.click(screen.getByText('Choose how much to remove.', { exact: false }))
		expect(props.onCancel).not.toHaveBeenCalled()
		fireEvent.click(dialog)
		expect(props.onCancel).toHaveBeenCalledTimes(1)
	})

	it('while the revoke runs: loading state on the button, Escape and Cancel are held', () => {
		const props = setup({ pending: true })
		expect(screen.getByRole('button', { name: /Disconnect Drive/ })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
		expect(screen.getAllByRole('radio').every((r) => (r as HTMLInputElement).disabled)).toBe(true)
		const cancel = new Event('cancel', { cancelable: true })
		fireEvent(screen.getByRole('dialog'), cancel)
		expect(cancel.defaultPrevented).toBe(true)
		expect(props.onCancel).not.toHaveBeenCalled()
	})

	it('shows an alert when the disconnect failed', () => {
		setup({ failed: true })
		expect(screen.getByRole('alert')).toHaveTextContent('Could not disconnect. Try again.')
	})
})
