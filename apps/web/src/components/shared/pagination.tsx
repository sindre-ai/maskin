import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface PaginationProps {
	total: number
	limit: number
	offset: number
	onPageChange: (offset: number) => void
	className?: string
}

export function Pagination({ total, limit, offset, onPageChange, className }: PaginationProps) {
	if (total <= limit) return null

	const currentPage = Math.floor(offset / limit) + 1
	const totalPages = Math.ceil(total / limit)
	const start = offset + 1
	const end = Math.min(offset + limit, total)

	return (
		<div className={cn('flex items-center justify-between pt-4', className)}>
			<span className="text-sm text-muted-foreground">
				{start}–{end} of {total}
			</span>
			<div className="flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={currentPage <= 1}
					onClick={() => onPageChange(offset - limit)}
				>
					<ChevronLeft size={16} />
					Previous
				</Button>
				<span className="text-sm text-muted-foreground px-2">
					{currentPage} / {totalPages}
				</span>
				<Button
					variant="outline"
					size="sm"
					disabled={currentPage >= totalPages}
					onClick={() => onPageChange(offset + limit)}
				>
					Next
					<ChevronRight size={16} />
				</Button>
			</div>
		</div>
	)
}
