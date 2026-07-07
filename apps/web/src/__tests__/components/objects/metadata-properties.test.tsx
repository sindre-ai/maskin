import { MetadataPropertiesView } from '@/components/objects/metadata-properties'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse, buildWorkspaceWithRole } from '../../factories'

describe('MetadataPropertiesView', () => {
	const workspace = buildWorkspaceWithRole({ settings: {} })
	const baseProps = {
		workspace,
		onUpdateMetadata: vi.fn(),
		onRemoveMetadata: vi.fn(),
	}

	it('shows "+ Add property" button when no metadata entries and no defined fields', () => {
		const object = buildObjectResponse({ metadata: null })
		render(<MetadataPropertiesView {...baseProps} object={object} />)
		expect(screen.getByText('+ Add property')).toBeInTheDocument()
	})

	it('renders property rows for each metadata entry', () => {
		const object = buildObjectResponse({
			metadata: { priority: 'high', team: 'alpha' },
		})
		render(<MetadataPropertiesView {...baseProps} object={object} />)
		expect(screen.getByText('priority')).toBeInTheDocument()
		expect(screen.getByText('team')).toBeInTheDocument()
	})

	it('filters out _ prefixed keys', () => {
		const object = buildObjectResponse({
			metadata: { _hidden: 'secret', visible: 'shown' },
		})
		render(<MetadataPropertiesView {...baseProps} object={object} />)
		expect(screen.queryByText('_hidden')).not.toBeInTheDocument()
		expect(screen.getByText('visible')).toBeInTheDocument()
	})

	it('calls onRemoveMetadata when remove clicked', async () => {
		const user = userEvent.setup()
		const onRemoveMetadata = vi.fn()
		const object = buildObjectResponse({ id: 'obj-1', metadata: { priority: 'high' } })

		render(
			<MetadataPropertiesView {...baseProps} object={object} onRemoveMetadata={onRemoveMetadata} />,
		)

		await user.click(screen.getByTitle('Remove property'))
		expect(onRemoveMetadata).toHaveBeenCalledWith('obj-1', 'priority')
	})

	it('displays boolean values as Yes/No', () => {
		const object = buildObjectResponse({ metadata: { approved: true } })
		render(<MetadataPropertiesView {...baseProps} object={object} />)
		expect(screen.getByText('Yes')).toBeInTheDocument()
	})

	it('displays number values', () => {
		const object = buildObjectResponse({ metadata: { score: 42 } })
		render(<MetadataPropertiesView {...baseProps} object={object} />)
		expect(screen.getByText('42')).toBeInTheDocument()
	})

	it('commits a text property edit on blur', async () => {
		const user = userEvent.setup()
		const onUpdateMetadata = vi.fn()
		const object = buildObjectResponse({ id: 'obj-1', metadata: { team: 'alpha' } })
		render(
			<MetadataPropertiesView {...baseProps} object={object} onUpdateMetadata={onUpdateMetadata} />,
		)
		await user.click(screen.getByText('alpha'))
		const input = screen.getByDisplayValue('alpha')
		await user.clear(input)
		await user.type(input, 'beta')
		fireEvent.blur(input)
		expect(onUpdateMetadata).toHaveBeenCalledWith('obj-1', { team: 'beta' })
	})
})
