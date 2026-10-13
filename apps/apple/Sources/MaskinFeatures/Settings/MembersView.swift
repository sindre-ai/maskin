import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Members (2A, tidied per `7-Chat.md` §10): PEOPLE · n, then AGENTS · n ending in Hire an agent.
///
/// People come from `MembersStore` (roles, add, remove: owners and admins tap a row). Agents come
/// from the `AgentsStore` the profile sheet already holds, so their status is the one the rest of
/// the app shows and nothing is fetched twice; each agent row opens the agent.
struct MembersView: View {
	@State private var store: MembersStore
	/// Nil only when no workspace is selected; member agents are then listed without a status.
	let agents: AgentsStore?
	var onOpenAgent: (String) -> Void = { _ in }
	var onHire: () -> Void = {}
	@State private var actionTarget: WorkspaceMember?
	@State private var pendingRemoval: WorkspaceMember?
	@State private var showAdd = false

	init(
		store: MembersStore, agents: AgentsStore? = nil, onOpenAgent: @escaping (String) -> Void = { _ in },
		onHire: @escaping () -> Void = {}
	) {
		_store = State(initialValue: store)
		self.agents = agents
		self.onOpenAgent = onOpenAgent
		self.onHire = onHire
	}

	private var roster: MembersRoster.Groups {
		MembersRoster.groups(members: store.members, agents: agents?.agents ?? [])
	}

	var body: some View {
		let groups = roster
		WorkspacePage(title: "Members") {
			if store.members.isEmpty, groups.agents.isEmpty {
				switch store.phase {
				case .failed(let message): PageStatus(text: message)
				case .loaded: PageStatus(text: "No one here yet.")
				default: PageStatus(text: "Loading members")
				}
			}
			if !groups.people.isEmpty {
				PageGroupLabel(text: "People · \(groups.people.count)")
				PageCard(rows: groups.people.map(row))
			}
			PageGroupLabel(text: "Agents · \(groups.agents.count)")
			PageCard(rows: groups.agents.map(agentRow) + [hireRow])
			if let error = store.actionError { FormError(error) }
			PageFootnote(
				text: store.canAdd
					? "Tap an agent to see what it is doing or pause it. To add someone, ask them for the ID on their profile."
					: "Tap an agent to see what it is doing. Only owners and admins can add people.")
			if store.canAdd {
				Button("Add someone") { showAdd = true }.buttonStyle(.primaryAction)
			}
		}
		.sheet(isPresented: $showAdd) { AddMemberSheet(store: store) }
		.task { await store.load() }
		.refreshable {
			await store.load()
			if let agents { await agents.refresh() }
		}
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

	/// An agent: its role under the name, Working in Patina or Idle / Paused in grey, opens the agent.
	private func agentRow(_ agent: MemberAgentRow) -> PageRowModel {
		PageRowModel(
			id: agent.id, title: agent.name, subtitle: agent.role,
			avatar: (agent.name, true), avatarWorking: agent.isWorking,
			accessory: Self.accessory(for: agent),
			showsChevron: true,
			action: { onOpenAgent(agent.id) })
	}

	/// Working / Idle / Paused / Failed, or nothing while the agents list has not resolved the agent.
	static func accessory(for agent: MemberAgentRow) -> PageRowModel.Accessory {
		guard let state = WorkspacePageState.agent(agent.status) else { return .none }
		return .state(state)
	}

	/// The last row of the AGENTS group: a way to get another one.
	private var hireRow: PageRowModel {
		PageRowModel(
			id: "hire", title: "Hire an agent", subtitle: "From the marketplace",
			accessory: .state(PageState("Marketplace", .active)), showsChevron: true,
			action: onHire)
	}
}
