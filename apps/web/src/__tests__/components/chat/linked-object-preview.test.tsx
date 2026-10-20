import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const useObject = vi.fn()

vi.mock('@/hooks/use-objects', () => ({ useObject: (id: string) => useObject(id) }))
vi.mock('@/hooks/use-object-type-label', () => ({
	useObjectTypeLabel: () => (type: string) => type,
}))
vi.mock('@tanstack/react-router', () => ({
	Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
		<a href="/x" className={className}>
			{children}
		</a>
	),
}))

import { LinkedObjectPreviews } from '@/components/chat/linked-object-preview'

const ID = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
const WS = 'ws-1'

function objectRow(overrides: Record<string, unknown> = {}) {
	return {
		id: ID,
		workspaceId: WS,
		type: 'task',
		title: 'LinkedIn note to Catja',
		status: 'in_review',
		content: 'Hej Catja, tillykke med fusionen.',
		...overrides,
	}
}

describe('LinkedObjectPreviews', () => {
	beforeEach(() => useObject.mockReset())

	it('shows the title and text of an object the message links to', () => {
		useObject.mockReturnValue({ data: objectRow() })
		render(<LinkedObjectPreviews workspaceId={WS} content={`Draft: /objects/${ID}`} />)
		expect(screen.getByText('LinkedIn note to Catja')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Open/ })).toBeInTheDocument()
		expect(screen.getByText(/tillykke med fusionen/)).toBeInTheDocument()
	})

	it('shows nothing when the message links to no object', () => {
		const { container } = render(<LinkedObjectPreviews workspaceId={WS} content="No links" />)
		expect(container).toBeEmptyDOMElement()
		expect(useObject).not.toHaveBeenCalled()
	})

	it('shows nothing for an object from another workspace', () => {
		useObject.mockReturnValue({ data: objectRow({ workspaceId: 'other' }) })
		const { container } = render(
			<LinkedObjectPreviews workspaceId={WS} content={`/objects/${ID}`} />,
		)
		expect(container).toBeEmptyDOMElement()
	})

	it('shows nothing while loading, when missing, or when the object has no text', () => {
		for (const result of [{ data: undefined }, { data: objectRow({ content: '  ' }) }]) {
			useObject.mockReturnValue(result)
			const { container } = render(
				<LinkedObjectPreviews workspaceId={WS} content={`/objects/${ID}`} />,
			)
			expect(container).toBeEmptyDOMElement()
		}
	})

	it('folds a long text until Read all is pressed', async () => {
		useObject.mockReturnValue({ data: objectRow({ content: 'word '.repeat(120) }) })
		render(<LinkedObjectPreviews workspaceId={WS} content={`/objects/${ID}`} />)
		await userEvent.click(screen.getByRole('button', { name: 'Read all' }))
		expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()
	})
})
