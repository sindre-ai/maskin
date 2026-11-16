import {
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import type { ChatSectionResponse } from '@/lib/api'

/**
 * "Move to section" in a chat row's `···` menu: the route for people who do not drag. Lists the
 * person's sections, "Remove from {name}" when the chat sits in one, and "New section..." which
 * moves the chat in once the name is added.
 */
export function MoveToSectionMenu({
	sections,
	currentSectionId,
	onMove,
	onNewSection,
}: {
	sections: ChatSectionResponse[]
	currentSectionId: string | null
	onMove: (sectionId: string | null) => void
	onNewSection: () => void
}) {
	const current = sections.find((s) => s.id === currentSectionId)
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>Move to section</DropdownMenuSubTrigger>
			<DropdownMenuSubContent>
				{sections.map((s) => (
					<DropdownMenuItem
						key={s.id}
						disabled={s.id === currentSectionId}
						onSelect={() => onMove(s.id)}
					>
						{s.name}
					</DropdownMenuItem>
				))}
				{sections.length > 0 ? <DropdownMenuSeparator /> : null}
				<DropdownMenuItem onSelect={onNewSection}>New section...</DropdownMenuItem>
				{current ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={() => onMove(null)}>
							Remove from {current.name}
						</DropdownMenuItem>
					</>
				) : null}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	)
}
