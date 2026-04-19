import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-relationships', () => ({
	useRelationships: () => ({ data: [] }),
}))

vi.mock('@tanstack/react-router', () => ({
	Link: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => (
		<a {...(props as Record<string, string>)}>{children}</a>
	),
}))

import { KnowledgeStatusBanner } from '@/components/objects/knowledge-status-banner'

describe('KnowledgeStatusBanner', () => {
	it('renders nothing for non-knowledge object types', () => {
		const { container } = render(
			<KnowledgeStatusBanner objectId="o1" workspaceId="w1" status="draft" type="bet" />,
		)
		expect(container.firstChild).toBeNull()
	})

	it('renders nothing for validated knowledge articles', () => {
		const { container } = render(
			<KnowledgeStatusBanner objectId="o1" workspaceId="w1" status="validated" type="knowledge" />,
		)
		expect(container.firstChild).toBeNull()
	})

	it('renders a draft notice for draft knowledge articles', () => {
		render(<KnowledgeStatusBanner objectId="o1" workspaceId="w1" status="draft" type="knowledge" />)
		expect(screen.getByText(/Draft article/i)).toBeInTheDocument()
		expect(screen.getByRole('status')).toBeInTheDocument()
	})

	it('renders a deprecated notice for deprecated knowledge articles', () => {
		render(
			<KnowledgeStatusBanner
				objectId="o1"
				workspaceId="w1"
				status="deprecated"
				type="knowledge"
			/>,
		)
		expect(screen.getByText(/Deprecated article/i)).toBeInTheDocument()
	})
})
