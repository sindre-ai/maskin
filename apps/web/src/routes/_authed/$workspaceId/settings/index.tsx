import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useCustomExtensions } from '@/hooks/use-custom-extensions'
import { useEnabledModules } from '@/hooks/use-enabled-modules'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { queryKeys } from '@/lib/query-keys'
import { type Theme, useTheme } from '@/lib/theme'
import { useWorkspace } from '@/lib/workspace-context'
import { getAllWebModules } from '@maskin/module-sdk'
import { useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Monitor, Moon, Sun, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

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
				<ExtensionsSection />
			</div>

			<div className="border-t border-border pt-6">
				<ThemePicker />
			</div>
		</div>
	)
}

function ExtensionsSection() {
	const { workspace, workspaceId } = useWorkspace()
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const queryClient = useQueryClient()
	const settings = workspace.settings as Record<string, unknown>
	const enabledModules = useEnabledModules()
	const allModules = getAllWebModules()
	const customExtensions = useCustomExtensions()
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

	const handleToggle = async (moduleId: string, enabled: boolean) => {
		// Enabling delegates to the server endpoint, which performs the full
		// settings merge AND seeds the module's defaultAgents + defaultTriggers
		// idempotently. The client-side settings merge isn't enough because it
		// can't create actors/triggers.
		if (enabled) {
			try {
				const result = await api.workspaces.enableModule(workspaceId, moduleId)
				queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all() })
				queryClient.invalidateQueries({ queryKey: queryKeys.actors.all(workspaceId) })
				queryClient.invalidateQueries({ queryKey: queryKeys.triggers.all(workspaceId) })
				const seeded = result.agents_created + result.triggers_created
				if (seeded > 0) {
					toast.success(
						`Enabled — seeded ${result.agents_created} agent(s) and ${result.triggers_created} trigger(s)`,
					)
				}
			} catch {
				toast.error('Failed to enable extension')
			}
			return
		}

		// Disabling: just remove from enabled_modules. We deliberately leave
		// any seeded agents/triggers in place — the user can delete them
		// manually if they want a clean wipe.
		const next = enabledModules.filter((m) => m !== moduleId)
		updateWorkspace.mutate(
			{ settings: { ...settings, enabled_modules: next } },
			{ onError: () => toast.error('Failed to update extensions') },
		)
	}

	const handleToggleCustomExtension = (extId: string, enabled: boolean) => {
		const customExts = {
			...((settings?.custom_extensions as Record<string, unknown>) ?? {}),
		}
		const existing = customExts[extId] as Record<string, unknown>
		customExts[extId] = { ...existing, enabled }

		updateWorkspace.mutate(
			{ settings: { ...settings, custom_extensions: customExts } },
			{ onError: () => toast.error('Failed to update extension') },
		)
	}

	const handleDeleteCustomExtension = (extId: string, types: string[]) => {
		const statuses = { ...((settings?.statuses as Record<string, string[]>) ?? {}) }
		const displayNames = { ...((settings?.display_names as Record<string, string>) ?? {}) }
		const fieldDefs = {
			...((settings?.field_definitions as Record<string, unknown[]>) ?? {}),
		}
		const customExts = {
			...((settings?.custom_extensions as Record<string, unknown>) ?? {}),
		}

		for (const type of types) {
			delete statuses[type]
			delete displayNames[type]
			delete fieldDefs[type]
		}
		delete customExts[extId]

		updateWorkspace.mutate(
			{
				settings: {
					...settings,
					statuses,
					display_names: displayNames,
					field_definitions: fieldDefs,
					custom_extensions: customExts,
				},
			},
			{ onError: () => toast.error('Failed to delete extension') },
		)
	}

	return (
		<div>
			<Label className="mb-1 text-muted-foreground">Extensions</Label>
			<p className="text-sm text-muted-foreground mb-3">
				Enable or disable extensions for this workspace.
			</p>
			<div className="space-y-3">
				{allModules.map((mod) => {
					const isEnabled = enabledModules.includes(mod.id)
					return (
						<div
							key={mod.id}
							className="flex items-center justify-between rounded-lg border border-border p-3"
						>
							<div>
								<span className="text-sm font-medium">{mod.name}</span>
								{mod.objectTypeTabs.length > 0 && (
									<span className="text-sm text-muted-foreground ml-2">
										{mod.objectTypeTabs.map((t) => t.label).join(', ')}
									</span>
								)}
							</div>
							<Switch
								checked={isEnabled}
								onCheckedChange={(checked) => handleToggle(mod.id, !!checked)}
							/>
						</div>
					)
				})}
				{customExtensions.map((ext) => (
					<div
						key={ext.id}
						className="flex items-center justify-between rounded-lg border border-border p-3"
					>
						<div>
							<span className="text-sm font-medium">{ext.name}</span>
							{ext.tabs.length > 0 && (
								<span className="text-sm text-muted-foreground ml-2">
									{ext.tabs.map((t) => t.label).join(', ')}
								</span>
							)}
						</div>
						<div className="flex items-center gap-3">
							{confirmDeleteId === ext.id ? (
								<div className="flex items-center gap-1">
									<Button
										size="sm"
										variant="destructive"
										onClick={() => {
											handleDeleteCustomExtension(ext.id, ext.types)
											setConfirmDeleteId(null)
										}}
									>
										Delete
									</Button>
									<Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(null)}>
										Cancel
									</Button>
								</div>
							) : (
								<button
									type="button"
									aria-label={`Delete ${ext.name}`}
									onClick={() => setConfirmDeleteId(ext.id)}
									className="text-muted-foreground hover:text-destructive transition-colors"
								>
									<Trash2 size={15} />
								</button>
							)}
							<Switch
								checked={ext.enabled}
								onCheckedChange={(checked) => handleToggleCustomExtension(ext.id, !!checked)}
							/>
						</div>
					</div>
				))}
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
