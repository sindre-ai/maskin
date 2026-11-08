import { LoopTags } from '@/components/loops/loop-tags'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

function open(onChange = vi.fn(), tags = ['Roadmap']) {
	render(<LoopTags tags={tags} canWrite onChange={onChange} />)
	fireEvent.click(screen.getByRole('button', { name: /Tag$/ }))
	return { onChange, input: screen.getByRole('textbox', { name: 'New tag' }) }
}

describe('LoopTags', () => {
	it('adds a tag once when Enter is pressed and the field then blurs', () => {
		const { onChange, input } = open()
		fireEvent.change(input, { target: { value: 'Growth' } })
		fireEvent.keyDown(input, { key: 'Enter' })
		fireEvent.blur(input)
		expect(onChange).toHaveBeenCalledTimes(1)
		expect(onChange).toHaveBeenCalledWith(['Roadmap', 'Growth'])
	})

	it('adds nothing when Escape cancels, even though the field blurs afterwards', () => {
		const { onChange, input } = open()
		fireEvent.change(input, { target: { value: 'Growth' } })
		fireEvent.keyDown(input, { key: 'Escape' })
		fireEvent.blur(input)
		expect(onChange).not.toHaveBeenCalled()
	})

	it('ignores a duplicate tag', () => {
		const { onChange, input } = open()
		fireEvent.change(input, { target: { value: 'roadmap' } })
		fireEvent.blur(input)
		expect(onChange).not.toHaveBeenCalled()
	})

	it('can add a second tag after the first was settled', () => {
		const { onChange, input } = open()
		fireEvent.change(input, { target: { value: 'One' } })
		fireEvent.keyDown(input, { key: 'Enter' })
		fireEvent.click(screen.getByRole('button', { name: /Tag$/ }))
		const next = screen.getByRole('textbox', { name: 'New tag' })
		fireEvent.change(next, { target: { value: 'Two' } })
		fireEvent.keyDown(next, { key: 'Enter' })
		expect(onChange).toHaveBeenCalledTimes(2)
	})
})
