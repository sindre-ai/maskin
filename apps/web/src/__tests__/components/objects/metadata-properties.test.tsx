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

	it('renders branch value as a GitHub tree link when both branch and repo are set', () => {
		const object = buildObjectResponse({
			metadata: {
				branch: 'bet/branch-one-click-link',
				repo: 'https://github.com/sindre-ai/maskin',
			},
		})
		render(<MetadataPropertiesView {...baseProps} object={object} />)
		const link = screen.getByRole('link', { name: 'bet/branch-one-click-link' })
		expect(link).toHaveAttribute(
			'href',
			'https://github.com/sindre-ai/maskin/tree/bet%2Fbranch-one-click-link',
		)
		expect(link).toHaveAttribute('target', '_blank')
		expect(link).toHaveAttribute('rel', 'noopener noreferrer')
	})

	it('trims trailing slash on repo before building the branch link', () => {
		const object = buildObjectResponse({
			metadata: {
				branch: 'main',
				repo: 'https://github.com/sindre-ai/maskin/',
			},
		})
		render(<MetadataPropertiesView {...baseProps} object={object} />)
		expect(screen.getByRole('link', { name: 'main' })).toHaveAttribute(
			'href',
			'https://github.com/sindre-ai/maskin/tree/main',
		)
	})

	it('renders branch as plain text when repo is missing', () => {
		const object = buildObjectResponse({ metadata: { branch: 'feature/x' } })
		render(<MetadataPropertiesView {...baseProps} object={object} />)
		expect(screen.getByText('feature/x')).toBeInTheDocument()
		expect(screen.queryByRole('link')).not.toBeInTheDocument()
	})

	it('does not link non-branch keys that happen to sit next to a repo', () => {
		const object = buildObjectResponse({
			metadata: { branch: 'main', repo: 'https://github.com/sindre-ai/maskin', priority: 'high' },
		})
		render(<MetadataPropertiesView {...baseProps} object={object} />)
		expect(screen.getAllByRole('link')).toHaveLength(1)
	})

	it('renders branch as plain text when repo is not a github.com URL', () => {
		const object = buildObjectResponse({
			metadata: { branch: 'main', repo: 'javascript:alert(document.cookie)' },
		})
		render(<MetadataPropertiesView {...baseProps} object={object} />)
		expect(screen.getByText('main')).toBeInTheDocument()
		expect(screen.queryByRole('link')).not.toBeInTheDocument()
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
