import { DeleteWorkspaceDialog } from '@/components/settings/delete-workspace-dialog'
import { RouteError } from '@/components/shared/route-error'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { ChevronRight, Monitor, Moon, Sun } from 'lucide-react'
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
		<div className="max-w-[760px]">
			<SettingsSection title="Workspace">
				<SettingsRow title="Workspace name">
					<ViewerTooltip className="flex">
						<Input
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							aria-label="Workspace name"
							placeholder={canWrite ? undefined : VIEWER_READ_ONLY_MESSAGE}
							disabled={!canWrite}
							className="w-full rounded-full border-0 bg-secondary sm:w-72"
						/>
					</ViewerTooltip>
				</SettingsRow>
				<SettingsRow title="Save name">
					<ViewerTooltip>
						<Button
							variant="ghost"
							onClick={handleSave}
							disabled={name === workspace.name || updateWorkspace.isPending || !canWrite}
						>
							Save
						</Button>
					</ViewerTooltip>
				</SettingsRow>
			</SettingsSection>

			<DefaultWorkspaceSection />
			<ThemePicker />
			<PrivacySection />

			{workspace.billingOwnerId !== null && workspace.billingOwnerId === getStoredActor()?.id && (
				<DangerSection />
			)}
		</div>
	)
}

/** A titled block of hairline-separated rows (mockup v11 Settings). */
function SettingsSection({
	title,
	intro,
	children,
}: {
	title: string
	intro?: string
	children: React.ReactNode
}) {
	return (
		<section className="mb-8">
			<h2 className="px-2 pb-1.5 text-xs font-semibold text-foreground">{title}</h2>
			{intro ? (
				<p className="mb-2 max-w-prose px-2 text-[13px] text-muted-foreground">{intro}</p>
			) : null}
			<div className="divide-y divide-border-subtle border-y border-border-subtle">{children}</div>
		</section>
	)
}

/** One row: title and optional description on the left, the control on the right. */
function SettingsRow({
	title,
	description,
	children,
}: {
	title: string
	description?: string
	children?: React.ReactNode
}) {
	return (
		<div className="flex flex-col gap-3 px-2 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
			<div className="min-w-0">
				<span className="block text-[15px] font-semibold">{title}</span>
				{description ? (
					<span className="block text-[13px] text-muted-foreground">{description}</span>
				) : null}
			</div>
			{children ? <div className="shrink-0">{children}</div> : null}
		</div>
	)
}

function DangerSection() {
	const { workspace, workspaceId } = useWorkspace()
	const canWrite = useCanWrite()
	const [open, setOpen] = useState(false)

	return (
		<SettingsSection title="Danger zone">
			<ViewerTooltip className="flex w-full">
				<button
					type="button"
					disabled={!canWrite}
					onClick={() => setOpen(true)}
					className="flex w-full items-center justify-between px-2 py-3.5 text-left text-[15px] font-semibold text-destructive disabled:opacity-50"
				>
					Delete workspace
					<ChevronRight size={18} aria-hidden className="text-muted-foreground" />
				</button>
			</ViewerTooltip>
			<DeleteWorkspaceDialog
				workspaceId={workspaceId}
				workspaceName={workspace.name}
				open={open}
				onOpenChange={setOpen}
			/>
		</SettingsSection>
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
		<SettingsSection title="Default workspace">
			<SettingsRow
				title="Make this my default workspace"
				description="Your agents and connected tools treat it as the workspace to use when you don't name one. Only one workspace can be your default; picking another replaces it."
			>
				<Switch
					checked={workspace.isDefault}
					disabled={!actorId || updateActor.isPending}
					onCheckedChange={(checked) => handleChange(!!checked)}
					aria-label="Make this my default workspace"
				/>
			</SettingsRow>
		</SettingsSection>
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
		<SettingsSection
			title="Privacy and data"
			intro="Usage events feed the Synthesizer so the team sees how the workspace is really used. No item titles, no content, no PII."
		>
			<SettingsRow
				title="Share product usage with Maskin"
				description="Bet lifecycle, agent sessions, trigger fires. No content, no PII."
			>
				<ViewerTooltip>
					<Switch
						checked={privacy.share_usage}
						disabled={!canWrite}
						onCheckedChange={(checked) => persist({ ...privacy, share_usage: !!checked })}
						aria-label="Share product usage with Maskin"
					/>
				</ViewerTooltip>
			</SettingsRow>
			<SettingsRow
				title="Anonymize this workspace"
				description="Rotate workspace and actor IDs into hashes before events leave the browser."
			>
				<ViewerTooltip>
					<Switch
						checked={privacy.anonymize_workspace}
						disabled={!canWrite}
						onCheckedChange={(checked) => persist({ ...privacy, anonymize_workspace: !!checked })}
						aria-label="Anonymize this workspace"
					/>
				</ViewerTooltip>
			</SettingsRow>
		</SettingsSection>
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
		<SettingsSection title="Appearance">
			<SettingsRow title="Theme" description="Light, Dark, or System (follows your device).">
				<div className="flex w-full gap-1 rounded-full bg-secondary p-1 sm:inline-flex sm:w-auto">
					{themeOptions.map((option) => {
						const Icon = option.icon
						const isActive = theme === option.value
						return (
							<button
								key={option.value}
								type="button"
								onClick={() => setTheme(option.value)}
								className={cn(
									'flex flex-1 items-center justify-center gap-1.5 rounded-full px-4 py-1.5 text-[12.5px] font-semibold transition-colors sm:flex-none',
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
			</SettingsRow>
		</SettingsSection>
	)
}
