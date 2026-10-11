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
	/// What was said on the call, in order: what you said and what the agent replied.
	var turns: [LiveMeetingFormat.Turn] { log.turns }

	@ObservationIgnored private let now: () -> Date
	@ObservationIgnored private var seen: Set<String> = []
	/// A box, so the send closure built in `init` can write to it before `self` is whole.
	@ObservationIgnored private let log = TurnLog()

	private final class TurnLog {
		var turns: [LiveMeetingFormat.Turn] = []
	}

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
		let log = log
		voice = LiveVoiceController(ports: makePorts { [log, chat] text in
			log.turns.append(.init(speaker: "You", text: text))
			_ = chat.send(text)
		})
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
		seen = Set(chat.messages.map(\.id))
		voice.begin(existing: chat.messages)
	}

	/// The thread changed; hand the new messages to the voice loop.
	func messagesChanged() {
		for message in chat.messages where !seen.contains(message.id) {
			seen.insert(message.id)
			if message.author == .agent, !message.isSystem, !message.isErrorReply {
				log.turns.append(.init(speaker: message.actorName, text: message.content))
			}
		}
		voice.messagesChanged(chat.messages)
	}

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
			lead: lead.name, guests: guests.map(\.name), seconds: elapsed(at: finished), turns: turns)
		_ = chat.send(note)
	}
}
