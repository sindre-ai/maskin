import Foundation
import MaskinCore
import Observation

/// One live call: a voice driver wired to a chat. By default that is the OpenAI Realtime call with
/// the lead agent (`RealtimeVoiceCall`); when there is none, or the server won't take it, it is the
/// dictation loop (`LiveVoiceController`): what you say is sent as a message in that chat the moment
/// it is final, and the agent's reply arrives as an ordinary message that is read aloud, so the
/// thread holds the call as it happens (even if the app is killed). The call keeps its own clock and
/// the names of anyone invited.
@MainActor
@Observable
final class LiveMeetingSession {
	let kind: LiveMeetingKind
	let chat: ChatStore
	let lead: ChatParticipant
	/// What carries the conversation: the Realtime call when there is one, otherwise (or if the
	/// server won't take the call) the dictation loop.
	private(set) var voice: any LiveVoiceDriving

	private(set) var guests: [ChatParticipant] = []
	private(set) var startedAt: Date?
	private(set) var endedAt: Date?
	@ObservationIgnored private var participantsAtStart: Set<String> = []
	/// Where the call's sound goes ("iPhone Speaker", "AirPods"); empty until the call starts.
	private(set) var routeName = ""
	/// The dock folded down to a pill in its thread.
	var isMinimized = false
	/// Show the agent's latest words under the header.
	var showsCaptions = true
	/// Loudspeaker (true) or earpiece.
	private(set) var usesSpeaker = true
	/// What was said in a voice call, as it was transcribed. Observed, so the thread's card follows it.
	private(set) var lines: [LiveCallLine] = []

	@ObservationIgnored private let now: () -> Date
	@ObservationIgnored let dictation: LiveVoiceController
	@ObservationIgnored private let log: LiveCallLog
	/// The call's record id, set when it begins; the send closure built in `init` reads it.
	@ObservationIgnored private let callRef: CallRef

	final class CallRef: @unchecked Sendable {
		@MainActor var id: String?
	}
	#if os(iOS)
	@ObservationIgnored private let audio = LiveAudioSession()
	#endif

	/// `makePorts` receives the "send" action and returns the microphone/speaker ports around it.
	/// With `realtime`, the call is a voice call with the lead agent; the ports are only used if it
	/// falls back.
	init(
		kind: LiveMeetingKind, chat: ChatStore, lead: ChatParticipant,
		makePorts: (@escaping @MainActor (String) -> Void) -> LiveVoiceController.Ports,
		realtime: RealtimeVoiceCall? = nil,
		now: @escaping () -> Date = { Date() }, log: LiveCallLog = .shared
	) {
		self.log = log
		self.kind = kind
		self.chat = chat
		self.lead = lead
		self.now = now
		let call = CallRef()
		callRef = call
		let dictation = LiveVoiceController(
			ports: makePorts { [chat] text in
				_ = chat.send(text)
				if let id = call.id { log.update(id) { $0.spoken.append(text.trimmingCharacters(in: .whitespacesAndNewlines)) } }
			})
		dictation.agentName = lead.name
		self.dictation = dictation
		if let realtime {
			voice = realtime
			realtime.onFallBack = { [weak self] in self?.useDictation() }
			realtime.onLine = { [weak self] isYou, text in self?.keep(isYou: isYou, text: text) }
		} else {
			voice = dictation
		}
	}

	/// A finished line of a voice call goes to the call's record on this device: the call posts nothing
	/// to the chat, so this is what the card shows during the call and after it.
	private func keep(isYou: Bool, text: String) {
		let line = LiveCallLine(isYou: isYou, text: text, at: now())
		lines.append(line)
		if let id = callRef.id { log.update(id) { $0.lines.append(line) } }
	}

	/// The server can't take a voice call for this person: carry on as a dictated conversation.
	private func useDictation() {
		guard isLive else { return }
		voice = dictation
		dictation.begin(existing: chat.messages)
	}

	/// True while the dictation loop carries the call (so "Send now" and pace apply).
	var isDictating: Bool { voice === dictation }

