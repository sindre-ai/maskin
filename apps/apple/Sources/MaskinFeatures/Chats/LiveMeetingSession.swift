import Foundation
import MaskinCore
import Observation

/// One live call: the voice loop (`LiveVoiceController`) wired to a chat. What you say is sent as
/// a message in that chat the moment it is final, and the agent's reply arrives as an ordinary
/// message that is read aloud, so the thread holds the call as it happens (even if the app is killed); the call keeps its own clock and the
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
	var captionsOn = true
	/// Where the call's sound goes ("iPhone Speaker", "AirPods"); empty until the call starts.
	private(set) var routeName = ""

	@ObservationIgnored private let now: () -> Date
	#if os(iOS)
	@ObservationIgnored private let audio = LiveAudioSession()
	#endif

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
		voice.agentName = lead.name
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
		#if os(iOS)
		SpeechReader.shared.usesExternalAudioSession = true
		do {
			try audio.activate(
				title: "Live with \(lead.name)",
				handlers: .init(
					interruptionBegan: { [weak self] in self?.voice.interruptionBegan() },
					interruptionEnded: { [weak self] in self?.voice.interruptionEnded(shouldResume: $0) },
					routeChanged: { [weak self] in self?.routeName = $0 },
					mediaServicesReset: { [weak self] in self?.voice.audioReset() },
					setMuted: { [weak self] in self?.setMuted($0) },
					toggleMuted: { [weak self] in self?.toggleMute() }))
			routeName = audio.routeName
		} catch {
			voice.begin(existing: chat.messages)
			voice.fail("Couldn't open the audio session (\(error.localizedDescription)).")
			return
		}
		#endif
		voice.begin(existing: chat.messages)
		watch()
	}

	func toggleMute() {
		voice.toggleMute()
		refreshNowPlaying()
	}

	private func setMuted(_ muted: Bool) {
		if voice.isMuted != muted { toggleMute() }
	}

	/// Keeps the lock screen's card and its elapsed time current.
	func refreshNowPlaying() {
		#if os(iOS)
		guard isLive else { return }
		audio.updateNowPlaying(muted: voice.isMuted, elapsed: elapsed(at: now()))
		#endif
	}

	/// Follow the thread without depending on a view: a view's `onChange` is not delivered reliably
	/// while the app is in the background, which is exactly when a locked-screen call must keep
	/// hearing the agent's replies.
	private func watch() {
		guard isLive else { return }
		withObservationTracking {
			_ = chat.messages.map(\.id)
		} onChange: { [weak self] in
			Task { @MainActor [weak self] in
				guard let self, self.isLive else { return }
				self.messagesChanged()
				self.watch()
			}
		}
	}

	/// Words that could not reach the server (offline) or were refused; the call goes on and they
	/// send when the connection is back.
	var connectionNotice: String? {
		let mine = chat.messages.filter { $0.actorID == chat.currentActorID }
		if mine.contains(where: { if case .failed = $0.status { true } else { false } }) {
			return "Some of what you said didn't send. Tap Retry in the chat."
		}
		if mine.contains(where: { if case .waiting = $0.status { true } else { false } }) {
			return "No connection: what you say will send when you're back online."
		}
		return nil
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

	/// Hang up. An ad hoc call leaves a note in its chat: "Live meeting with X · 0:42" and the
	/// transcript, so the agent has the call as context and the thread shows what happened. The
	/// briefing doesn't.
	func end() {
		guard isLive else { return }
		// Sends whatever was heard but not yet said as a line, so it is in the thread.
		voice.end()
		let finished = now()
		endedAt = finished
		#if os(iOS)
		audio.deactivate()
		SpeechReader.shared.usesExternalAudioSession = false
		#endif
		guard kind.postsNote else { return }
		let title = LiveMeetingFormat.endNote(
			lead: lead.name, guests: guests.map(\.name), seconds: elapsed(at: finished))
		// Every line was posted as it was said; the note summarises them rather than repeating them.
		_ = chat.send(LiveMeetingNote.summary(title: title, turns: voice.turns).markdown)
	}
}
