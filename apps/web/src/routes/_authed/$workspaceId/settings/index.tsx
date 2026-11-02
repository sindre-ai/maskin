import { DeleteWorkspaceDialog } from '@/components/settings/delete-workspace-dialog'
import { RouteError } from '@/components/shared/route-error'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { useUpdateActor } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { type Theme, useTheme } from '@/lib/theme'
import { useWorkspace } from '@/lib/workspace-context'
import { VIEWER_READ_ONLY_MESSAGE } from '@/lib/workspace-role'
import { createFileRoute } from '@tanstack/react-router'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/settings/')({
	component: GeneralPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function GeneralPage() {
	const { workspace, workspaceId } = useWorkspace()
	const canWrite = useCanWrite()
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const [name, setName] = useState(workspace.name)

	const handleSave = () => {
		if (canWrite && name !== workspace.name) {
			updateWorkspace.mutate(
				{ name },
				{
					onSuccess: () => toast.success('Workspace name saved'),
					onError: () => toast.error('Failed to save the workspace name'),
				},
			)
		}
	}

	return (
		<div className="max-w-[580px]">
			<h2 className="settings-label mb-[7px]">WORKSPACE NAME</h2>
			<div className="flex gap-2">
				<ViewerTooltip className="flex flex-1">
					<Input
						type="text"
						value={name}
						onChange={(e) => setName(e.target.value)}
						aria-label="Workspace name"
						placeholder={canWrite ? undefined : VIEWER_READ_ONLY_MESSAGE}
						disabled={!canWrite}
						className="flex-1"
					/>
				</ViewerTooltip>
				<ViewerTooltip>
					<Button
						onClick={handleSave}
						disabled={name === workspace.name || updateWorkspace.isPending || !canWrite}
					>
						Save
					</Button>
				</ViewerTooltip>
			</div>

			<Separator className="my-6" />
			<DefaultWorkspaceSection />

			<Separator className="my-6" />
			<ThemePicker />

			<Separator className="my-6" />
			<PrivacySection />

			{workspace.billingOwnerId !== null && workspace.billingOwnerId === getStoredActor()?.id && (
				<>
					<Separator className="my-6" />
					<DangerSection />
				</>
			)}
		</div>
	)
}

function DangerSection() {
	const { workspace, workspaceId } = useWorkspace()
	const canWrite = useCanWrite()
	const [open, setOpen] = useState(false)

	return (
		<div>
			<h2 className="settings-label mb-1.5">DANGER ZONE</h2>
			<div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="min-w-0">
					<span className="block text-[12.5px] font-semibold">Delete this workspace</span>
					<span className="text-xs text-muted-foreground">
						Permanently deletes the workspace and everything in it.
					</span>
				</div>
				<ViewerTooltip>
					<Button variant="destructive" disabled={!canWrite} onClick={() => setOpen(true)}>
						Delete workspace
					</Button>
				</ViewerTooltip>
			</div>
			<DeleteWorkspaceDialog
				workspaceId={workspaceId}
				workspaceName={workspace.name}
				open={open}
				onOpenChange={setOpen}
			/>
		</div>
	)
}

function DefaultWorkspaceSection() {
	const { workspace, workspaceId } = useWorkspace()
	const updateActor = useUpdateActor()
	const actorId = getStoredActor()?.id

	const handleChange = (checked: boolean) => {
		if (!actorId) return
		updateActor.mutate(
			{ id: actorId, data: { default_workspace_id: checked ? workspaceId : null } },
			{
				onSuccess: () =>
					toast.success(checked ? 'Default workspace updated' : 'Default workspace cleared'),
				onError: () => toast.error('Failed to update your default workspace'),
			},
		)
	}

	return (
		<div>
			<h2 className="settings-label mb-1.5">DEFAULT WORKSPACE</h2>
			<div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-3">
				<div className="min-w-0">
					<span className="block text-[12.5px] font-semibold">Make this my default workspace</span>
					<span className="text-xs text-muted-foreground">
						Your agents and connected tools treat it as the workspace to use when you don't name
						one. Only one workspace can be your default; picking another replaces it.
					</span>
				</div>
				<Switch
					checked={workspace.isDefault}
					disabled={!actorId || updateActor.isPending}
					onCheckedChange={(checked) => handleChange(!!checked)}
					aria-label="Make this my default workspace"
				/>
			</div>
		</div>
	)
}

interface PrivacySettings {
	share_usage: boolean
	anonymize_workspace: boolean
}

function readPrivacySettings(settings: Record<string, unknown>): PrivacySettings {
	const raw = (settings.privacy ?? {}) as Partial<PrivacySettings>
	return {
		share_usage: raw.share_usage ?? true,
		anonymize_workspace: raw.anonymize_workspace ?? false,
	}
}

function PrivacySection() {
	const { workspace, workspaceId } = useWorkspace()
	const canWrite = useCanWrite()
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const settings = workspace.settings as Record<string, unknown>
	const privacy = readPrivacySettings(settings)

	const persist = (next: PrivacySettings) => {
		if (!canWrite) return
		updateWorkspace.mutate(
			{ settings: { ...settings, privacy: next } },
			{ onError: () => toast.error('Failed to update privacy settings') },
		)
	}

	return (
		<div>
			<h2 className="settings-label mb-1.5">PRIVACY &amp; DATA</h2>
			<p className="mb-3 max-w-prose text-xs leading-relaxed text-muted-foreground">
				Usage events feed the Synthesizer so the team sees how the workspace is really used. No
				object titles, no content, no PII.
			</p>
			<div className="space-y-2.5">
				<div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-3">
					<div className="min-w-0">
						<span className="block text-[12.5px] font-semibold">
							Share product usage with Maskin
						</span>
						<span className="text-xs text-muted-foreground">
							Bet lifecycle, agent sessions, trigger fires. No content, no PII.
						</span>
					</div>
					<ViewerTooltip>
						<Switch
							checked={privacy.share_usage}
							disabled={!canWrite}
							onCheckedChange={(checked) => persist({ ...privacy, share_usage: !!checked })}
							aria-label="Share product usage with Maskin"
						/>
					</ViewerTooltip>
				</div>
				<div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-3">
					<div className="min-w-0">
						<span className="block text-[12.5px] font-semibold">Anonymize this workspace</span>
						<span className="text-xs text-muted-foreground">
							Rotate workspace and actor IDs into hashes before events leave the browser.
						</span>
					</div>
					<ViewerTooltip>
						<Switch
							checked={privacy.anonymize_workspace}
							disabled={!canWrite}
							onCheckedChange={(checked) => persist({ ...privacy, anonymize_workspace: !!checked })}
							aria-label="Anonymize this workspace"
						/>
					</ViewerTooltip>
				</div>
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
			<h2 className="settings-label mb-2.5">APPEARANCE</h2>
			<div className="flex w-full gap-1 rounded-xl border border-border bg-card p-1 sm:inline-flex sm:w-auto">
				{themeOptions.map((option) => {
					const Icon = option.icon
					const isActive = theme === option.value
					return (
						<button
							key={option.value}
							type="button"
							onClick={() => setTheme(option.value)}
							className={cn(
								'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-1.5 text-[12.5px] font-semibold transition-colors sm:flex-none',
								isActive
									? 'bg-primary text-primary-foreground'
									: 'text-muted-foreground hover:text-foreground',
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
