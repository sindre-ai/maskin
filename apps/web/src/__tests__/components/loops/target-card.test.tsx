import { TargetCard } from '@/components/loops/target-card'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('TargetCard figures', () => {
	it('shows large figures with a thousands separator', () => {
		render(
			<TargetCard target={{ label: 'DKK awarded', source: 'plain', actual: 0, target: 992880 }} />,
		)
		const group = (1000).toLocaleString().replace(/\d/g, '')
		expect(screen.getByText(`0 of 992${group}880`)).toBeInTheDocument()
	})
})