	/// Words heard but not yet sent: "Send now" is offered while there are some.
	var hasPendingWords: Bool { isDictating && dictation.phase != .speaking && dictation.machine.pendingText != nil }

	func sendNow() { dictation.sendNow() }

	var isLive: Bool { startedAt != nil && endedAt == nil }

	func elapsed(at date: Date) -> TimeInterval {
		guard let startedAt else { return 0 }
		return max(0, (endedAt ?? date).timeIntervalSince(startedAt))
	}

	/// Start the call: messages already in the thread are history, not replies to read out.
	func begin() {
		guard startedAt == nil else { return }
		startedAt = now()
		participantsAtStart = Set(chat.participants.map(\.id))
		let record = LiveCallRecord(
			conversationID: chat.conversationID, leadName: lead.name, startedAt: startedAt ?? now())
		callRef.id = record.id
		log.save(record)
		#if os(iOS)
		SpeechReader.shared.usesExternalAudioSession = true
		do {
			try audio.activate(
				title: "Live with \(lead.name)",
				handlers: .init(
					interruptionBegan: { [weak self] in
						guard let self, self.isDictating else { return }
						self.dictation.interruptionBegan()
					},
					interruptionEnded: { [weak self] in
						guard let self, self.isDictating else { return }
						self.dictation.interruptionEnded(shouldResume: $0)
					},
					routeChanged: { [weak self] in self?.routeName = $0 },
					mediaServicesReset: { [weak self] in
						guard let self, self.isDictating else { return }
						self.dictation.audioReset()
					},
					setMuted: { [weak self] in self?.remoteMute($0) },
					toggleMuted: { [weak self] in self?.remoteToggleMute() }))
			routeName = audio.routeName
		} catch {
			SpeechReader.shared.usesExternalAudioSession = false
			// Nothing can run without the session: show the failure on the dictation loop.
			voice = dictation
			dictation.begin(existing: chat.messages)
			dictation.fail("Couldn't open the audio session (\(error.localizedDescription)).")
			return
		}
		#endif
		voice.begin(existing: chat.messages)
		watch()
	}

	func toggleSpeaker() {
		usesSpeaker.toggle()
		#if os(iOS)
		audio.setSpeaker(usesSpeaker)
		#endif
	}

	/// The agent's latest line for captions: the Realtime call's own transcript, or else the latest
	/// line in the thread since the call began.
	var latestAgentLine: String? {
		if voice.capturesOwnTranscript { return voice.agentWords }
		let since = startedAt ?? .distantPast
		return chat.messages.last {
			$0.kind == "message" && $0.actorID != chat.currentActorID && ($0.createdAt ?? .distantFuture) >= since
		}?.content.trimmingCharacters(in: .whitespacesAndNewlines)
	}

	func toggleMute() {
		voice.toggleMute()
		refreshNowPlaying()
	}

	/// Mute from the lock screen or headphones. The system can send a play/pause as the audio session
	/// or a Bluetooth route comes up; one in the first moments is not the person pressing mute.
	private func remoteMute(_ muted: Bool) {
		guard let startedAt, now().timeIntervalSince(startedAt) > 2 else { return }
		if voice.isMuted != muted { toggleMute() }
	}

	private func remoteToggleMute() {
		guard let startedAt, now().timeIntervalSince(startedAt) > 2 else { return }
		toggleMute()
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
		// Nothing is posted for the call itself: every line went into the thread as it was said, and a
		// message from you saying "Live meeting…" would read as speech and make the agent answer it.
		// The thread shows the call (section header, LIVE markers, summary card) from the messages
		// inside this window.
		if let id = callRef.id {
			// Anyone added to the chat during the call (from the banner's Invite) was a guest.
			let names = chat.participants.filter { !participantsAtStart.contains($0.id) }.map(\.name)
			log.update(id) {
				$0.endedAt = finished
				$0.guests = names
				// The call's card closes when the call ends.
				$0.expanded = false
			}
		}
	}
}
