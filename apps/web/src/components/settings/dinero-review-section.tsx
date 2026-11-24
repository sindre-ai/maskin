import { QueryState } from '@/components/shared/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { useCanWrite } from '@/hooks/use-can-write'
import {
	useApproveDineroBooks,
	useDineroReviewLog,
	useReverseDineroItem,
} from '@/hooks/use-dinero-review'
import type { DineroReviewItem, DineroReviewLog } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { useState } from 'react'

const DAY_MS = 86_400_000

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

const TOOL_LABELS: Record<string, string> = {
	CreatePurchaseVoucher: 'Saved a purchase draft',
	CreateFinanceVoucher: 'Saved a finance voucher draft',
	upload_file: 'Uploaded a receipt',
	BookVoucher: 'Booked a purchase voucher',
	add_purchase_payment: 'Registered a payment on a bill',
	add_invoice_payment: 'Registered a payment on an invoice',
}

function actionLabel(item: DineroReviewItem): string {
	if (item.reverses_event_id !== null) return `Counter-posting for entry ${item.reverses_event_id}`
	if (item.tool === 'CreateFinanceVoucher' && item.booked) return 'Booked a finance voucher'
	return TOOL_LABELS[item.tool] ?? item.tool
}

function money(n: number | null): string {
	return n === null ? '' : n.toLocaleString('da-DK', { minimumFractionDigits: 2 })
}

/** Only a person who is an admin or owner can open the review; the server refuses everyone else. */
function useCanReview(): boolean {
	const { workspace } = useWorkspace()
	const canWrite = useCanWrite()
	const me = getStoredActor()
	return (
		canWrite && me?.type === 'human' && (workspace.role === 'owner' || workspace.role === 'admin')
	)
}

/**
 * Settings → Dinero review. One screen with the whole log of what the flow did in Dinero for a
 * period, what changed and what it flagged. A booked item can be reversed (Dinero cannot delete a
 * booked voucher, so this adds a counter-posting). At the end one button, Approve the books, which
 * closes the period on our side. Until it is pressed nothing leaves the flow.
 */
export function DineroReviewSection({ workspaceId }: { workspaceId: string }) {
	const today = new Date()
	const [from, setFrom] = useState(isoDay(new Date(today.getTime() - 30 * DAY_MS)))
	const [to, setTo] = useState(isoDay(today))
	const canReview = useCanReview()
	const query = useDineroReviewLog(workspaceId, from, to)

	if (!canReview) {
		return (
			<p className="text-xs text-muted-foreground">
				Only a workspace admin or owner can open the Dinero review.
			</p>
		)
	}

	return (
		<section aria-labelledby="dinero-review-heading" className="flex flex-col gap-3">
			<div className="flex flex-col gap-1">
				<h2 id="dinero-review-heading" className="text-sm font-semibold text-foreground">
					Dinero review
				</h2>
				<p className="text-xs text-muted-foreground">
					Everything the flow did in Dinero in this period: what it saved or booked, the figures,
					and what Dinero answered. Reverse a booked item and a counter-posting is booked in Dinero,
					because a booked voucher cannot be deleted there. When you are happy, approve the books.
					Until you do, nothing leaves the flow.
				</p>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<label
					htmlFor="dinero-review-from"
					className="flex items-center gap-1.5 text-xs text-muted-foreground"
				>
					From
					<Input
						id="dinero-review-from"
						type="date"
						className="h-8 w-36"
						value={from}
						max={to}
						onChange={(e) => e.target.value && setFrom(e.target.value)}
					/>
				</label>
				<label
					htmlFor="dinero-review-to"
					className="flex items-center gap-1.5 text-xs text-muted-foreground"
				>
					To
					<Input
						id="dinero-review-to"
						type="date"
						className="h-8 w-36"
						value={to}
						min={from}
						onChange={(e) => e.target.value && setTo(e.target.value)}
					/>
				</label>
			</div>
			<QueryState query={query} isEmpty={() => false} errorTitle="Couldn't load the Dinero review">
				{(log) => <ReviewBody workspaceId={workspaceId} log={log} />}
			</QueryState>
		</section>
	)
}

