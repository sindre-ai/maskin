import { QueryState } from '@/components/shared/query-state'
import { Button } from '@/components/ui/button'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@/components/ui/table'
import { saveBlob, useDineroVatReport, useDownloadDineroVatCsv } from '@/hooks/use-dinero-review'
import type { DineroVatLine, DineroVatReport } from '@/lib/api'

export function money(n: number | null): string {
	return n === null ? '' : n.toLocaleString('da-DK', { minimumFractionDigits: 2 })
}

const DIRECTION_LABELS: Record<DineroVatLine['direction'], string> = {
	input: 'Purchases (input VAT)',
	output: 'Sales (output VAT)',
	none: 'No VAT',
	unknown: 'Not calculated here',
}

export function vatCodeLabel(code: string | null): string {
	return code ? `VAT ${code}` : 'No VAT code'
}

/**
 * The draft VAT report for the period: the booked lines of the log summed per VAT code, with the
 * receipt and the log entry behind every line. It is for checking before the owner approves and
 * files in Dinero. Dinero files VAT itself, so nothing here files anything.
 */
export function DineroVatReportSection({
	workspaceId,
	from,
	to,
}: {
	workspaceId: string
	from: string
	to: string
}) {
	const query = useDineroVatReport(workspaceId, from, to)
	const csv = useDownloadDineroVatCsv(workspaceId)

	return (
		<section aria-labelledby="dinero-vat-heading" className="flex flex-col gap-2">
			<h3 id="dinero-vat-heading" className="text-sm font-semibold text-foreground">
				VAT report (draft)
			</h3>
			<QueryState query={query} isEmpty={() => false} errorTitle="Couldn't load the VAT report">
				{(report) => (
					<>
						<div className="flex items-center gap-2">
							<Button
								size="sm"
								variant="outline"
								disabled={csv.isPending}
								onClick={() => csv.mutate({ from, to })}
							>
								Download spreadsheet
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() =>
									saveBlob(
										new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
										`vat-report-draft-${from}-${to}.json`,
									)
								}
							>
								Download data file
							</Button>
						</div>
						<VatReportBody report={report} />
					</>
				)}
			</QueryState>
		</section>
	)
}

function VatReportBody({ report }: { report: DineroVatReport }) {
	return (
		<div className="flex flex-col gap-2">
			<p className="text-xs text-muted-foreground">{report.notice}</p>
			{report.lines.length === 0 ? (
				<p className="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
					The flow has booked nothing in this period, so there is nothing to report.
				</p>
			) : (
				<div className="rounded-xl border border-border bg-card">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="min-w-40">VAT code</TableHead>
								<TableHead className="text-right">Lines</TableHead>
								<TableHead className="text-right">Incl. VAT</TableHead>
								<TableHead className="text-right">VAT</TableHead>
								<TableHead className="text-right">Net</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{report.lines.map((l) => (
								<VatCodeRows key={l.vat_code ?? 'none'} line={l} />
							))}
						</TableBody>
					</Table>
				</div>
			)}
			<p className="text-xs text-foreground">
				Input VAT {money(report.totals.input_vat)} · Output VAT {money(report.totals.output_vat)}
			</p>
			{!report.totals.complete && (
				<p className="text-xs text-muted-foreground">
					{report.totals.uncalculated_lines} lines use a VAT code this report does not calculate.
					Check those in Dinero.
				</p>
			)}
			<p className="text-xs text-muted-foreground">
				Export formats: spreadsheet and data file. Numina import: Not yet.
			</p>
		</div>
	)
}

function VatCodeRows({ line }: { line: DineroVatLine }) {
	const key = line.vat_code ?? 'none'
	return (
		<>
			<TableRow data-testid={`vat-code-${key}`}>
				<TableCell className="text-xs font-medium text-foreground">
					{vatCodeLabel(line.vat_code)}
					<span className="block font-normal text-muted-foreground">
						{DIRECTION_LABELS[line.direction]}
					</span>
				</TableCell>
				<TableCell className="text-right text-xs">{line.lines}</TableCell>
				<TableCell className="text-right text-xs">{money(line.amount_incl_vat)}</TableCell>
				<TableCell className="text-right text-xs">{money(line.vat_amount)}</TableCell>
				<TableCell className="text-right text-xs">{money(line.net_amount)}</TableCell>
			</TableRow>
			<TableRow>
				<TableCell colSpan={5} className="py-0">
					<details className="pb-2 text-xs">
						<summary className="cursor-pointer text-muted-foreground">
							Show the {line.lines} {line.lines === 1 ? 'line' : 'lines'} and their receipts
						</summary>
						<ul className="mt-1 flex flex-col gap-0.5">
							{line.entries.map((e, i) => (
								<li key={`${e.event_id}-${i}`} data-testid={`vat-line-${e.event_id}`}>
									{e.voucher_date ?? ''} {e.description ?? ''} · {money(e.amount_incl_vat)}
									{e.vat_amount !== null ? ` (VAT ${money(e.vat_amount)})` : ''} · Receipt:{' '}
									{e.receipt?.file_name ?? e.receipt?.file_guid ?? 'not in the log'} ·{' '}
									<a className="underline" href={`#dinero-item-${e.event_id}`}>
										Log entry {e.event_id}
									</a>
								</li>
							))}
						</ul>
					</details>
				</TableCell>
			</TableRow>
		</>
	)
}
