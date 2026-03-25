import { Button } from '@/components/ui/button'
import { useRouter } from '@tanstack/react-router'

export function RouteError({ error }: { error: Error }) {
	const router = useRouter()

	return (
		<div className="flex min-h-[50vh] items-center justify-center">
			<div className="text-center space-y-4 max-w-md">
				<h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
				<p className="text-sm text-muted-foreground">{error.message}</p>
				<Button onClick={() => router.invalidate()}>Try again</Button>
			</div>
		</div>
	)
}
