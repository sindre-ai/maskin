import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { ChatSectionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useDroppable } from '@dnd-kit/core'
import { ChevronDown, MoreHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { SectionNameForm } from './section-name-form'

/** The drop id of a section; the list's own groups share one id that means "back to the list". */
export const SECTION_DROP_PREFIX = 'drop-section:'
export const LIST_DROP_PREFIX = 'drop-list:'

/**
 * One of the person's sections: a header (chevron, name, count, a `···` menu for rename, move and
 * delete) over its rows. The whole block takes a dropped chat. An empty section draws the dashed
 * target with the way in for people who do not drag.
 */
export function ChatSectionGroup({
	section,
	count,
	canMoveUp,
	canMoveDown,
	renaming,
	sections,
	onToggle,
	onStartRename,
	onRename,
	onCancelRename,
	onMove,
	onDelete,
	children,
}: {
	section: ChatSectionResponse
	count: number
	canMoveUp: boolean
	canMoveDown: boolean
	renaming: boolean
	sections: ChatSectionResponse[]
	onToggle: () => void
	onStartRename: () => void
	onRename: (name: string) => Promise<unknown> | undefined
	onCancelRename: () => void
	onMove: (direction: -1 | 1) => void
	onDelete: () => void
	children: ReactNode
}) {
	const { setNodeRef, isOver } = useDroppable({ id: `${SECTION_DROP_PREFIX}${section.id}` })
	const collapsed = section.collapsed
	return (
		<div
			ref={setNodeRef}
			data-testid={`chat-section-${section.id}`}
			className={cn(
				'flex flex-col gap-px rounded-xl transition-colors',
				isOver && 'bg-accent ring-2 ring-brand',
			)}
		>
			<div className="group/section flex items-center gap-2 px-2 pt-3.5 pb-3 text-[15px]">
				{renaming ? (
					<div className="min-w-0 flex-1">
						<SectionNameForm
							initialName={section.name}
							submitLabel="Rename"
							sections={sections}
							exceptId={section.id}
							onSubmit={onRename}
							onCancel={onCancelRename}
						/>
					</div>
				) : (
					<button
						type="button"
						aria-expanded={!collapsed}
						onClick={onToggle}
						className="flex min-w-0 items-center gap-2 rounded-md font-semibold text-foreground"
					>
						<ChevronDown
							size={14}
							aria-hidden
							className={cn(
								'shrink-0 text-muted-foreground transition-transform',
								collapsed && '-rotate-90',
							)}
						/>
						<span className="truncate">{section.name}</span>
						<span className="font-medium text-muted-foreground">{count}</span>
					</button>
				)}
				{renaming ? null : (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								aria-label={`Section options for ${section.name}`}
								className="ml-auto grid h-[22px] w-6 shrink-0 place-items-center rounded-full text-muted-foreground opacity-0 hover:bg-secondary hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/section:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
							>
								<MoreHorizontal size={14} aria-hidden />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onSelect={onStartRename}>Rename</DropdownMenuItem>
							<DropdownMenuItem disabled={!canMoveUp} onSelect={() => onMove(-1)}>
								Move up
							</DropdownMenuItem>
							<DropdownMenuItem disabled={!canMoveDown} onSelect={() => onMove(1)}>
								Move down
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={onDelete}>Delete section</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
			{collapsed ? null : count === 0 ? (
				<div className="mx-2 mb-2 rounded-xl border border-dashed border-border px-3 py-4 text-center">
					<p className="text-[13px] font-semibold text-foreground">
						No chats in {section.name} yet.
					</p>
					<p className="mt-0.5 text-xs text-muted-foreground">
						Drag a chat here, or use More on a chat and choose Move to section.
					</p>
				</div>
			) : (
				children
			)}
		</div>
	)
}

/** The rest of the list takes a chat dropped out of a section. */
export function ListDropZone({ id, children }: { id: string; children: ReactNode }) {
	const { setNodeRef, isOver } = useDroppable({ id: `${LIST_DROP_PREFIX}${id}` })
	return (
		<div ref={setNodeRef} className={cn('rounded-xl', isOver && 'bg-accent')}>
			{children}
		</div>
	)
}
