import Foundation
import MaskinCore
import Observation

/// One live call: the voice loop (`LiveVoiceController`) wired to a chat. What you say is sent as
/// a message in that chat; the agent's reply is read aloud; the call keeps its own clock and the
/// names of anyone invited.
@MainActor
@Observable
final class LiveMeetingSession {
	let kind: LiveMeetingKind
	let chat: ChatStore
	let lead: ChatParticipant
	let voice: LiveVoiceController

	private(set) var guests: [ChatParticipant] = []
	private(set) var startedAt: Date?
	private(set) var endedAt: Date?
	var captionsOn = false

	@ObservationIgnored private let now: () -> Date

	/// `makePorts` receives the "send" action and returns the microphone/speaker ports around it.
	init(
		kind: LiveMeetingKind, chat: ChatStore, lead: ChatParticipant,
		makePorts: (@escaping @MainActor (String) -> Void) -> LiveVoiceController.Ports,
		now: @escaping () -> Date = { Date() }
	) {
		self.kind = kind
		self.chat = chat
		self.lead = lead
		self.now = now
		voice = LiveVoiceController(ports: makePorts { [chat] text in _ = chat.send(text) })
	}

	var isLive: Bool { startedAt != nil && endedAt == nil }

	func elapsed(at date: Date) -> TimeInterval {
		guard let startedAt else { return 0 }
		return max(0, (endedAt ?? date).timeIntervalSince(startedAt))
	}

	/// Start the call: messages already in the thread are history, not replies to read out.
	func begin() {
		guard startedAt == nil else { return }
		startedAt = now()
		voice.begin(existing: chat.messages)
	}

	/// The thread changed; hand the new messages to the voice loop.
	func messagesChanged() { voice.messagesChanged(chat.messages) }

	/// What the agent last said, for captions: real message text, as received.
	var lastAgentWords: String? {
		chat.messages.last { $0.author == .agent && !$0.isSystem && !$0.isErrorReply }?.content
	}

	/// People and agents that can still be invited: in the workspace, not already in the chat.
	func invitable(from actors: [ChatActor]) -> [ChatActor] {
		let inChat = Set(chat.participants.map(\.id)).union(guests.map(\.id))
		return actors.filter { !inChat.contains($0.id) && $0.participant.kind == .agent }
			.sorted { $0.participant.name < $1.participant.name }
	}

	func invite(_ actor: ChatActor) async {
		guard !guests.contains(where: { $0.id == actor.id }) else { return }
		await chat.addParticipants([actor.id])
		guests.append(actor.participant)
	}

	/// Pull an object up: post it into the chat as a link everyone in the call can open.
	func pullUp(title: String, url: URL) {
		_ = chat.send("Pulling up [\(title)](\(url.absoluteString))")
	}

	/// Hang up. An ad hoc call leaves "Live meeting with X · 0:42" in its chat; the briefing doesn't.
	func end() {
		guard isLive else { return }
		voice.end()
		let finished = now()
		endedAt = finished
		guard kind.postsNote else { return }
		let note = LiveMeetingFormat.endNote(
			lead: lead.name, guests: guests.map(\.name), seconds: elapsed(at: finished))
		_ = chat.send(note)
	}
}
