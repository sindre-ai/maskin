import { ProfileView } from '@/components/profile/profile-view'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse } from '../../factories'

const mockUseActor = vi.fn()
const updateMutate = vi.fn()
const uploadMutateAsync = vi.fn()

vi.mock('@/hooks/use-actors', () => ({
	useActor: (id: string) => mockUseActor(id),
	useUpdateActor: () => ({ mutate: updateMutate }),
	useUploadActorAvatar: () => ({ mutateAsync: uploadMutateAsync, isPending: false }),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

function renderProfile(overrides: Parameters<typeof buildActorResponse>[0] = {}) {
	const actor = buildActorResponse({ id: 'actor-1', name: 'Alice', ...overrides })
	mockUseActor.mockReturnValue({ data: actor, isLoading: false })
	render(<ProfileView actorId="actor-1" workspaceId="ws-1" workspaceName="Vaerksted" />)
	return actor
}

describe('ProfileView', () => {
	beforeEach(() => {
		mockUseActor.mockReset()
		updateMutate.mockReset()
		uploadMutateAsync.mockReset()
	})

	it('leads with the name and pairs the email with the workspace', () => {
		renderProfile({ email: 'alice@test.com' })
		expect(screen.getByRole('heading', { name: 'Alice' })).toBeInTheDocument()
		expect(screen.getByText('alice@test.com · Vaerksted')).toBeInTheDocument()
	})

	// The section is labelled "your agents read this", so it must be backed by a
	// field agents actually receive — the actor's own description, not local state.
	it('saves "How to work with me" onto the actor description', async () => {
		const user = userEvent.setup()
		renderProfile({ description: 'Ask before emailing anyone.' })
		expect(screen.getByText('Ask before emailing anyone.')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Edit how to work with me' }))
		const box = screen.getByRole('textbox', { name: 'How to work with me' })
		await user.clear(box)
		await user.type(box, 'Never ship on a Friday.')
		await user.click(screen.getByRole('button', { name: 'Done editing how to work with me' }))

		await waitFor(() =>
			expect(updateMutate).toHaveBeenCalledWith(
				{ id: 'actor-1', data: { description: 'Never ship on a Friday.' } },
				expect.anything(),
			),
		)
	})

	// Multi-paragraph prose is the whole point of this section, and the actor
	// description used to be capped at the 80-character agent tagline length —
	// anything longer 400'd and the user's text was thrown away.
	it('saves preferences longer than an agent tagline', async () => {
		const user = userEvent.setup()
		const prose = 'A'.repeat(400)
		renderProfile({ description: '' })

		await user.click(screen.getByRole('button', { name: 'Edit how to work with me' }))
		const box = screen.getByRole('textbox', { name: 'How to work with me' })
		await user.click(box)
		await user.paste(prose)
		await user.click(screen.getByRole('button', { name: 'Done editing how to work with me' }))

		await waitFor(() =>
			expect(updateMutate).toHaveBeenCalledWith(
				{ id: 'actor-1', data: { description: prose } },
				expect.anything(),
			),
		)
	})

	// A failed save must not close the editor: closing first re-rendered the
	// read view with the old text and dropped everything the user had typed.
	it('keeps the editor open and the draft intact when the save fails', async () => {
		const user = userEvent.setup()
		updateMutate.mockImplementation((_vars, opts) => opts.onError(new Error('nope')))
		renderProfile({ description: 'Old text.' })

		await user.click(screen.getByRole('button', { name: 'Edit how to work with me' }))
		const box = screen.getByRole('textbox', { name: 'How to work with me' })
		await user.clear(box)
		await user.type(box, 'New text.')
		await user.click(screen.getByRole('button', { name: 'Done editing how to work with me' }))

		const stillOpen = await screen.findByRole('textbox', { name: 'How to work with me' })
		expect(stillOpen).toHaveValue('New text.')
	})

	it('does not write when the preferences text is unchanged', async () => {
		const user = userEvent.setup()
		renderProfile({ description: 'Same text.' })

		await user.click(screen.getByRole('button', { name: 'Edit how to work with me' }))
		await user.click(screen.getByRole('button', { name: 'Done editing how to work with me' }))

		expect(updateMutate).not.toHaveBeenCalled()
	})

	it('renders a prompt rather than an empty block when nothing is written yet', () => {
		renderProfile({ description: null })
		expect(screen.getByText(/Nothing here yet/)).toBeInTheDocument()
	})

	it('edits the account name in place and saves it', async () => {
		const user = userEvent.setup()
		renderProfile()

		await user.click(screen.getByRole('button', { name: /Edit full name/ }))
		const field = screen.getByRole('textbox', { name: 'Full name' })
		await user.clear(field)
		await user.type(field, 'Alice B{Enter}')

		await waitFor(() =>
			expect(updateMutate).toHaveBeenCalledWith(
				{ id: 'actor-1', data: { name: 'Alice B' } },
				expect.anything(),
			),
		)
	})

	it('abandons an in-place edit on Escape without writing', async () => {
		const user = userEvent.setup()
		renderProfile()

		await user.click(screen.getByRole('button', { name: /Edit full name/ }))
		await user.type(screen.getByRole('textbox', { name: 'Full name' }), 'Zed{Escape}')

		expect(updateMutate).not.toHaveBeenCalled()
		expect(screen.getByRole('button', { name: /Edit full name/ })).toHaveTextContent('Alice')
	})

	it('refuses to write an emptied field, restoring what was there', async () => {
		const user = userEvent.setup()
		renderProfile()

		await user.click(screen.getByRole('button', { name: /Edit full name/ }))
		const field = screen.getByRole('textbox', { name: 'Full name' })
		await user.clear(field)
		await user.tab()

		expect(updateMutate).not.toHaveBeenCalled()
		expect(screen.getByRole('button', { name: /Edit full name/ })).toHaveTextContent('Alice')
	})

	it('exposes the actor id for copying', () => {
		renderProfile()
		expect(screen.getByText('actor-1')).toBeInTheDocument()
		expect(screen.getAllByRole('button', { name: 'Copy' }).length).toBeGreaterThan(0)
	})
})
