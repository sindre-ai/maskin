import { ApiKeyDialog, SkjaldConnectDialog } from '@/components/integrations/provider-dialogs'
import type { ProviderInfo } from '@/lib/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', () => ({
	api: {
		integrations: {
			connect: vi.fn(),
			complete: vi.fn(),
		},
	},
}))

import { api } from '@/lib/api'

const provider = { name: 'linear', displayName: 'Linear' } as ProviderInfo

beforeEach(() => {
	vi.clearAllMocks()
})

describe('ApiKeyDialog', () => {
	it('connects when Enter is pressed in the API key field', async () => {
		vi.mocked(api.integrations.connect).mockResolvedValue({} as never)
		const user = userEvent.setup()
		render(
			<TestWrapper>
				<ApiKeyDialog
					workspaceId="ws-1"
					provider={provider}
					apiKey="secret-key"
					onApiKeyChange={vi.fn()}
					onClose={vi.fn()}
				/>
			</TestWrapper>,
		)

		await user.type(screen.getByLabelText('API key'), '{Enter}')

		await waitFor(() => expect(api.integrations.connect).toHaveBeenCalledTimes(1))
	})

	it('does nothing on Enter while the key is empty', async () => {
		const user = userEvent.setup()
		render(
			<TestWrapper>
				<ApiKeyDialog
					workspaceId="ws-1"
					provider={provider}
					apiKey=""
					onApiKeyChange={vi.fn()}
					onClose={vi.fn()}
				/>
			</TestWrapper>,
		)

		await user.type(screen.getByLabelText('API key'), '{Enter}')

		expect(api.integrations.connect).not.toHaveBeenCalled()
	})

	it('does not connect when Cancel is clicked', async () => {
		const onClose = vi.fn()
		const user = userEvent.setup()
		render(
			<TestWrapper>
				<ApiKeyDialog
					workspaceId="ws-1"
					provider={provider}
					apiKey="secret-key"
					onApiKeyChange={vi.fn()}
					onClose={onClose}
				/>
			</TestWrapper>,
		)

		await user.click(screen.getByRole('button', { name: 'Cancel' }))

		expect(onClose).toHaveBeenCalled()
		expect(api.integrations.connect).not.toHaveBeenCalled()
	})
})

describe('SkjaldConnectDialog', () => {
	it('completes when Enter is pressed in the webhook secret field', async () => {
		vi.mocked(api.integrations.connect).mockResolvedValue({
			integration_id: 'int-1',
			webhook_url: 'https://maskin.example/api/webhooks/skjald/tok',
		} as never)
		vi.mocked(api.integrations.complete).mockResolvedValue({} as never)
		const user = userEvent.setup()
		render(
			<TestWrapper>
				<SkjaldConnectDialog workspaceId="ws-1" open={true} onClose={vi.fn()} />
			</TestWrapper>,
		)

		await user.click(screen.getByRole('button', { name: 'Set up manually' }))
		await user.click(await screen.findByRole('button', { name: 'Next' }))
		await user.type(screen.getByLabelText('Webhook secret'), 'whsec_123{Enter}')

		await waitFor(() =>
			expect(api.integrations.complete).toHaveBeenCalledWith('int-1', 'ws-1', 'whsec_123'),
		)
	})
})
