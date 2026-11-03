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
	/// Pending email invitations (v3). Nil hides the group and the Invite button.
	let invitations: InvitationsStore?
	@State private var invitationTarget: PendingInvitation?
	@State private var showInvite = false
	@State private var memberDetail: String?
	@State private var showAdd = false

	init(
		store: MembersStore, agents: AgentsStore? = nil, invitations: InvitationsStore? = nil,
		onOpenAgent: @escaping (String) -> Void = { _ in }, onHire: @escaping () -> Void = {}
	) {
		_store = State(initialValue: store)
		self.invitations = invitations
		self.agents = agents
		self.onOpenAgent = onOpenAgent
		self.onHire = onHire
	}

	private var roster: MembersRoster.Groups {
		MembersRoster.groups(members: store.members, agents: agents?.agents ?? [])
	}

	var body: some View {
		memberDialogs(invitationDialog(sheets(page)))
	}

	private var page: some View {
		let groups = roster
		return pageContent(groups)
	}

	private func pageContent(_ groups: MembersRoster.Groups) -> some View {
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
			if let invitations, invitations.canManage, !invitations.pending.isEmpty {
				PageGroupLabel(text: "Invited · \(invitations.pending.count)")
				PageCard(rows: invitations.pending.map { invitationRow($0, invitations) })
			}
			PageGroupLabel(text: "Agents · \(groups.agents.count)")
			PageCard(rows: agentRows(groups))
			if let error = actionError { FormError(error) }
			if let notice = invitations?.notice { PageFootnote(text: notice) }
			PageFootnote(text: footnote)
			if let invitations, invitations.canManage {
				Button("Invite people") { showInvite = true }.buttonStyle(.primaryAction)
			}
			if store.canAdd {
				addByIDButton
			}
		}
	}

	private func sheets(_ view: some View) -> some View {
		view
		.sheet(isPresented: $showAdd) { AddMemberSheet(store: store) }
		.sheet(isPresented: $showInvite) { if let invitations { InviteByEmailSheet(store: invitations) } }
		.task {
			await invitations?.load()
			await store.load()
		}
		.refreshable {
			await invitations?.load()
			await store.load()
			if let agents { await agents.refresh() }
		}
	}

	private func memberDialogs(_ view: some View) -> some View {
		view.navigationDestination(item: $memberDetail) { MemberDetailPage(store: store, memberID: $0) }
	}

	private func invitationDialog(_ view: some View) -> some View {
		view
		.confirmationDialog(
			invitationTarget?.email ?? "Invitation",
			isPresented: Binding(get: { invitationTarget != nil }, set: { if !$0 { invitationTarget = nil } }),
			titleVisibility: .visible, presenting: invitationTarget
		) { invitation in
			Button("Send again") { Task { await invitations?.resend(invitation) } }
			Button("Cancel invitation", role: .destructive) { Task { await invitations?.cancel(invitation) } }
		}
	}

	private var actionError: String? {
		if let message = store.actionError { return message }
		return invitations?.actionError
	}

	private var footnote: String {
		if store.canAdd {
			return "Tap an agent to see what it is doing or pause it. To add someone, ask them for the ID on their profile."
		}
		return "Tap an agent to see what it is doing. Only owners and admins can add people."
	}

	private func agentRows(_ groups: MembersRoster.Groups) -> [PageRowModel] {
		var rows: [PageRowModel] = groups.agents.map(agentRow)
		rows.append(hireRow)
		return rows
	}

	@ViewBuilder private var addByIDButton: some View {
		if invitations?.canManage == true {
			Button("Add someone by ID") { showAdd = true }.buttonStyle(.secondaryAction)
		} else {
			Button("Add someone by ID") { showAdd = true }.buttonStyle(.primaryAction)
		}
	}

	private func invitationRow(_ invitation: PendingInvitation, _ invitations: InvitationsStore) -> PageRowModel {
		PageRowModel(
			id: "invite-\(invitation.id)", title: invitation.email,
			subtitle: invitation.expiryText(),
			accessory: invitations.busyIDs.contains(invitation.id)
				? .state(PageState("Updating", .muted)) : .state(PageState("Invited", .muted)),
			action: { invitationTarget = invitation })
	}

	private func row(_ member: WorkspaceMember) -> PageRowModel {
		let isYou = member.actorId == store.currentActorId
		return PageRowModel(
			id: member.id, title: member.name,
			subtitle: WorkspacePageState.memberSubtitle(
				isAgent: member.isAgent, role: member.role, isYou: isYou),
			avatar: (member.name, member.isAgent),
			accessory: .state(
				store.busyIDs.contains(member.id)
					? PageState("Updating", .muted) : WorkspacePageState.member(role: member.role)),
			showsChevron: !member.isAgent,
			action: member.isAgent ? nil : { memberDetail = member.id })
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
