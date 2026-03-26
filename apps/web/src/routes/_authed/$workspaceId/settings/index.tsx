import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { cn } from '@/lib/cn'
import { type Theme, useTheme } from '@/lib/theme'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/')({
	component: GeneralPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function GeneralPage() {
	const { workspace, workspaceId } = useWorkspace()
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const [name, setName] = useState(workspace.name)

	const handleSave = () => {
		if (name !== workspace.name) {
			updateWorkspace.mutate({ name })
		}
	}

	return (
		<div className="max-w-lg space-y-6">
			<div>
				<Label className="mb-1 text-muted-foreground">Workspace name</Label>
				<div className="flex gap-2">
					<Input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						className="flex-1"
					/>
					<Button
						onClick={handleSave}
						disabled={name === workspace.name || updateWorkspace.isPending}
					>
						Save
					</Button>
				</div>
			</div>

			<div className="border-t border-border pt-6">
				<ThemePicker />
			</div>
		</div>
	)
}

const themeOptions: { value: Theme; label: string; icon: typeof Sun }[] = [
	{ value: 'light', label: 'Light', icon: Sun },
	{ value: 'dark', label: 'Dark', icon: Moon },
	{ value: 'system', label: 'System', icon: Monitor },
]

function ThemePicker() {
	const { theme, setTheme } = useTheme()

	return (
		<div>
			<Label className="mb-2 text-muted-foreground">Appearance</Label>
			<div className="flex gap-1 rounded-lg border border-border bg-background p-1">
				{themeOptions.map((option) => {
					const Icon = option.icon
					const isActive = theme === option.value
					return (
						<button
							key={option.value}
							type="button"
							onClick={() => setTheme(option.value)}
							className={cn(
								'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
								isActive
									? 'bg-muted text-foreground font-medium shadow-sm'
									: 'text-muted-foreground hover:text-muted-foreground',
							)}
						>
							<Icon size={14} />
							{option.label}
						</button>
					)
				})}
			</div>
		</div>
	)
}
