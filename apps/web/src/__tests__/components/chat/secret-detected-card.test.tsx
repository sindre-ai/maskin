import { VaultedCard } from '@/components/chat/secret-detected-card'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({ settingsUi: false }))

vi.mock('@/hooks/use-feature-flag', () => ({
	useFeatureFlag: (id: string) => id === 'keychain-settings-ui' && flags.settingsUi,
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

function renderCard(overrides: Partial<Parameters<typeof VaultedCard>[0]> = {}) {
	return render(
		<VaultedCard
			credentialName="Cloudflare key"
			workspaceId="ws-1"
			integrationId="int-1"
			agentCount={1}
			agentName="Infra"
			phase="live"
			undoAvailable
			undoing={false}
			retrying={false}
			sessionEnded
			error={null}
			onUndo={vi.fn()}
			onRetry={vi.fn()}
			{...overrides}
		/>,
	)
}

beforeEach(() => {
	flags.settingsUi = false
})

describe('VaultedCard', () => {
	it('offers View credential when the Keychain settings flag is on', () => {
		flags.settingsUi = true
		renderCard()
		expect(screen.getByRole('link', { name: 'View credential' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
	})

	it('hides View credential when the Keychain settings flag is off', () => {
		renderCard()
		expect(screen.queryByRole('link', { name: 'View credential' })).not.toBeInTheDocument()
	})

	it('says Ended once undo has stopped the session', () => {
		renderCard({ phase: 'undone', sessionEnded: true })
		expect(screen.getByText('Ended')).toBeInTheDocument()
		expect(screen.getByText(/This session has ended/)).toBeInTheDocument()
	})

	it('says Still running when undo could not stop the session', () => {
		renderCard({ phase: 'undone', sessionEnded: false })
		expect(screen.queryByText('Ended')).not.toBeInTheDocument()
		expect(screen.getByText('Still running')).toBeInTheDocument()
		expect(
			screen.getByText(
				"Couldn't stop Infra's session. The key is removed, but the session may still hold it until it ends.",
			),
		).toBeInTheDocument()
	})
})
