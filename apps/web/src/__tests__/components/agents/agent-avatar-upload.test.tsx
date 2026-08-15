import { AgentAvatarUpload } from '@/components/agents/agent-avatar-upload'
import { ApiError } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildActorResponse } from '../../factories'
import { createTestWrapper } from '../../setup'

const uploadMutate = vi.fn()
const uploadIsPending = { value: false }

vi.mock('@/hooks/use-actors', () => ({
	useUploadActorAvatar: () => ({
		mutateAsync: uploadMutate,
		isPending: uploadIsPending.value,
	}),
}))

let membersData: { actorId: string; role?: string }[] | undefined = [
	{ actorId: 'me', role: 'admin' },
]

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: () => ({ data: membersData }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'me' }),
	getApiKey: () => 'ank_test',
}))

const agent = buildActorResponse({ id: 'agent-1', name: 'Product Marketer', type: 'agent' })

function renderWidget() {
	const Wrapper = createTestWrapper()
	return render(
		<Wrapper>
			<AgentAvatarUpload agent={agent} workspaceId="ws-1" />
		</Wrapper>,
	)
}

beforeEach(() => {
	uploadMutate.mockReset()
	uploadIsPending.value = false
	membersData = [{ actorId: 'me', role: 'admin' }]
})

describe('AgentAvatarUpload', () => {
	it('shows the upload affordance for a workspace admin', () => {
		renderWidget()
		expect(screen.getByRole('button', { name: /upload avatar image/i })).toBeInTheDocument()
	})

	it('hides the upload affordance for a non-admin member', () => {
		membersData = [{ actorId: 'me', role: 'member' }]
		renderWidget()
		expect(screen.queryByRole('button', { name: /upload avatar image/i })).not.toBeInTheDocument()
		// Preview still renders so non-admins see the same avatar image.
		expect(screen.getByTitle('Product Marketer')).toBeInTheDocument()
	})

	it('hides the upload affordance when the current actor is not a workspace member', () => {
		membersData = [{ actorId: 'someone-else', role: 'admin' }]
		renderWidget()
		expect(screen.queryByRole('button', { name: /upload avatar image/i })).not.toBeInTheDocument()
	})

	it('rejects non-PNG/JPG files inline without calling the upload mutation', async () => {
		renderWidget()
		const user = userEvent.setup({ applyAccept: false })
		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		const textFile = new File(['hello'], 'notes.txt', { type: 'text/plain' })
		await user.upload(input, textFile)
		expect(await screen.findByText(/only png or jpg/i)).toBeInTheDocument()
		expect(uploadMutate).not.toHaveBeenCalled()
	})

	it('posts an accepted PNG to the upload mutation on file select', async () => {
		uploadMutate.mockResolvedValueOnce(agent)
		renderWidget()
		const user = userEvent.setup()
		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		const png = new File(['fake'], 'headshot.png', { type: 'image/png' })
		await user.upload(input, png)
		await waitFor(() => expect(uploadMutate).toHaveBeenCalledTimes(1))
		expect(uploadMutate).toHaveBeenCalledWith({ id: 'agent-1', file: png })
	})

	it('surfaces the server error message inline on upload failure', async () => {
		uploadMutate.mockRejectedValueOnce(
			new ApiError(413, 'Image is too large. Maximum size is 2 MB.'),
		)
		renderWidget()
		const user = userEvent.setup()
		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		const png = new File(['fake'], 'huge.png', { type: 'image/png' })
		await user.upload(input, png)
		expect(await screen.findByText(/image is too large/i)).toBeInTheDocument()
	})

	it('renders image/png,image/jpeg on the native file input accept attribute', () => {
		renderWidget()
		const input = document.querySelector('input[type="file"]') as HTMLInputElement
		expect(input.accept).toBe('image/png,image/jpeg')
	})
})
