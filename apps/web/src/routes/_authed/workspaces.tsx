import { createFileRoute, redirect } from '@tanstack/react-router'

// maskin.io is redirected to /workspaces at the Cloudflare edge. There is no
// workspaces page, so without this route the URL matches `/$workspaceId` with
// the id "workspaces" and never resolves. Hand off to the index route, which
// lands the user on their last-viewed workspace.
export const Route = createFileRoute('/_authed/workspaces')({
	beforeLoad: () => {
		throw redirect({ to: '/', replace: true })
	},
})
