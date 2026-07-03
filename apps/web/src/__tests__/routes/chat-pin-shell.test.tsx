import { ChatPinShell } from '@/routes/_authed/$workspaceId'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/chat-context', async () => {
	const actual = await vi.importActual<typeof import('@/lib/chat-context')>('@/lib/chat-context')
	return { ...actual, useChat: vi.fn() }
})

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: vi.fn() }))

import { useIsMobile } from '@/hooks/use-mobile'
import { useChat } from '@/lib/chat-context'

const mockedUseChat = vi.mocked(useChat)
const mockedUseIsMobile = vi.mocked(useIsMobile)

function setChat(overrides: Partial<ReturnType<typeof useChat>>) {
	mockedUseChat.mockReturnValue({
		open: false,
		setOpen: vi.fn(),
		openWithContext: vi.fn(),
		pendingAttachments: [],
		clearPendingAttachments: vi.fn(),
		pendingMessage: null,
		clearPendingMessage: vi.fn(),
		pinned: false,
		setPinned: vi.fn(),
		panelWidth: 448,
		setPanelWidth: vi.fn(),
		...overrides,
	})
}

function getShell() {
	return screen.getByTestId('chat-pin-shell')
}

afterEach(() => {
	vi.clearAllMocks()
})

describe('ChatPinShell', () => {
	it('reserves the panel-width column when pinned + open on desktop', () => {
		setChat({ pinned: true, open: true, panelWidth: 400 })
		mockedUseIsMobile.mockReturnValue(false)
		render(
			<ChatPinShell>
				<div>main</div>
			</ChatPinShell>,
		)
		expect(getShell().style.gridTemplateColumns).toBe('minmax(0,1fr) 400px')
		expect(screen.getByText('main')).toBeInTheDocument()
	})

	it('collapses the spacer column to 0px when unpinned', () => {
		setChat({ pinned: false, open: true, panelWidth: 400 })
		mockedUseIsMobile.mockReturnValue(false)
		render(
			<ChatPinShell>
				<div>main</div>
			</ChatPinShell>,
		)
		expect(getShell().style.gridTemplateColumns).toBe('minmax(0,1fr) 0px')
	})

	it('collapses the spacer column to 0px when panel is closed', () => {
		setChat({ pinned: true, open: false, panelWidth: 400 })
		mockedUseIsMobile.mockReturnValue(false)
		render(
			<ChatPinShell>
				<div>main</div>
			</ChatPinShell>,
		)
		expect(getShell().style.gridTemplateColumns).toBe('minmax(0,1fr) 0px')
	})

	it('collapses the spacer column to 0px on mobile even when pinned + open', () => {
		setChat({ pinned: true, open: true, panelWidth: 400 })
		mockedUseIsMobile.mockReturnValue(true)
		render(
			<ChatPinShell>
				<div>main</div>
			</ChatPinShell>,
		)
		expect(getShell().style.gridTemplateColumns).toBe('minmax(0,1fr) 0px')
	})

	it('animates grid-template-columns with the state duration/ease tokens (no margin transition)', () => {
		setChat({ pinned: true, open: true, panelWidth: 400 })
		mockedUseIsMobile.mockReturnValue(false)
		render(
			<ChatPinShell>
				<div>main</div>
			</ChatPinShell>,
		)
		const shell = getShell()
		expect(shell.className).toContain('transition-[grid-template-columns]')
		expect(shell.className).toContain('duration-state')
		expect(shell.className).toContain('ease-default')
		expect(shell.className).not.toMatch(/transition-\[margin\]/)
		expect(shell.style.marginRight).toBe('')
	})
})
