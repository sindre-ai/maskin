import { MetadataBadgesView } from '@/components/objects/metadata-badges'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse } from '../../factories'

describe('MetadataBadgesView', () => {
	it('returns null when metadata is null', () => {
		const object = buildObjectResponse({ metadata: null })
		const { container } = render(<MetadataBadgesView object={object} />)
		expect(container.firstChild).toBeNull()
	})

	it('returns null when metadata only has _ prefixed keys', () => {
		const object = buildObjectResponse({ metadata: { _internal: 'hidden' } })
		const { container } = render(<MetadataBadgesView object={object} />)
		expect(container.firstChild).toBeNull()
	})

	it('renders badges for each metadata entry', () => {
		const object = buildObjectResponse({ metadata: { priority: 'high', team: 'alpha' } })
		render(<MetadataBadgesView object={object} />)
		expect(screen.getByText('priority:')).toBeInTheDocument()
		expect(screen.getByText('high')).toBeInTheDocument()
		expect(screen.getByText('team:')).toBeInTheDocument()
		expect(screen.getByText('alpha')).toBeInTheDocument()
	})

	it('formats boolean values as Yes/No', () => {
		const object = buildObjectResponse({ metadata: { approved: true, archived: false } })
		render(<MetadataBadgesView object={object} />)
		expect(screen.getByText('Yes')).toBeInTheDocument()
		expect(screen.getByText('No')).toBeInTheDocument()
	})

	it('shows remove button when onRemove provided', () => {
		const object = buildObjectResponse({ metadata: { priority: 'high' } })
		render(<MetadataBadgesView object={object} onRemove={vi.fn()} />)
		expect(screen.getByTitle('Remove field')).toBeInTheDocument()
	})

	it('does not show remove button when onRemove is not provided', () => {
		const object = buildObjectResponse({ metadata: { priority: 'high' } })
		render(<MetadataBadgesView object={object} />)
		expect(screen.queryByTitle('Remove field')).not.toBeInTheDocument()
	})

	it('calls onRemove with correct key', async () => {
		const user = userEvent.setup()
		const onRemove = vi.fn()
		const object = buildObjectResponse({ metadata: { priority: 'high' } })

		render(<MetadataBadgesView object={object} onRemove={onRemove} />)

		await user.click(screen.getByTitle('Remove field'))
		expect(onRemove).toHaveBeenCalledWith('priority')
	})

	it('filters out _ prefixed keys but shows others', () => {
		const object = buildObjectResponse({
			metadata: { _hidden: 'secret', visible: 'shown' },
		})
		render(<MetadataBadgesView object={object} />)
		expect(screen.queryByText('_hidden:')).not.toBeInTheDocument()
		expect(screen.getByText('visible:')).toBeInTheDocument()
	})
})
