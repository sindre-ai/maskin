export function Steps({ steps }: { steps: string[] }) {
	return (
		<ol className="space-y-2">
			{steps.map((step, i) => (
				<li key={step} className="flex items-baseline gap-[11px]">
					<span
						aria-hidden="true"
						className="grid size-5 flex-none -translate-y-px place-items-center rounded-full bg-muted font-mono text-[10.5px] font-bold text-muted-foreground"
					>
						{i + 1}
					</span>
					<span className="min-w-0 text-[13px] leading-[1.55] text-foreground [text-wrap:pretty]">
						{step}
					</span>
				</li>
			))}
		</ol>
	)
}
