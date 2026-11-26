import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One integration's agent access (v3 GitHub page): each agent with its level. Tap an agent to
/// choose Read, Read & write or No access.
struct IntegrationAccessView: View {
	@State private var store: IntegrationAccessStore
	@State private var target: IntegrationAccessStore.AgentRef?
	@State private var chatTarget: ChatGrant?
	let title: String
	/// Granted and requested permissions above the agent list (nil hides them).
	let scopes: IntegrationScopesStore?
	let onReconnect: (() -> Void)?

	init(
		store: IntegrationAccessStore, title: String, scopes: IntegrationScopesStore? = nil,
		onReconnect: (() -> Void)? = nil
	) {
		_store = State(initialValue: store)
		self.title = title
		self.scopes = scopes
		self.onReconnect = onReconnect
	}

	var body: some View {
		WorkspacePage(title: title) {
			if let scopes { IntegrationScopesBlock(store: scopes, providerName: title, onReconnect: onReconnect) }
			switch store.phase {
			case .loaded:
				if store.agents.isEmpty {
					PageStatus(text: "No agents in this workspace yet.")
				} else {
					PageGroupLabel(text: "Agent access")
					PageCard(rows: store.agents.map(row))
				}
				if !store.chatGrants.isEmpty {
					PageGroupLabel(text: "Allowed in a chat")
					PageCard(rows: store.chatGrants.map(chatRow))
				}
				if let error = store.actionError { FormError(error) }
				PageFootnote(
					text: store.canManage
						? "Applies to sessions that start after you change it."
						: "Only owners and admins can change agent access.")
			case .failed(let message): PageStatus(text: message)
			default: PageStatus(text: "Loading agent access")
			}
		}
		.task {
			await scopes?.load()
			await store.load()
		}
		.refreshable {
			await scopes?.load()
			await store.load()
		}
		.confirmationDialog(
			target?.name ?? "Agent",
			isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
			titleVisibility: .visible, presenting: target
		) { agent in
			ForEach([AgentAccess.readWrite, .read, .none], id: \.self) { level in
				Button(level.label) { Task { await store.set(level, for: agent) } }
			}
		}
		.confirmationDialog(
			chatTarget.map { "Remove chat access for \(agentName($0))?" } ?? "Chat access",
			isPresented: Binding(get: { chatTarget != nil }, set: { if !$0 { chatTarget = nil } }),
			titleVisibility: .visible, presenting: chatTarget
		) { grant in
			Button("Remove", role: .destructive) { Task { await store.removeChatGrant(grant) } }
		}
	}

	private func agentName(_ grant: ChatGrant) -> String {
		store.agents.first { $0.id == grant.actorId }?.name ?? "this agent"
	}

	private func chatRow(_ grant: ChatGrant) -> PageRowModel {
		let name = store.agents.first { $0.id == grant.actorId }?.name ?? "An agent"
		return PageRowModel(
			id: grant.id, title: name, subtitle: grant.detail, avatar: (name, true),
			accessory: store.busyIDs.contains(grant.id)
				? .state(PageState("Removing", .muted)) : store.canManage ? .state(PageState("Remove", .plain)) : .none,
			action: store.canManage ? { chatTarget = grant } : nil)
	}

	private func row(_ agent: IntegrationAccessStore.AgentRef) -> PageRowModel {
		let level = store.access(for: agent.id)
		return PageRowModel(
			id: agent.id, title: agent.name, avatar: (agent.name, true),
			accessory: .state(
				store.busyIDs.contains(agent.id)
					? PageState("Saving", .muted) : PageState(level.label, level == .none ? .muted : .active)),
			action: store.canManage ? { target = agent } : nil)
	}
}
