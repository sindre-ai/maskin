import { Textarea } from '@/components/ui/textarea'
import { fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const HUGE_SCROLL_HEIGHT = 48088

describe('Textarea autoResize', () => {
	beforeEach(() => {
		Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
			configurable: true,
			get() {
				return this.dataset.scrollHeight ? Number(this.dataset.scrollHeight) : 0
			},
		})
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('caps inline height at the CSS max-height when a huge paste blows scrollHeight past it', () => {
		const { getByRole } = render(<Textarea autoResize className="max-h-40" aria-label="Composer" />)
		const el = getByRole('textbox') as HTMLTextAreaElement
		vi.spyOn(window, 'getComputedStyle').mockReturnValue({
			maxHeight: '160px',
		} as CSSStyleDeclaration)
		el.dataset.scrollHeight = String(HUGE_SCROLL_HEIGHT)
		fireEvent.input(el, { target: { value: 'huge paste' } })
		expect(el.style.height).toBe('160px')
	})

	it('grows to fit scrollHeight when the caller sets no max-height (agent-document)', () => {
		const { getByRole } = render(<Textarea autoResize aria-label="Prompt" />)
		const el = getByRole('textbox') as HTMLTextAreaElement
		vi.spyOn(window, 'getComputedStyle').mockReturnValue({
			maxHeight: 'none',
		} as CSSStyleDeclaration)
		el.dataset.scrollHeight = '240'
		fireEvent.input(el, { target: { value: 'a few lines' } })
		expect(el.style.height).toBe('240px')
	})

	it('leaves the height alone when autoResize is off', () => {
		const { getByRole } = render(<Textarea aria-label="Plain" />)
		const el = getByRole('textbox') as HTMLTextAreaElement
		el.dataset.scrollHeight = String(HUGE_SCROLL_HEIGHT)
		fireEvent.input(el, { target: { value: 'anything' } })
		expect(el.style.height).toBe('')
	})
})
