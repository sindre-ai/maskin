import { PropertiesPanel } from '@/components/objects/properties-panel'
import { render, screen } from '@testing-library/react'
import { buildObjectResponse } from '../../factories'

vi.mock('@/components/objects/metadata-properties', () => ({
	MetadataProperties: () => <div data-testid="metadata-properties" />,
}))

vi.mock('@/components/objects/object-files', () => ({
	ObjectFiles: () => <div data-testid="object-files" />,
}))

describe('PropertiesPanel', () => {
	it('renders MetadataProperties and ObjectFiles side-by-side', () => {
		const object = buildObjectResponse()
		render(<PropertiesPanel object={object} workspaceId="ws-1" />)
		expect(screen.getByTestId('metadata-properties')).toBeInTheDocument()
		expect(screen.getByTestId('object-files')).toBeInTheDocument()
	})
})
