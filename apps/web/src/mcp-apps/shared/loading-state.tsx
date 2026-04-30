export function LoadingState() {
	return (
		<div className="p-4 flex flex-col gap-3">
			<div className="h-3 rounded-md bg-muted animate-pulse w-4/5" />
			<div className="h-3 rounded-md bg-muted animate-pulse w-3/5" />
			<div className="h-3 rounded-md bg-muted animate-pulse w-2/3" />
		</div>
	)
}
