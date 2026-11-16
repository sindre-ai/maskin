import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

struct WorkspaceSettingsView: View {
	@Environment(\.dismiss) private var dismiss
	@State private var store: WorkspaceSettingsStore
	@State private var name: String
	@State private var newName = ""
	/// Nil without a workspace: there is nothing to switch.
	let general: GeneralSettingsStore?
	let workspaceId: String
	let currentName: String
	let role: MemberRole

	init(
		store: WorkspaceSettingsStore, general: GeneralSettingsStore? = nil, workspaceId: String,
		currentName: String, role: MemberRole
	) {
		_store = State(initialValue: store)
		self.general = general
		_name = State(initialValue: currentName)
		self.workspaceId = workspaceId
		self.currentName = currentName
		self.role = role
	}

	var body: some View {
		Form {
			Section {
				if role.canManage {
					TextField("Workspace name", text: $name).submitLabel(.done)
					Button("Save name") {
						Task { await store.rename(workspaceId: workspaceId, to: name) }
					}
					.disabled(!store.canRename(to: name, current: currentName, role: role))
				} else {
					Text(currentName).foregroundStyle(MaskinColor.ink)
				}
			} header: {
				Text("Name")
			} footer: {
				if !role.canManage { Text("Only a workspace admin can rename it.") }
			}
			Section {
				TextField("New workspace name", text: $newName).submitLabel(.done)
				Button("Create and switch") {
					Task { if await store.create(name: newName) { dismiss() } }
				}
				.disabled(
					WorkspaceSettingsStore.normalized(newName).isEmpty || store.isWorking)
			} header: {
				Text("New workspace")
			} footer: {
				Text("You'll be the owner and the app switches to it.")
			}
			if let general {
				GeneralSwitches(store: general)
			}
			if let error = store.error {
				Section { FormError(error) }
			}
		}
		.navigationTitle("Workspace")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
		.overlay { if store.isWorking { ProgressView() } }
	}
}

/// The web's Settings > General switches, same names and wording: the default workspace, then
/// Privacy and data.
private struct GeneralSwitches: View {
	let store: GeneralSettingsStore

	var body: some View {
		Section("Default workspace") {
			row(
				"Make this my default workspace",
				"Your agents and connected tools treat it as the workspace to use when you don't name one. Only one workspace can be your default; picking another replaces it.",
				isOn: Binding(get: { store.isDefault }, set: { on in Task { await store.setDefault(on) } }),
				enabled: true)
		}
		Section {
			row(
				"Share product usage with Maskin",
				"Shares which features you use and how many agent runs happen, with your name and email unless Anonymize is on. The Maskin team sees it. It never includes the content of your work.",
				isOn: Binding(get: { store.shareUsage }, set: { on in Task { await store.setShareUsage(on) } }),
				enabled: store.canWritePrivacy)
			row(
				"Anonymize this workspace",
				"Leaves your name and email out of usage data.",
				isOn: Binding(get: { store.anonymize }, set: { on in Task { await store.setAnonymize(on) } }),
				enabled: store.canWritePrivacy)
		} header: {
			Text("Privacy and data")
		} footer: {
			Text("Helps the Maskin team see how Maskin is used. The content of your work is never included.")
		}
		if let error = store.error {
			Section { FormError(error) }
		}
	}

	private func row(_ title: String, _ detail: String, isOn: Binding<Bool>, enabled: Bool) -> some View {
		Toggle(isOn: isOn) {
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(title)
				Text(detail).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
		}
		.disabled(!enabled || store.isSaving)
		.frame(minHeight: MaskinSpace.touchMin)
	}
}
