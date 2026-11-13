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

	describe('add property keyboard', () => {
		const object = buildObjectResponse({ id: 'obj-1', type: 'bet', metadata: null })

		it('Esc closes the menu and returns focus to + Add property', async () => {
			const user = userEvent.setup()
			render(<MetadataPropertiesView {...baseProps} object={object} />)
			await user.click(screen.getByRole('button', { name: '+ Add property' }))
			expect(screen.getByText('+ Create new property')).toBeInTheDocument()

			await user.keyboard('{Escape}')
			const trigger = screen.getByRole('button', { name: '+ Add property' })
			expect(screen.queryByText('+ Create new property')).not.toBeInTheDocument()
			expect(trigger).toHaveFocus()
		})

		it('Esc cancels the create form and returns focus to + Add property', async () => {
			const user = userEvent.setup()
			render(<MetadataPropertiesView {...baseProps} object={object} />)
			await user.click(screen.getByRole('button', { name: '+ Add property' }))
			await user.click(screen.getByText('+ Create new property'))
			await user.type(screen.getByPlaceholderText(/Property name/), 'Due')

			await user.keyboard('{Escape}')
			expect(screen.queryByPlaceholderText(/Property name/)).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: '+ Add property' })).toHaveFocus()
		})

		it('Enter in Name creates the property', async () => {
			const user = userEvent.setup()
			const onCreateField = vi.fn()
			const onUpdateMetadata = vi.fn()
			render(
				<MetadataPropertiesView
					{...baseProps}
					object={object}
					onCreateField={onCreateField}
					onUpdateMetadata={onUpdateMetadata}
				/>,
			)
			await user.click(screen.getByRole('button', { name: '+ Add property' }))
			await user.click(screen.getByText('+ Create new property'))
			await user.type(screen.getByPlaceholderText(/Property name/), 'Owner{Enter}')

			expect(onCreateField).toHaveBeenCalledTimes(1)
			expect(onCreateField.mock.calls[0][2]).toEqual({ name: 'Owner', type: 'text' })
			expect(onUpdateMetadata).toHaveBeenCalledWith('obj-1', { Owner: '' })
		})

		it('Enter in Name does nothing while the name is empty', async () => {
			const user = userEvent.setup()
			const onCreateField = vi.fn()
			render(
				<MetadataPropertiesView {...baseProps} object={object} onCreateField={onCreateField} />,
			)
			await user.click(screen.getByRole('button', { name: '+ Add property' }))
			await user.click(screen.getByText('+ Create new property'))
			await user.type(screen.getByPlaceholderText(/Property name/), '{Enter}')

			expect(onCreateField).not.toHaveBeenCalled()
			expect(screen.getByPlaceholderText(/Property name/)).toBeInTheDocument()
		})

		it('Enter in Options creates an enum property', async () => {
			const user = userEvent.setup()
			const onCreateField = vi.fn()
			render(
				<MetadataPropertiesView {...baseProps} object={object} onCreateField={onCreateField} />,
			)
			await user.click(screen.getByRole('button', { name: '+ Add property' }))
			await user.click(screen.getByText('+ Create new property'))
			await user.type(screen.getByPlaceholderText(/Property name/), 'Stage')
			await user.click(screen.getByRole('button', { name: 'enum' }))
			await user.type(screen.getByPlaceholderText(/Options/), 'a, b{Enter}')

			expect(onCreateField.mock.calls[0][2]).toEqual({
				name: 'Stage',
				type: 'enum',
				values: ['a', 'b'],
			})
		})
	})
})
