import { PropertyTypeGrid, propertyTypeLabel } from '@/components/objects/property-type-grid'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('PropertyTypeGrid', () => {
	it('offers one tile per field type the schema accepts', () => {
		render(<PropertyTypeGrid value="text" onChange={() => {}} />)
		const names = screen.getAllByRole('radio').map((r) => r.textContent)
		expect(names).toEqual(['Text', 'Number', 'Date', 'Select', 'Yes / No'])
	})

	it('marks the current type as checked', () => {
		render(<PropertyTypeGrid value="number" onChange={() => {}} />)
		expect(screen.getByRole('radio', { name: 'Number' })).toBeChecked()
		expect(screen.getByRole('radio', { name: 'Text' })).not.toBeChecked()
	})

	it('reports the stored field type when a tile is picked', async () => {
		const onChange = vi.fn()
		render(<PropertyTypeGrid value="text" onChange={onChange} />)
		await userEvent.setup().click(screen.getByRole('radio', { name: 'Select' }))
		expect(onChange).toHaveBeenCalledWith('enum')
	})
})

describe('propertyTypeLabel', () => {
	it('names stored types the way the grid does', () => {
		expect(propertyTypeLabel('enum')).toBe('Select')
		expect(propertyTypeLabel('boolean')).toBe('Yes / No')
	})
})
