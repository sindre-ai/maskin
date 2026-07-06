import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'

// Regression tests for the Tailwind v4 bracket-syntax trap that broke dropdown
// scroll across the product. In v3 `[--foo]` auto-wrapped to `var(--foo)`; v4
// emits the literal string, producing invalid CSS that the browser drops. Each
// primitive's content must clamp to its Radix available-height var and scroll.
describe('dropdown primitives — scroll contract', () => {
	it('SelectContent clamps to --radix-select-content-available-height and scrolls', () => {
		render(
			<Select open>
				<SelectTrigger>
					<SelectValue placeholder="pick" />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="a">a</SelectItem>
				</SelectContent>
			</Select>,
		)
		const content = screen.getByRole('listbox')
		const cls = content.className
		expect(cls).toMatch(/max-h-\[var\(--radix-select-content-available-height\)\]/)
		expect(cls).toMatch(/overflow-y-auto/)
		expect(cls).not.toMatch(/max-h-\[--radix-/)
	})

	it('PopoverContent clamps to --radix-popover-content-available-height and scrolls', () => {
		render(
			<Popover open>
				<PopoverTrigger>open</PopoverTrigger>
				<PopoverContent>body</PopoverContent>
			</Popover>,
		)
		const content = screen.getByRole('dialog')
		const cls = content.className
		expect(cls).toMatch(/max-h-\[var\(--radix-popover-content-available-height\)\]/)
		expect(cls).toMatch(/overflow-y-auto/)
	})

	it('DropdownMenuContent clamps to --radix-dropdown-menu-content-available-height and scrolls', () => {
		render(
			<DropdownMenu open>
				<DropdownMenuTrigger>open</DropdownMenuTrigger>
				<DropdownMenuContent>
					<DropdownMenuItem>a</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>,
		)
		const content = screen.getByRole('menu')
		const cls = content.className
		expect(cls).toMatch(/max-h-\[var\(--radix-dropdown-menu-content-available-height\)\]/)
		expect(cls).toMatch(/overflow-y-auto/)
		expect(cls).not.toMatch(/origin-\[--radix-/)
	})
})
