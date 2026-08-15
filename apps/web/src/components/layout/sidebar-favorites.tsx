import { SidebarNavItem } from '@/components/layout/sidebar-nav-item'
import { SidebarGroup, SidebarGroupLabel, SidebarMenu } from '@/components/ui/sidebar'
import { useFiles } from '@/hooks/use-files'
import { getPinnedFileIds } from '@/lib/pinned-files'
import { useWorkspace } from '@/lib/workspace-context'
import { Star } from 'lucide-react'

// Favorites group: renders pinned mini-apps as references to live file objects.
// Pinned ids are per-workspace settings; each item links back through the same
// sandboxed files-viewer route as any other file. Only what resolves renders —
// a deleted file stops appearing instead of dead-linking, and a freshly regen'd
// file (same id, new bytes) opens current.
export function SidebarFavorites() {
	const { workspace, workspaceId } = useWorkspace()
	const pinnedIds = getPinnedFileIds(workspace)
	const { data: files } = useFiles(workspaceId, { ids: pinnedIds })

	if (pinnedIds.length === 0 || !files?.length) return null

	return (
		<SidebarGroup>
			<SidebarGroupLabel>Favorites</SidebarGroupLabel>
			<SidebarMenu>
				{files.map((file) => (
					<SidebarNavItem
						key={file.id}
						item={{
							key: `favorites:${file.id}`,
							label: file.name,
							to: '/$workspaceId/files/$fileId',
							icon: Star,
							exact: true,
						}}
						params={{ fileId: file.id }}
						source="favorites"
					/>
				))}
			</SidebarMenu>
		</SidebarGroup>
	)
}
