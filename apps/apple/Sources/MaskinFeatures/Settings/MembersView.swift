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
	@State private var showAdd = false
	/// Pending invitations (owners and admins only). Built on appear from the running app.
	@State private var invites: PendingInvitesStore?
	@State private var memberDetail: String?
	@State private var inviteDetail: String?
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

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
			if let invites, !invites.invites.isEmpty {
				PageGroupLabel(text: "Pending · \(invites.invites.count)")
				PageCard(
					rows: invites.invites.map { invite in
						PageRowModel(
							id: "invite-\(invite.id)", title: invite.email,
							subtitle: "\(invite.sentText()) \u{00B7} \(invite.role.label)",
							accessory: .state(PageState("Pending", .notice)), showsChevron: true,
							action: { inviteDetail = invite.id })
					})
			}
			PageGroupLabel(text: "Agents · \(groups.agents.count)")
			PageCard(rows: groups.agents.map(agentRow) + [hireRow])
			if let error = store.actionError { FormError(error) }
			PageFootnote(
				text: store.canAdd
					? "Tap a person for their role and access, or an agent to see what it is doing. To add someone, ask them for the ID on their profile."
					: "Tap an agent to see what it is doing. Only owners and admins can add people.")
			if store.canAdd {
				Button("Add someone") { showAdd = true }.buttonStyle(.primaryAction)
			}
		}
		.sheet(isPresented: $showAdd) { AddMemberSheet(store: store) }
		.navigationDestination(item: $memberDetail) { MemberDetailPage(store: store, memberID: $0) }
		.navigationDestination(item: $inviteDetail) { id in
			if let invites { InvitationDetailPage(store: invites, inviteID: id) }
		}
		.task {
			if invites == nil, let runtime {
				invites = PendingInvitesStore(
					api: HTTPPendingInvitesSource(http: SettingsServices(environment: runtime.environment).http),
					canManage: store.canAdd)
			}
			await store.load()
			await invites?.load()
		}
		.refreshable {
			await store.load()
			await invites?.load()
			if let agents { await agents.refresh() }
		}
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
