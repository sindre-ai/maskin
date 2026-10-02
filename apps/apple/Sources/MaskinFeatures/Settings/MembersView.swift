import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

struct MembersView: View {
	@State private var store: MembersStore
	@State private var pendingRemoval: WorkspaceMember?

	init(store: MembersStore) { _store = State(initialValue: store) }

	var body: some View {
		List {
			if !store.humans.isEmpty {
				Section("People") { ForEach(store.humans) { row($0) } }
			}
			if !store.agents.isEmpty {
				Section("Agents") { ForEach(store.agents) { row($0) } }
			}
			if let error = store.actionError {
				Section { FormError(error) }
			}
			if store.currentRole.canManage {
				Section {
				} footer: {
					Text("To add someone, invite them from Maskin on the web.")
				}
			}
		}
		.overlay {
			switch store.phase {
			case .loading where store.members.isEmpty: ProgressView()
			case .failed(let message) where store.members.isEmpty:
				ContentUnavailableView(
					"Couldn't load members", systemImage: "wifi.exclamationmark",
					description: Text(message))
			default: EmptyView()
			}
		}
		.navigationTitle("Members")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
		.task { await store.load() }
		.refreshable { await store.load() }
		.confirmationDialog(
			pendingRemoval.map { "Remove \($0.name)?" } ?? "Remove member?",
			isPresented: Binding(
				get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }),
			titleVisibility: .visible, presenting: pendingRemoval
		) { member in
			Button("Remove from workspace", role: .destructive) {
				Task { await store.remove(member) }
			}
		} message: { member in
			Text("\(member.name) loses access to this workspace right away.")
		}
	}

	@ViewBuilder
	private func row(_ member: WorkspaceMember) -> some View {
		let changeRole = store.canChangeRole(of: member)
		let remove = store.canRemove(member)
		MemberRow(member: member, busy: store.busyIDs.contains(member.id))
			.contextMenu {
				if changeRole {
					ForEach([MemberRole.admin, .member], id: \.self) { role in
						Button {
							Task { await store.setRole(role, for: member) }
						} label: {
							Label(
								"Make \(role.label.lowercased())",
								systemImage: member.role == role ? "checkmark" : "person")
						}
						.disabled(member.role == role)
					}
				}
				if remove {
					Button("Remove", systemImage: "person.badge.minus", role: .destructive) {
						pendingRemoval = member
					}
				}
			}
			.swipeActions(edge: .trailing) {
				if remove {
					Button("Remove", role: .destructive) { pendingRemoval = member }
				}
			}
	}
}
