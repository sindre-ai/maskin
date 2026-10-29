import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { UnavailableCard, UnavailableChip } from '@/components/chat/linked-card-face'

const iconClass = (container: HTMLElement) =>
	container.querySelector('svg')?.getAttribute('class') ?? ''

describe('the unavailable card and chip', () => {
	it('use the message icon for a chat, so they say nothing about whether it was deleted', () => {
		const card = render(<UnavailableCard shell="" marker={undefined} kind="chat" />)
		expect(iconClass(card.container)).toContain('lucide-message-circle')
		expect(iconClass(card.container)).not.toContain('trash')
		const chip = render(<UnavailableChip kind="chat" />)
		expect(iconClass(chip.container)).toContain('lucide-message-circle')
		expect(iconClass(chip.container)).not.toContain('trash')
	})

	it('keep the trash can for everything else', () => {
		const card = render(<UnavailableCard shell="" marker={undefined} kind="loop" />)
		expect(iconClass(card.container)).toContain('trash')
		const chip = render(<UnavailableChip kind="object" />)
		expect(iconClass(chip.container)).toContain('trash')
	})
})
