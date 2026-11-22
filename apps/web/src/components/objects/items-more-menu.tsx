import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useCreateViewWithAgent } from '@/hooks/use-create-view-with-agent'
import { CREATE_VIEW_LABEL } from '@/lib/create-view-message'
import type { ObjectsFilterModel } from '@/lib/objects-filter-model'
import { LayoutDashboard, MoreHorizontal } from 'lucide-react'

/**
 * The Items list's three-dot menu. Today it holds one item, so it renders nothing
 * when that item is not available (flag off, a viewer, no Design Studio).
 */
export function ItemsMoreMenu({ filters }: { filters: ObjectsFilterModel }) {
	const createView = useCreateViewWithAgent()
	if (!createView.open) return null
	const open = createView.open
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="h-7 w-7 text-muted-foreground"
					aria-label="More actions"
				>
					<MoreHorizontal size={15} />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onSelect={() => open({ kind: 'list', filters })}>
					<LayoutDashboard size={14} /> {CREATE_VIEW_LABEL}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
