import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/cn'
import { type DiffLineRow, diffLines } from '@/lib/reconcile/diff-lines'
import { useMemo } from 'react'

interface ReconcileDiffOverlayProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	mine: string
	theirs: string
	onKeepMine: () => void
	onTakeTheirs: () => void
	busy?: boolean
}

// Side-by-side markdown diff. Renders the two source-markdown strings — not
// the rendered HTML — per the task's serializer-stability constraint.
export function ReconcileDiffOverlay({
	open,
	onOpenChange,
	mine,
	theirs,
	onKeepMine,
	onTakeTheirs,
	busy = false,
}: ReconcileDiffOverlayProps) {
	const rows = useMemo(() => diffLines(mine, theirs), [mine, theirs])
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>Review conflict</DialogTitle>
					<DialogDescription>
						Compare your version with the server's, then choose which to keep.
					</DialogDescription>
				</DialogHeader>
				<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
					<DiffColumn label="Mine (unsaved)" side="mine" rows={rows} />
					<DiffColumn label="Theirs (server)" side="theirs" rows={rows} />
				</div>
				<DialogFooter>
					<Button variant="destructive" onClick={onTakeTheirs} disabled={busy}>
						Take theirs
					</Button>
					<Button onClick={onKeepMine} disabled={busy}>
						Keep mine
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function DiffColumn({
	label,
	side,
	rows,
}: {
	label: string
	side: 'mine' | 'theirs'
	rows: DiffLineRow[]
}) {
	return (
		<div className="flex flex-col overflow-hidden rounded border border-border">
			<div className="border-b border-border bg-muted/40 px-2 py-1 text-xs font-medium text-muted-foreground">
				{label}
			</div>
			<div className="max-h-[50vh] overflow-auto font-mono text-xs leading-relaxed">
				{rows.map((row, idx) => {
					const value = side === 'mine' ? row.mine : row.theirs
					const isChangedHere =
						row.kind === side ||
						(row.kind === (side === 'mine' ? 'theirs' : 'mine') && value == null)
					return (
						<div
							key={`${side}-${idx}-${row.kind}`}
							className={cn(
								'whitespace-pre-wrap break-words px-2 py-0.5',
								value == null && 'bg-muted/30 text-muted-foreground/60',
								row.kind === side && side === 'mine' && 'bg-warning/10',
								row.kind === side && side === 'theirs' && 'bg-success/10',
								row.kind === 'both' && !isChangedHere && '',
							)}
						>
							{value ?? '\u00A0'}
						</div>
					)
				})}
			</div>
		</div>
	)
}
