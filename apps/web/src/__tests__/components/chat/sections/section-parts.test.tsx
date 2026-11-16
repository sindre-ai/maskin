import { ChatViewTiles } from '@/components/chat/sections/chat-view-tiles'
import { SectionNameForm, findDuplicateSection } from '@/components/chat/sections/section-name-form'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const counts = {
	waiting: { count: 4, more: false },
	running: { count: 1, more: false },
	quiet: { count: null, more: false },
}

describe('ChatViewTiles', () => {
	it('shows each number, a dash while loading, and marks the open tile', () => {
		render(<ChatViewTiles active="running" counts={counts} onToggle={() => {}} />)
		expect(screen.getByRole('button', { name: /Waiting on you/ })).toHaveTextContent('4')
		expect(screen.getByRole('button', { name: /Quiet/ })).toHaveTextContent('–')
		expect(screen.getByRole('button', { name: /Running/ })).toHaveAttribute('aria-pressed', 'true')
		expect(screen.getByRole('button', { name: /Quiet/ })).toHaveAttribute('aria-pressed', 'false')
	})

	it('adds a plus when more than the loaded page waits', () => {
		render(
			<ChatViewTiles
				active={null}
				counts={{ ...counts, quiet: { count: 30, more: true } }}
				onToggle={() => {}}
			/>,
		)
		expect(screen.getByRole('button', { name: /Quiet/ })).toHaveTextContent('30+')
	})

	it('reports the tile pressed', () => {
		const onToggle = vi.fn()
		render(<ChatViewTiles active={null} counts={counts} onToggle={onToggle} />)
		fireEvent.click(screen.getByRole('button', { name: /Running/ }))
		expect(onToggle).toHaveBeenCalledWith('running')
	})
})

describe('findDuplicateSection', () => {
	it('matches a name without case and names the section already there', () => {
		const sections = [{ id: 'a', name: 'Launch' }]
		expect(findDuplicateSection('launch', sections)).toBe(
			'You already have a section called Launch.',
		)
		expect(findDuplicateSection('launch', sections, 'a')).toBeNull()
		expect(findDuplicateSection('Other', sections)).toBeNull()
	})
})

describe('SectionNameForm', () => {
	it('saves the trimmed name on Enter and cancels on Escape', async () => {
		const onSubmit = vi.fn().mockResolvedValue(undefined)
		const onCancel = vi.fn()
		render(
			<SectionNameForm
				submitLabel="Add section"
				sections={[]}
				onSubmit={onSubmit}
				onCancel={onCancel}
			/>,
		)
		const field = screen.getByLabelText('Section name')
		fireEvent.change(field, { target: { value: '  Launch ' } })
		fireEvent.submit(field.closest('form') as HTMLFormElement)
		await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('Launch'))
		fireEvent.keyDown(field, { key: 'Escape' })
		expect(onCancel).toHaveBeenCalled()
	})

	it('keeps a duplicate name in the field with the reason and does not save', () => {
		const onSubmit = vi.fn()
		render(
			<SectionNameForm
				submitLabel="Add section"
				sections={[{ id: 'a', name: 'Launch' }]}
				onSubmit={onSubmit}
				onCancel={() => {}}
			/>,
		)
		const field = screen.getByLabelText('Section name')
		fireEvent.change(field, { target: { value: 'launch' } })
		fireEvent.submit(field.closest('form') as HTMLFormElement)
		expect(screen.getByRole('alert')).toHaveTextContent('You already have a section called Launch.')
		expect(onSubmit).not.toHaveBeenCalled()
	})
})