function ReviewBody({ workspaceId, log }: { workspaceId: string; log: DineroReviewLog }) {
	const reverse = useReverseDineroItem(workspaceId)
	const approve = useApproveDineroBooks(workspaceId)
	const [reversing, setReversing] = useState<DineroReviewItem | null>(null)
	const [approving, setApproving] = useState(false)
	const closed = log.approval !== null
	const booked = log.items.filter((i) => i.booked && i.reversed_by_event_id === null).length

	return (
		<>
			{closed && log.approval && (
				<output className="block rounded-xl border border-border bg-card p-3 text-xs text-foreground">
					The books for {log.from} to {log.to} were approved on{' '}
					{new Date(log.approval.approved_at).toLocaleString()}. The period is closed: nothing can
					be reversed here and the flow cannot change it.
				</output>
			)}
			{log.truncated && (
				<p className="text-xs text-muted-foreground">
					Only the first 2000 entries are shown. Choose a shorter period.
				</p>
			)}
			{log.items.length === 0 ? (
				<p className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
					The flow has not done anything in Dinero in this period.
				</p>
			) : (
				<div className="rounded-xl border border-border bg-card">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="min-w-32">When</TableHead>
								<TableHead className="min-w-48">What</TableHead>
								<TableHead className="min-w-64">Figures (incl. VAT)</TableHead>
								<TableHead className="min-w-40">Dinero said</TableHead>
								<TableHead className="min-w-28">State</TableHead>
								<TableHead className="w-28" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{log.items.map((item) => (
								<TableRow key={item.event_id} data-testid={`dinero-item-${item.event_id}`}>
									<TableCell className="text-xs text-muted-foreground">
										{item.at ? new Date(item.at).toLocaleString() : ''}
									</TableCell>
									<TableCell className="text-xs font-medium text-foreground">
										{actionLabel(item)}
										{item.voucher_date && (
											<span className="block font-normal text-muted-foreground">
												Voucher date {item.voucher_date}
											</span>
										)}
									</TableCell>
									<TableCell className="text-xs">
										{item.lines.length === 0 ? (
											<span className="text-muted-foreground">No lines</span>
										) : (
											<ul className="flex flex-col gap-0.5">
												{item.lines.map((l, i) => (
													// biome-ignore lint/suspicious/noArrayIndexKey: the lines have no id
													<li key={i}>
														{money(l.amount)} {l.description ?? ''}
														<span className="text-muted-foreground">
															{[
																l.account !== null ? `account ${l.account}` : null,
																l.counter_account !== null ? `against ${l.counter_account}` : null,
																l.vat_code ? `VAT ${l.vat_code}` : null,
															]
																.filter(Boolean)
																.map((t) => ` · ${t}`)
																.join('')}
														</span>
													</li>
												))}
											</ul>
										)}
									</TableCell>
									<TableCell className="max-w-64 truncate text-xs text-muted-foreground">
										{item.result ?? ''}
									</TableCell>
									<TableCell>
										<ItemState item={item} />
									</TableCell>
									<TableCell>
										{item.can_reverse && !closed && (
											<Button
												size="sm"
												variant="outline"
												disabled={reverse.isPending}
												onClick={() => setReversing(item)}
											>
												Reverse
											</Button>
										)}
										{item.booked &&
											item.cannot_reverse_because &&
											item.reversed_by_event_id === null && (
												<span className="text-xs text-muted-foreground">
													{item.cannot_reverse_because}
												</span>
											)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
			<div className="flex items-center justify-end gap-3">
				<Button disabled={closed || approve.isPending} onClick={() => setApproving(true)}>
					Approve the books
				</Button>
			</div>

			<Dialog open={reversing !== null} onOpenChange={(open) => !open && setReversing(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Reverse this entry?</DialogTitle>
						<DialogDescription>
							A booked voucher cannot be deleted in Dinero. This books a counter-posting with the
							same lines and the opposite sign, dated {reversing?.voucher_date}, and adds a line to
							this log. You can do it until you approve the books. After that the period is closed.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setReversing(null)}>
							Cancel
						</Button>
						<Button
							disabled={reverse.isPending}
							onClick={() => {
								if (reversing)
									reverse.mutate(reversing.event_id, { onSettled: () => setReversing(null) })
							}}
						>
							Reverse in Dinero
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={approving} onOpenChange={setApproving}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Approve the books?</DialogTitle>
						<DialogDescription>
							You approve {log.items.length} log entries ({booked} booked and not reversed) for{' '}
							{log.from} to {log.to}. This records who approved and when, and closes the period on
							our side: the flow can no longer change Dinero while today is inside it, and you can
							no longer reverse items here. Dinero's own rules apply after that. Nothing is filed
							with SKAT by this.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setApproving(false)}>
							Cancel
						</Button>
						<Button
							disabled={approve.isPending}
							onClick={() =>
								approve.mutate(
									{ from: log.from, to: log.to, figures_hash: log.figures_hash },
									{ onSettled: () => setApproving(false) },
								)
							}
						>
							Approve the books
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	)
}

function ItemState({ item }: { item: DineroReviewItem }) {
	if (item.outcome !== 'success') return <Badge variant="destructive">Failed</Badge>
	if (item.reversed_by_event_id !== null) return <Badge variant="secondary">Reversed</Badge>
	if (item.reverses_event_id !== null) return <Badge variant="secondary">Counter-posting</Badge>
	if (item.booked) return <Badge variant="live">Booked</Badge>
	return <Badge variant="outline">Draft</Badge>
}
