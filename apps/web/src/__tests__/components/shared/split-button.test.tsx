import {
	SplitButton,
	SplitButtonChevron,
	SplitButtonPrimary,
} from '@/components/shared/split-button'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Plus } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'

describe('SplitButton primitives', () => {
	function renderControl(overrides: Partial<{ disabled: boolean; onPrimary: () => void }> = {}) {
		const onPrimary = overrides.onPrimary ?? vi.fn()
		return {
			onPrimary,
			view: render(
				<SplitButton disabled={overrides.disabled}>
					<SplitButtonPrimary
						label="New"
						icon={<Plus aria-hidden />}
						onClick={onPrimary}
						title="Primary"
						disabled={overrides.disabled}
					/>
					<SplitButtonChevron ariaLabel="More" title="More" disabled={overrides.disabled} />
				</SplitButton>,
			),
		}
	}

	it('renders the labelled primary half and the caret chevron half', () => {
		renderControl()
		expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
	})

	it('runs the primary click handler', async () => {
		const user = userEvent.setup()
		const { onPrimary } = renderControl()
		await user.click(screen.getByRole('button', { name: 'New' }))
		expect(onPrimary).toHaveBeenCalledOnce()
	})

	it('dims both halves and disables interaction when disabled is set', () => {
		renderControl({ disabled: true })
		const wrapper = screen.getByRole('button', { name: 'New' }).parentElement
		expect(wrapper).not.toBeNull()
		expect(wrapper?.className).toMatch(/opacity-60/)
		expect(wrapper?.className).toMatch(/pointer-events-none/)
		expect(screen.getByRole('button', { name: 'New' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'More' })).toBeDisabled()
	})
})
