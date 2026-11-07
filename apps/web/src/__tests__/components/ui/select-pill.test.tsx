import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Select, SelectTrigger, SelectValue } from '@/components/ui/select'

describe('SelectTrigger size="pill"', () => {
	it('draws the 34px, fully rounded, 13.5px pill with a 44px touch floor', () => {
		render(
			<Select>
				<SelectTrigger size="pill" aria-label="Status">
					<SelectValue placeholder="Status" />
				</SelectTrigger>
			</Select>,
		)
		const cls = screen.getByRole('combobox', { name: 'Status' }).className
		expect(cls).toContain('h-[34px]')
		expect(cls).toContain('rounded-full')
		expect(cls).toContain('text-[13.5px]')
		expect(cls).toContain('min-h-11')
		expect(cls).not.toContain('h-8')
	})

	it('keeps the default trigger at h-8', () => {
		render(
			<Select>
				<SelectTrigger aria-label="Plain">
					<SelectValue placeholder="Plain" />
				</SelectTrigger>
			</Select>,
		)
		expect(screen.getByRole('combobox', { name: 'Plain' }).className).toContain('h-8')
	})
})
