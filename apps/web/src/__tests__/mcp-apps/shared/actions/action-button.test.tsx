import { ActionButton } from '@/mcp-apps/shared/actions'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

describe('ActionButton', () => {
	it('fires immediately for non-confirm mutations', async () => {
		const onRun = vi.fn().mockResolvedValue({ success: true })
		render(<ActionButton kind="object_status" onRun={onRun} label="Mark done" />)
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Mark done' }))
		})
		expect(onRun).toHaveBeenCalledTimes(1)
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
	})

	it('opens a confirmation dialog before firing destructive mutations', async () => {
		const onRun = vi.fn().mockResolvedValue({ success: true })
		render(<ActionButton kind="object_delete" onRun={onRun} />)

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
		})
		expect(onRun).not.toHaveBeenCalled()
		const dialog = await screen.findByRole('dialog')
		expect(dialog).toBeInTheDocument()
		expect(screen.getByText(/Delete this object/i)).toBeInTheDocument()

		await act(async () => {
			fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
		})
		await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1))
	})

	it('does not fire when the user cancels', async () => {
		const onRun = vi.fn()
		render(<ActionButton kind="object_delete" onRun={onRun} />)
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
		})
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		})
		expect(onRun).not.toHaveBeenCalled()
	})

	it('renders inline error text when provided', () => {
		render(<ActionButton kind="object_status" onRun={() => undefined} error="permission denied" />)
		expect(screen.getByText('permission denied')).toBeInTheDocument()
	})
})
