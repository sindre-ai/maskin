import { ComposerNotice } from '@/components/chat/composer-notice'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
	Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
		<a href="/agent" className={className}>
			{children}
		</a>
	),
}))

describe('ComposerNotice', () => {
	it('shows the not-in-workspace copy with a link to the agent', () => {
		render(
			<ComposerNotice
				workspaceId="ws-1"
				id="composer-notice"
				status={{ id: 'a1', name: 'Forge', state: 'not_in_workspace' }}
			/>,
		)
		const notice = screen.getByRole('status')
		expect(notice).toHaveAttribute('id', 'composer-notice')
		expect(notice).toHaveTextContent(
			"Forge isn't in this workspace yet, so it can't reply. A workspace admin needs to add it.",
		)
		expect(screen.getByRole('link')).toHaveTextContent('Open Forge →')
	})

	it('shows only the paused line, with no link and no promise about replies', () => {
		render(
			<ComposerNotice
				workspaceId="ws-1"
				id="composer-notice"
				status={{ id: 'a1', name: 'Forge', state: 'paused' }}
			/>,
		)
		expect(screen.getByRole('status')).toHaveTextContent(/^Forge is paused\.$/)
		expect(screen.queryByRole('link')).toBeNull()
	})

	it('renders nothing when there is no state', () => {
		render(
			<ComposerNotice
				workspaceId="ws-1"
				id="composer-notice"
				status={{ id: 'a1', name: 'Forge', state: null }}
			/>,
		)
		expect(screen.queryByRole('status')).toBeNull()
	})
})
