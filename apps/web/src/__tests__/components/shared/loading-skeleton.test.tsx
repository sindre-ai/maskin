import { CardSkeleton, ListSkeleton, Skeleton } from '@/components/shared/loading-skeleton'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('Skeleton', () => {
	it('renders with animate-pulse class', () => {
		const { container } = render(<Skeleton />)
		const el = container.firstElementChild as HTMLElement
		expect(el.className).toMatch(/animate-pulse/)
	})
})

describe('CardSkeleton', () => {
	it('renders skeleton elements', () => {
		const { container } = render(<CardSkeleton />)
		const pulseElements = container.querySelectorAll('.animate-pulse')
		expect(pulseElements.length).toBeGreaterThanOrEqual(3)
	})
})

describe('ListSkeleton', () => {
	it('renders default 5 rows', () => {
		const { container } = render(<ListSkeleton />)
		// Each row has 3 skeleton elements, so 5 rows = 15 skeleton elements
		const pulseElements = container.querySelectorAll('.animate-pulse')
		expect(pulseElements.length).toBe(15)
	})

	it('renders custom number of rows', () => {
		const { container } = render(<ListSkeleton rows={3} />)
		const pulseElements = container.querySelectorAll('.animate-pulse')
		expect(pulseElements.length).toBe(9)
	})
})
