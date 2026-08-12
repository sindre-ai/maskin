import { ChatTypingMotion } from '@/components/shared/chat-typing-motion'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

function barsOf(container: HTMLElement): HTMLElement[] {
	return [...(container.querySelector('[role="img"]')?.children ?? [])] as HTMLElement[]
}

describe('ChatTypingMotion', () => {
	it('defaults to the eq equalizer and animates while typing', () => {
		const { container } = render(<ChatTypingMotion />)
		const bars = barsOf(container)
		expect(bars).toHaveLength(5)
		expect(bars.every((bar) => bar.className.includes('animate-pulse'))).toBe(true)
	})

	it('renders a static stopped state with no animation', () => {
		const { container } = render(<ChatTypingMotion state="stopped" />)
		expect(barsOf(container).every((bar) => !bar.className.includes('animate-pulse'))).toBe(true)
	})

	it('renders three dots for the dots variant', () => {
		const { container } = render(<ChatTypingMotion variant="dots" />)
		expect(barsOf(container)).toHaveLength(3)
	})

	it('renders a mic glyph for the mic variant', () => {
		const { container } = render(<ChatTypingMotion variant="mic" state="stopped" />)
		expect(container.querySelector('[role="img"] svg')).toBeInTheDocument()
	})
})
