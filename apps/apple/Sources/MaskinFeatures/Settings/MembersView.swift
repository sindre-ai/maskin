import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Members (2A): people, then the agents with access. Owners and admins can change a role or
/// remove someone by tapping their row, and add a person by id.
struct MembersView: View {
	@State private var store: MembersStore
	@State private var actionTarget: WorkspaceMember?
	@State private var pendingRemoval: WorkspaceMember?
	@State private var showAdd = false

	init(store: MembersStore) { _store = State(initialValue: store) }

	var body: some View {
		WorkspacePage(title: "Members") {
			if store.members.isEmpty {
				switch store.phase {
				case .failed(let message): PageStatus(text: message)
				case .loaded: PageStatus(text: "No one here yet.")
				default: PageStatus(text: "Loading members")
				}
			} else {
				if !store.humans.isEmpty { PageCard(rows: store.humans.map(row)) }
				if !store.agents.isEmpty {
					PageGroupLabel(text: "Agents with access")
					PageCard(rows: store.agents.map(row))
				}
			}
			if let error = store.actionError { FormError(error) }
			PageFootnote(
				text: store.canAdd
					? "Agents are managed in Agents. To add someone, ask them for the ID on their Profile screen."
					: "Agents are managed in Agents. Only owners and admins can add people.")
			if store.canAdd {
				Button("Add someone") { showAdd = true }.buttonStyle(.primaryAction)
			}
		}
		.sheet(isPresented: $showAdd) { AddMemberSheet(store: store) }
		.task { await store.load() }
		.refreshable { await store.load() }
		.confirmationDialog(
			actionTarget?.name ?? "Member",
			isPresented: Binding(get: { actionTarget != nil }, set: { if !$0 { actionTarget = nil } }),
			titleVisibility: .visible, presenting: actionTarget
		) { member in
			if store.canChangeRole(of: member) {
				ForEach([MemberRole.admin, .member].filter { $0 != member.role }, id: \.self) { role in
					Button("Make \(role.label.lowercased())") {
						Task { await store.setRole(role, for: member) }
					}
				}
			}
			if store.canRemove(member) {
				Button("Remove from workspace", role: .destructive) { pendingRemoval = member }
			}
		}
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

	private func row(_ member: WorkspaceMember) -> PageRowModel {
		let isYou = member.actorId == store.currentActorId
		let manageable = store.canChangeRole(of: member) || store.canRemove(member)
		return PageRowModel(
			id: member.id, title: member.name,
			subtitle: WorkspacePageState.memberSubtitle(
				isAgent: member.isAgent, role: member.role, isYou: isYou),
			avatar: (member.name, member.isAgent),
			accessory: .state(
				store.busyIDs.contains(member.id)
					? PageState("Updating", .muted) : WorkspacePageState.member(role: member.role)),
			action: manageable ? { actionTarget = member } : nil)
	}
}
