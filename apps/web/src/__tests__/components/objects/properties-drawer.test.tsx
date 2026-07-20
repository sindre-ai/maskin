import { PropertiesDrawer } from '@/components/objects/properties-drawer'
import { render, screen } from '@testing-library/react'
import { buildObjectResponse } from '../../factories'

vi.mock('@/components/objects/metadata-properties', () => ({
	MetadataProperties: () => <div data-testid="metadata-properties" />,
}))

vi.mock('@/components/objects/object-files', () => ({
	ObjectFiles: () => <div data-testid="object-files" />,
}))

vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => false,
}))

describe('PropertiesDrawer', () => {
	it('does not render contents when closed', () => {
		const object = buildObjectResponse()
		render(
			<PropertiesDrawer open={false} onOpenChange={vi.fn()} object={object} workspaceId="ws-1" />,
		)
		expect(screen.queryByTestId('metadata-properties')).not.toBeInTheDocument()
		expect(screen.queryByTestId('object-files')).not.toBeInTheDocument()
	})

	it('renders Properties heading, MetadataProperties, and ObjectFiles when open', () => {
		const object = buildObjectResponse()
		render(
			<PropertiesDrawer open={true} onOpenChange={vi.fn()} object={object} workspaceId="ws-1" />,
		)
		expect(screen.getByText('Properties')).toBeInTheDocument()
		expect(screen.getByTestId('metadata-properties')).toBeInTheDocument()
		expect(screen.getByTestId('object-files')).toBeInTheDocument()
	})
})
