import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		className,
		to,
		params,
		...rest
	}: {
		children: React.ReactNode
		className?: string
		to: string
		params: Record<string, string>
	} & Record<string, unknown>) => (
		<a
			href={to.replace('$workspaceId', params.workspaceId)}
			className={className}
			aria-label={rest['aria-label'] as string | undefined}
		>
			{children}
		</a>
	),
}))

import { SettingsReferenceChip } from '@/components/chat/linked-object-reference'
import { SETTINGS_SECTIONS } from '@/lib/linked-objects'

const WS = 'ws-1'

describe('SettingsReferenceChip', () => {
	it('reads Settings and the section as one link to that page', () => {
		render(
			<SettingsReferenceChip workspaceId={WS} target={{ path: 'billing', label: 'Billing' }} />,
		)
		const link = screen.getByRole('link', { name: 'Settings: Billing' })
		expect(link).toHaveAttribute('href', '/ws-1/settings/billing')
		expect(link).toHaveTextContent('Settings: Billing')
	})

	it('opens General at the bare settings address', () => {
		render(<SettingsReferenceChip workspaceId={WS} target={{ path: '', label: 'General' }} />)
		expect(screen.getByRole('link', { name: 'Settings: General' })).toHaveAttribute(
			'href',
			'/ws-1/settings',
		)
	})

	it('has a page for every section of the settings menu', () => {
		for (const section of SETTINGS_SECTIONS) {
			const { unmount } = render(<SettingsReferenceChip workspaceId={WS} target={section} />)
			const href = screen.getByRole('link').getAttribute('href')
			expect(href).toBe(section.path ? `/ws-1/settings/${section.path}` : '/ws-1/settings')
			unmount()
		}
	})

	it('wears the chip plate, a gear mark and no preview or button', () => {
		const { container } = render(
			<SettingsReferenceChip workspaceId={WS} target={{ path: 'mcp', label: 'MCP' }} />,
		)
		const link = screen.getByRole('link')
		expect(link.className).toContain('bg-muted')
		expect(link.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
		expect(container.querySelector('button')).toBeNull()
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
	})
})
