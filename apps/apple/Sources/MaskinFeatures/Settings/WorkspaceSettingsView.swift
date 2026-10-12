import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

struct WorkspaceSettingsView: View {
	@Environment(\.dismiss) private var dismiss
	@State private var store: WorkspaceSettingsStore
	@State private var name: String
	@State private var newName = ""
	let workspaceId: String
	let currentName: String
	let role: MemberRole

	init(store: WorkspaceSettingsStore, workspaceId: String, currentName: String, role: MemberRole) {
		_store = State(initialValue: store)
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
