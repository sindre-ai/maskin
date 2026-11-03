import MaskinCore
import SwiftUI

/// The Chief of Staff conversation the daily briefing runs in: the existing "Daily briefing" chat,
/// or a new one the first time.
@MainActor
enum BriefingChat {
	static let title = "Daily briefing"

	struct Failure: Error {
		let message: String
	}

	/// `oneToOne` finds (or starts) the Chief of Staff's ordinary chat instead of the briefing's own.
	static func resolve(environment: AppEnvironment, oneToOne: Bool = false) async throws -> (conversationID: String, lead: ChatParticipant) {
		guard let workspaceID = environment.workspaceId, environment.auth.session != nil else {
			throw Failure(message: "Choose a workspace first.")
		}
		let source = APIChatsSource(client: environment.client, workspaceID: workspaceID)
		let list = ConversationsStore(api: source, events: nil, cache: nil)
		await list.loadActors()
		guard let chief = list.actors.first(where: \.isChiefOfStaff) else {
			throw Failure(message: "This workspace has no Chief of Staff to brief you.")
		}
		await list.refresh()
		let existing =
			oneToOne
			? ChiefOfStaffLiveChat.pick(
				from: list.conversations, chiefID: chief.id, excludingTitle: title)
			: list.conversations.first {
				$0.title == title && $0.participants.contains { $0.id == chief.id }
			}
		let conversationID: String
		if let existing {
			conversationID = existing.id
		} else {
			conversationID = try await list.create(
				title: oneToOne ? ThreadLayout.defaultTitle(for: [chief.participant.name]) : title, participantIDs: [chief.id], firstMessage: nil
			).id
		}
		return (conversationID, chief.participant)
	}

	/// The thread store for a conversation that already exists. Nil without a workspace or sign-in.
	static func chatStore(conversationID: String, environment: AppEnvironment) -> ChatStore? {
		guard let workspaceID = environment.workspaceId, let session = environment.auth.session else { return nil }
		let chat = ChatStore(
			conversationID: conversationID, currentActorID: session.actorId,
			currentActorName: session.name,
			api: APIChatsSource(client: environment.client, workspaceID: workspaceID),
			queue: ChatsRuntime.shared(environment: environment).queue, events: environment.events,
			cache: environment.snapshotCache)
		chat.trace = ActivityStore(
			source: HTTPSessionActivitySource(environment: environment), cache: environment.snapshotCache)
		return chat
	}
}


extension LiveMeetingSession {
	/// The real microphone and speaker.
	static func devicePorts(
		send: @escaping @MainActor (String) -> Void
	) -> LiveVoiceController.Ports {
		#if os(iOS)
		// The call has its own recogniser (gapless restarts, echo-cancelled, no audio-session
		// ownership); dictation in the composer keeps `Dictation`.
		let listener = LiveListener()
		return LiveVoiceController.Ports(
			startListening: { onText in
				if let problem = await listener.start(onText: onText) { return problem }
				return nil
			},
			stopListening: { listener.stop() },
			isListening: { listener.isListening },
			resetTranscript: { listener.resetTranscript() },
			speak: { id, markdown in SpeechReader.shared.enqueue(markdown: markdown, id: id) },
			stopSpeaking: { SpeechReader.shared.stop() },
			isSpeaking: { SpeechReader.shared.speakingID != nil },
			send: send,
			setSpeechRate: { SpeechReader.shared.rate = $0 })
		#else
		return LiveVoiceController.Ports(
			startListening: { _ in "Live calls need an iPhone or iPad." },
			stopListening: {}, isListening: { false },
			speak: { _, _ in }, stopSpeaking: {}, isSpeaking: { false }, send: send)
		#endif
	}
}

