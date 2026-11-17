import MaskinCore

#if os(iOS)
	import Intents
	import MaskinUI
	import SwiftUI
	import UIKit
#endif

/// Offers agents in the top row of the iOS share sheet, next to the contacts from Messages and
/// Slack. iOS fills that row from message actions apps donate, so each agent is donated as one:
/// named after the agent, wearing its avatar. The share extension declares it handles them and
/// opens with that agent already chosen (`ShareSuggestion`). iOS decides what shows and in what
/// order, so a donation makes an agent eligible, not guaranteed.
@MainActor
enum ShareSuggestions {
	/// Donates the Chief of Staff, so the row has an agent before any chat, and the agents the
	/// person last shared to.
	static func refresh(environment: AppEnvironment) async {
		#if os(iOS)
			guard let workspaceId = environment.workspaceId,
				let agents = try? await APIShareRemote(client: environment.client, workspaceID: workspaceId).agents()
			else { return }
			let remembered = ShareAgentMemory.shared()?.recent(workspaceId: workspaceId) ?? []
			for agent in agents where agent.isChiefOfStaff || remembered.contains(agent.id) {
				donate(agentID: agent.id, name: agent.name, workspaceId: workspaceId)
			}
		#endif
	}

	/// Tells iOS the person just talked to `agentID`, which is what ranks it in the row.
	static func donate(agentID: String, name: String, workspaceId: String) {
		#if os(iOS)
			let person = INPerson(
				personHandle: INPersonHandle(value: agentID, type: .unknown), nameComponents: nil,
				displayName: name, image: avatar(name: name, id: agentID), contactIdentifier: nil,
				customIdentifier: agentID)
			let intent = INSendMessageIntent(
				recipients: [person], outgoingMessageType: .outgoingMessageText, content: nil,
				speakableGroupName: nil,
				conversationIdentifier: ShareSuggestion(workspaceId: workspaceId, agentID: agentID).conversationIdentifier,
				serviceName: nil, sender: nil, attachments: nil)
			let interaction = INInteraction(intent: intent, response: nil)
			interaction.direction = .outgoing
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
