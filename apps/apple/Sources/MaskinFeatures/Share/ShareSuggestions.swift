import MaskinCore

#if os(iOS)
	import Intents
	import MaskinUI
	import SwiftUI
	import UIKit
#endif

/// Offers agents in the top row of the iOS share sheet, next to the contacts from Messages and
/// Slack. iOS fills that row from message actions apps donate, so each agent is donated as one:
/// named after the agent, wearing its avatar. Only the latest `ShareSuggestionRecents.limit`
/// agents the person chatted with are donated; an agent that falls off the end is withdrawn. The
/// share extension declares it handles these actions and opens with that agent already chosen
/// (`ShareSuggestion`). iOS decides what shows and in what order, so a donation makes an agent
/// eligible, not guaranteed.
@MainActor
enum ShareSuggestions {
	private static let recents = ShareSuggestionRecents(defaults: .standard)

	/// Brings the donations in step with the workspace's agents: agents shared to count as chatted
	/// with, renamed or deleted agents are fixed or withdrawn, and an empty row gets the Chief of
	/// Staff so there is something to tap before any chat.
	static func refresh(environment: AppEnvironment) async {
		guard let workspaceId = environment.workspaceId,
			let agents = try? await APIShareRemote(client: environment.client, workspaceID: workspaceId).agents()
		else { return }
		let current = agents.map { ShareSuggestionRecents.Entry(id: $0.id, name: $0.name) }
		withdraw(recents.reconcile(with: current, workspaceId: workspaceId), workspaceId: workspaceId)
		let known = Set(recents.entries(workspaceId: workspaceId).map(\.id))
		let shared = ShareAgentMemory.shared()?.recent(workspaceId: workspaceId) ?? []
		// Oldest first, so the most recent share ends up first.
		for id in shared.reversed() where !known.contains(id) {
			if let entry = current.first(where: { $0.id == id }) { promote(entry, workspaceId: workspaceId) }
		}
		if recents.entries(workspaceId: workspaceId).isEmpty, let chief = agents.first(where: \.isChiefOfStaff) {
			promote(.init(id: chief.id, name: chief.name), workspaceId: workspaceId)
		}
		// Oldest first: the one donated last is the most recent to iOS.
		for entry in recents.entries(workspaceId: workspaceId).reversed() {
			donate(entry, workspaceId: workspaceId)
		}
	}

	/// The person just talked to `agentID`: it moves to the front of the row.
	static func chatted(agentID: String, name: String, workspaceId: String) {
		promote(.init(id: agentID, name: name), workspaceId: workspaceId)
	}

	/// Sign-out: nothing of this account stays offered to iOS.
	static func clear() {
		recents.removeAll()
		#if os(iOS)
			INInteraction.deleteAll { _ in }
		#endif
	}

	private static func promote(_ entry: ShareSuggestionRecents.Entry, workspaceId: String) {
		let dropped = recents.promote(entry, workspaceId: workspaceId)
		withdraw(dropped, workspaceId: workspaceId)
		donate(entry, workspaceId: workspaceId)
	}

	private static func withdraw(_ entries: [ShareSuggestionRecents.Entry], workspaceId: String) {
		#if os(iOS)
			for entry in entries {
				let identifier = ShareSuggestion(workspaceId: workspaceId, agentID: entry.id).conversationIdentifier
				INInteraction.delete(with: identifier) { _ in }
			}
		#endif
	}

	private static func donate(_ entry: ShareSuggestionRecents.Entry, workspaceId: String) {
		#if os(iOS)
			let identifier = ShareSuggestion(workspaceId: workspaceId, agentID: entry.id).conversationIdentifier
			let person = INPerson(
				personHandle: INPersonHandle(value: entry.id, type: .unknown), nameComponents: nil,
				displayName: entry.name, image: avatar(name: entry.name, id: entry.id), contactIdentifier: nil,
				customIdentifier: entry.id)
			let intent = INSendMessageIntent(
				recipients: [person], outgoingMessageType: .outgoingMessageText, content: nil,
				speakableGroupName: nil, conversationIdentifier: identifier, serviceName: nil, sender: nil,
				attachments: nil)
			let interaction = INInteraction(intent: intent, response: nil)
			interaction.direction = .outgoing
			// One group per agent, so withdrawing it removes every earlier donation of it.
			interaction.groupIdentifier = identifier
			interaction.donate { _ in }
		#endif
	}

	#if os(iOS)
		/// The same initials-on-a-plate avatar the app draws everywhere else.
		private static func avatar(name: String, id: String) -> INImage? {
			let renderer = ImageRenderer(content: ActorAvatar(name: name, kind: .agent, size: 96, seed: id))
			renderer.scale = 2
			guard let data = renderer.uiImage?.pngData() else { return nil }
			return INImage(imageData: data)
		}
	#endif
}
