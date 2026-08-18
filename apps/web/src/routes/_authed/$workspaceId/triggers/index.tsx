import { createFileRoute, redirect } from '@tanstack/react-router'

/**
 * v2 folds triggers into Loops: the Loops list renders every standalone trigger
 * under "Not tied to a loop", and the sidebar has no Triggers entry. Keeping a
 * second surface that lists the same rows would guarantee drift, so this route
 * redirects instead of being deleted — `/{ws}/triggers` bookmarks and
 * `lib/navigation.ts`'s trigger entity resolution both keep resolving, and
 * `/{ws}/triggers/{id}` stays fully mounted.
 */
export const Route = createFileRoute('/_authed/$workspaceId/triggers/')({
	beforeLoad: ({ params }) => {
		throw redirect({ to: '/$workspaceId/loops', params: { workspaceId: params.workspaceId } })
	},
})
