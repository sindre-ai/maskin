import { useRouter } from '@tanstack/react-router'

export function RouteError({ error }: { error: Error }) {
	const router = useRouter()

	return (
		<div className="flex min-h-[50vh] items-center justify-center">
			<div className="text-center space-y-4 max-w-md">
				<h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
				<p className="text-sm text-muted-foreground">{error.message}</p>
				<button
					type="button"
					className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
					onClick={() => router.invalidate()}
				>
					Try again
				</button>
			</div>
		</div>
	)
}
