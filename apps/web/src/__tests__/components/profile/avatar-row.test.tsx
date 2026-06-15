import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: {
			...actual.api,
			actors: { ...actual.api.actors, uploadAvatar: vi.fn() },
		},
	}
})

vi.mock('@/lib/analytics', () => ({
	trackProfileFieldUpdated: vi.fn(),
}))

vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}))

import { AvatarRow } from '@/components/profile/avatar-row'
import { trackProfileFieldUpdated } from '@/lib/analytics'
import { ApiError, api } from '@/lib/api'
import { toast } from 'sonner'
import { buildActorResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const actor = buildActorResponse({ id: 'actor-1', name: 'Alice', type: 'human' })

function renderRow() {
	return render(<AvatarRow actor={actor} />, { wrapper: TestWrapper })
}

function makeFile(name: string, type: string, size = 100) {
	const blob = new Blob([new Uint8Array(size)], { type })
	return new File([blob], name, { type })
}

async function openDialog() {
	fireEvent.click(screen.getByRole('button', { name: /upload avatar/i }))
	await screen.findByRole('dialog')
}

beforeEach(() => {
	vi.clearAllMocks()
	// jsdom 22 ships URL.createObjectURL via this stub
	if (!URL.createObjectURL) {
		URL.createObjectURL = vi.fn(() => 'blob:mock')
	}
	if (!URL.revokeObjectURL) {
		URL.revokeObjectURL = vi.fn()
	}
})

describe('AvatarRow', () => {
	it('renders the row with the initial fallback and an Upload button', () => {
		renderRow()
		expect(screen.getByText('Avatar')).toBeInTheDocument()
		// ActorAvatar renders the uppercased first character
		expect(screen.getByTitle('Alice')).toHaveTextContent('A')
		expect(screen.getByRole('button', { name: /upload avatar/i })).toBeInTheDocument()
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
	})

	it('keeps Save disabled until a valid file is picked', async () => {
		renderRow()
		await openDialog()
		const save = screen.getByRole('button', { name: /^save$/i })
		expect(save).toBeDisabled()
		const input = screen.getByLabelText(/choose avatar image/i) as HTMLInputElement
		fireEvent.change(input, { target: { files: [makeFile('a.png', 'image/png')] } })
		expect(save).not.toBeDisabled()
	})

	it('shows an inline error and keeps Save disabled when the mime type is wrong', async () => {
		renderRow()
		await openDialog()
		const input = screen.getByLabelText(/choose avatar image/i) as HTMLInputElement
		fireEvent.change(input, { target: { files: [makeFile('x.gif', 'image/gif')] } })
		expect(screen.getByText(/use a jpeg, png, or webp image/i)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
	})

	it('shows an inline error when the file exceeds 5MB', async () => {
		renderRow()
		await openDialog()
		const input = screen.getByLabelText(/choose avatar image/i) as HTMLInputElement
		const big = makeFile('big.png', 'image/png', 6 * 1024 * 1024)
		fireEvent.change(input, { target: { files: [big] } })
		expect(screen.getByText(/5mb or smaller/i)).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
	})

	it('uploads, fires telemetry, toasts, and closes on success', async () => {
		vi.mocked(api.actors.uploadAvatar).mockResolvedValue(
			buildActorResponse({ id: 'actor-1', avatar_storage_key: 'actors/actor-1/avatar.png' }),
		)
		renderRow()
		await openDialog()
		const file = makeFile('a.png', 'image/png')
		fireEvent.change(screen.getByLabelText(/choose avatar image/i), { target: { files: [file] } })
		fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

		await waitFor(() =>
			expect(api.actors.uploadAvatar).toHaveBeenCalledWith('actor-1', expect.any(File)),
		)
		expect(trackProfileFieldUpdated).toHaveBeenCalledWith({ field: 'avatar' })
		expect(toast.success).toHaveBeenCalledWith('Avatar updated')
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
	})

	it('surfaces a server error inline and keeps the dialog open on failure', async () => {
		vi.mocked(api.actors.uploadAvatar).mockRejectedValue(
			new ApiError(400, 'Avatar bytes do not match a JPEG, PNG, or WebP image'),
		)
		renderRow()
		await openDialog()
		fireEvent.change(screen.getByLabelText(/choose avatar image/i), {
			target: { files: [makeFile('a.png', 'image/png')] },
		})
		fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

		expect(await screen.findByText(/avatar bytes do not match/i)).toBeInTheDocument()
		expect(screen.getByRole('dialog')).toBeInTheDocument()
		expect(trackProfileFieldUpdated).not.toHaveBeenCalled()
	})
})
