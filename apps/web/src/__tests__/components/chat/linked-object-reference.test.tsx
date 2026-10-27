import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const useObject = vi.fn()

vi.mock('@/hooks/use-objects', () => ({ useObject: (id: string) => useObject(id) }))
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [{ id: 'actor-1', name: 'Developer', type: 'agent' }] }),
}))
vi.mock('@/hooks/use-object-type-label', () => ({
	useObjectTypeLabel: () => (type: string) => type.charAt(0).toUpperCase() + type.slice(1),
}))
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		className,
		...rest
	}: { children: React.ReactNode; className?: string } & Record<string, unknown>) => (
		<a href="/x" className={className} aria-label={rest['aria-label'] as string | undefined}>
			{children}
		</a>
	),
}))

import { ObjectReferenceChip } from '@/components/chat/linked-object-reference'

const WS = 'ws-1'
const ID = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
const fallback = <a href="/original">the original link</a>

function objectRow(overrides: Record<string, unknown> = {}) {
	return {
		id: ID,
		workspaceId: WS,
		type: 'bet',
		status: 'active',
		title: 'Chat preview cards',
		content: 'Text',
		driver: 'actor-1',
		...overrides,
	}
}

const renderChip = () =>
	render(<ObjectReferenceChip workspaceId={WS} objectId={ID} fallback={fallback} />)

describe('ObjectReferenceChip', () => {
	beforeEach(() => useObject.mockReset())

	it('keeps the original link while the object loads', () => {
		useObject.mockReturnValue({ data: undefined, isLoading: true })
		renderChip()
		expect(screen.getByText('the original link')).toBeInTheDocument()
	})

	it('reads type, status, title and owner as one link', () => {
		useObject.mockReturnValue({ data: objectRow(), isLoading: false })
		renderChip()
		expect(
			screen.getByRole('link', { name: 'Bet, Active: Chat preview cards, Developer' }),
		).toBeInTheDocument()
		expect(screen.queryByText('the original link')).not.toBeInTheDocument()
	})

	it('leaves the owner out of the name when nobody has the object', () => {
		useObject.mockReturnValue({ data: objectRow({ driver: null }), isLoading: false })
		renderChip()
		expect(
			screen.getByRole('link', { name: 'Bet, Active: Chat preview cards' }),
		).toBeInTheDocument()
	})

	it('says Deleted object when the object is missing or in another workspace', () => {
		for (const data of [undefined, objectRow({ workspaceId: 'other' })]) {
			useObject.mockReturnValue({ data, isLoading: false })
			const { unmount } = renderChip()
			expect(screen.getByText('Deleted object')).toBeInTheDocument()
			unmount()
		}
	})
})
