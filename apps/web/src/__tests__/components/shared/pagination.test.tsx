import { Pagination } from '@/components/shared/pagination'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('Pagination', () => {
	it('renders nothing when total fits in one page', () => {
		const { container } = render(
			<Pagination total={10} limit={50} offset={0} onPageChange={vi.fn()} />,
		)
		expect(container.firstChild).toBeNull()
	})

	it('renders pagination controls when total exceeds limit', () => {
		render(<Pagination total={100} limit={50} offset={0} onPageChange={vi.fn()} />)
		expect(screen.getByText('1 / 2')).toBeInTheDocument()
		expect(screen.getByText(/1–50 of 100/)).toBeInTheDocument()
	})

	it('disables Previous button on first page', () => {
		render(<Pagination total={100} limit={50} offset={0} onPageChange={vi.fn()} />)
		expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled()
		expect(screen.getByRole('button', { name: /next/i })).toBeEnabled()
	})

	it('disables Next button on last page', () => {
		render(<Pagination total={100} limit={50} offset={50} onPageChange={vi.fn()} />)
		expect(screen.getByRole('button', { name: /next/i })).toBeDisabled()
		expect(screen.getByRole('button', { name: /previous/i })).toBeEnabled()
	})

	it('calls onPageChange with next offset when Next is clicked', async () => {
		const onPageChange = vi.fn()
		render(<Pagination total={150} limit={50} offset={0} onPageChange={onPageChange} />)

		await userEvent.click(screen.getByRole('button', { name: /next/i }))
		expect(onPageChange).toHaveBeenCalledWith(50)
	})

	it('calls onPageChange with previous offset when Previous is clicked', async () => {
		const onPageChange = vi.fn()
		render(<Pagination total={150} limit={50} offset={50} onPageChange={onPageChange} />)

		await userEvent.click(screen.getByRole('button', { name: /previous/i }))
		expect(onPageChange).toHaveBeenCalledWith(0)
	})

	it('shows correct range on middle page', () => {
		render(<Pagination total={150} limit={50} offset={50} onPageChange={vi.fn()} />)
		expect(screen.getByText('2 / 3')).toBeInTheDocument()
		expect(screen.getByText(/51–100 of 150/)).toBeInTheDocument()
	})

	it('shows correct range on last partial page', () => {
		render(<Pagination total={75} limit={50} offset={50} onPageChange={vi.fn()} />)
		expect(screen.getByText(/51–75 of 75/)).toBeInTheDocument()
	})
})
