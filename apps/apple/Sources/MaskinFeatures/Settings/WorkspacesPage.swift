import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Workspaces (2m): every workspace the person belongs to, the current one marked, and a way to
/// make another. Picking one switches the whole app. Unread counts per workspace are not in the
/// workspace list the API returns, so the rows show role and people instead.
struct WorkspacesPage: View {
	let workspaces: WorkspaceStore
	@State private var creator: WorkspaceSettingsStore
	@State private var showCreate = false
	@State private var newName = ""

	init(workspaces: WorkspaceStore, creator: WorkspaceSettingsStore) {
		self.workspaces = workspaces
		_creator = State(initialValue: creator)
	}

	var body: some View {
		WorkspacePage(title: "Workspaces") {
			PageGroupLabel(text: "Your workspaces")
			if workspaces.workspaces.isEmpty {
				PageStatus(text: workspaces.phase == .loading ? "Loading workspaces" : "No workspaces yet.")
			} else {
				PageCard(rows: Self.rows(workspaces.workspaces, selectedID: workspaces.selectedID) { id in
					workspaces.select(id)
				})
			}
			Button("New workspace") { showCreate = true }.buttonStyle(.secondaryAction)
		}
		.task { await workspaces.refresh() }
		.sheet(isPresented: $showCreate) { createSheet }
	}

	static func rows(
		_ list: [WorkspaceSummary], selectedID: String?, select: @escaping (String) -> Void
	) -> [PageRowModel] {
		list.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }.map { ws in
			PageRowModel(
				id: ws.id, title: ws.name, subtitle: subtitle(ws),
				avatar: (ws.name, false),
				accessory: ws.id == selectedID ? .state(PageState("Current", .active)) : .none,
				action: ws.id == selectedID ? nil : { select(ws.id) })
		}
	}

	static func subtitle(_ ws: WorkspaceSummary) -> String {
		let role = MemberRole(serverValue: ws.role).label
		return "\(role) \u{00B7} \(ws.memberCount) \(ws.memberCount == 1 ? "person" : "people")"
	}

	private var createSheet: some View {
		NavigationStack {
			Form {
				Section {
					TextField("Name", text: $newName).submitLabel(.done)
						.frame(minHeight: MaskinSpace.touchMin)
				} footer: {
					Text("You will be the owner, and the app switches to it.")
				}
				if let error = creator.error { Section { FormError(error) } }
			}
			.settingsListStyle()
			.navigationTitle("New workspace")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showCreate = false } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Create") {
						Task { if await creator.create(name: newName) { showCreate = false; newName = "" } }
					}
					.disabled(WorkspaceSettingsStore.normalized(newName).isEmpty || creator.isWorking)
				}
			}
		}
		.presentationDetents([.medium])
	}
}
