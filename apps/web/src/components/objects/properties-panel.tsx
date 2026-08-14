import type { ObjectResponse, RelationshipResponse } from '@/lib/api'
import { MetadataProperties } from './metadata-properties'
import { ObjectFiles } from './object-files'

/**
 * Metadata + attached files section that used to live inside the old
 * `PropertiesDrawer`. Extracted so both the main app's right sidebar and the
 * MCP-Apps object surface can render the same content without duplicating the
 * two child components.
 */
export function PropertiesPanel({
	object,
	workspaceId,
	relationships,
}: {
	object: ObjectResponse
	workspaceId: string
	relationships?: {
		asSource: RelationshipResponse[]
		asTarget: RelationshipResponse[]
	}
}) {
	return (
		<div className="space-y-6">
			<section>
				<MetadataProperties object={object} />
			</section>
			<section className="pt-2 border-t border-border">
				<ObjectFiles
					workspaceId={workspaceId}
					objectId={object.id}
					objectType={object.type}
					relationships={relationships}
				/>
			</section>
		</div>
	)
}
