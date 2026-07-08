import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import type { ObjectResponse, RelationshipResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { MetadataProperties } from './metadata-properties'
import { ObjectFiles } from './object-files'

interface PropertiesDrawerProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	object: ObjectResponse
	workspaceId: string
	relationships?: {
		asSource: RelationshipResponse[]
		asTarget: RelationshipResponse[]
	}
}

export function PropertiesDrawer({
	open,
	onOpenChange,
	object,
	workspaceId,
	relationships,
}: PropertiesDrawerProps) {
	const isMobile = useIsMobile()
	const side = isMobile ? 'bottom' : 'right'

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side={side}
				className={cn(
					'overflow-y-auto',
					isMobile ? 'max-h-[85dvh] rounded-t-lg rounded-b-none p-0' : 'w-full sm:max-w-sm p-0',
				)}
			>
				<SheetTitle className="px-6 pt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Properties
				</SheetTitle>
				<SheetDescription className="sr-only">
					Object properties and attached files
				</SheetDescription>
				<div className="px-6 pt-4 pb-6 space-y-6">
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
			</SheetContent>
		</Sheet>
	)
}
