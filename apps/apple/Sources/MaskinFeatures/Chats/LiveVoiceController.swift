import MaskinCore
import Observation
import SwiftUI

/// Runs a live voice conversation: it feeds what the microphone hears and what the agent replies into
/// `LiveVoiceMachine` and carries out what the machine decides, through `Ports` so the real
/// dictation and speech can be swapped for fakes in tests.
@MainActor
@Observable
final class LiveVoiceController {
	struct Ports {
		/// Starts the recogniser (a no-op when it is running); `onText` gets the running transcript and
		/// whether the recogniser calls the utterance final. Returns what went wrong, if it could not
		/// start (permission refused, language unavailable).
		var startListening: @MainActor (_ onText: @escaping @MainActor (String, Bool) -> Void) async -> String?
		var stopListening: @MainActor () -> Void
		var isListening: @MainActor () -> Bool
		/// Starts the recogniser's transcript over without a gap in the audio.
		var resetTranscript: @MainActor () -> Void = {}
		/// Reads a message aloud, after whatever is already being read.
		var speak: @MainActor (_ messageID: String, _ markdown: String) -> Void
		var stopSpeaking: @MainActor () -> Void
		var isSpeaking: @MainActor () -> Bool
		/// Sends what was said as a message.
		var send: @MainActor (String) -> Void
		var now: @MainActor () -> Date = { Date() }
	}

	private(set) var machine = LiveVoiceMachine()
	private(set) var isActive = false
	/// Why the conversation could not start or had to stop ("Allow Microphone access in Settings…").
	private(set) var failure: String?
	/// What was said in this call, in order: your sent lines and the agent's replies.
	private(set) var turns: [LiveMeetingTurn] = []
	/// A problem that does not stop the call ("Microphone interrupted", "Listening again…").
	private(set) var notice: String?
	/// A phone call, Siri or an alarm has the audio: the call is paused until it hands it back.
	private(set) var isInterrupted = false
	/// The agent's name on its turns.
	@ObservationIgnored var agentName = "Agent"

	var phase: LiveVoicePhase { machine.phase }
	var transcript: String { machine.transcript }
	var isMuted: Bool { machine.isMuted }
	/// What the agent is saying now, for captions.
	var speakingText: String? { phase == .speaking ? turns.last { !$0.isYou }?.text : nil }

	@ObservationIgnored private let ports: Ports
	@ObservationIgnored private let tickInterval: Duration
	@ObservationIgnored private var seen: Set<String> = []
	@ObservationIgnored private var texts: [String: String] = [:]
	@ObservationIgnored private var ticker: Task<Void, Never>?
	@ObservationIgnored private var starting = false
	/// When the recogniser had to be started again by itself. A recogniser that keeps dying (no input,
	/// a route change that never settles) must end the conversation, not restart forever.
	@ObservationIgnored private var restarts: [Date] = []
	private static let restartLimit = 4
	private static let restartWindow: TimeInterval = 15

	init(ports: Ports, tickInterval: Duration = .milliseconds(250)) {
		self.ports = ports
		self.tickInterval = tickInterval
	}

	/// Begin listening. Messages already in the thread are not replies and are never read.
	func begin(existing messages: [ChatMessage]) {
		guard !isActive else { return }
		seen = Set(messages.map(\.id))
		texts = [:]
		turns = []
		failure = nil
		notice = nil
		isInterrupted = false
		isActive = true
		run(machine.begin())
		ticker = Task { [weak self] in
			while !Task.isCancelled {
				let interval = self?.tickInterval ?? .milliseconds(250)
				try? await Task.sleep(for: interval)
				guard let self, !Task.isCancelled else { return }
				self.tick()
			}
		}
	}

	/// Hang up. What was heard but not yet sent is sent first, so nothing said is lost.
	func end() {
		guard isActive else { return }
		if let pending = machine.pendingText { send(pending) }
		run(machine.end())
		ticker?.cancel()
		ticker = nil
		isActive = false
	}

	func toggleMute() { run(machine.setMuted(!machine.isMuted)) }

	/// Stop the agent talking and listen at once.
	func interrupt() { run(machine.interrupt()) }

	/// The media server restarted: the recogniser is gone; the next beat starts it again.
	func audioReset() {
		guard isActive else { return }
		ports.stopListening()
	}

	/// The call cannot go on (the audio session would not open).
	func fail(_ message: String) {
		failure = message
		end()
	}

	/// Something else took the audio (a phone call, Siri): stop listening and speaking, keep the call.
	func interruptionBegan() {
		guard isActive, !isInterrupted else { return }
		isInterrupted = true
		notice = "Paused: the microphone is in use by something else."
		if let pending = machine.pendingText { send(pending) }
		ports.stopListening()
		ports.stopSpeaking()
		run(machine.interrupt())
	}

	/// The audio came back. `shouldResume` is the system's own hint; without it the call ends.
	func interruptionEnded(shouldResume: Bool) {
		guard isActive, isInterrupted else { return }
		isInterrupted = false
		guard shouldResume else {
			failure = "The call was interrupted and ended. What was said is saved in the chat."
			end()
			return
		}
		notice = nil
		if !machine.isMuted { startListening() }
	}

	/// The thread changed: a new agent message is the reply being waited for.
	func messagesChanged(_ messages: [ChatMessage]) {
		guard isActive else { return }
		for message in messages where !seen.contains(message.id) {
			seen.insert(message.id)
			guard message.author == .agent, !message.isSystem else { continue }
			if message.isErrorReply {
				run(machine.replyFailed())
				continue
			}
			texts[message.id] = message.content
			turns.append(LiveMeetingTurn(speaker: agentName, text: message.content, isYou: false))
			run(machine.replyArrived(messageID: message.id, text: message.content))
		}
	}

	/// One beat: the machine checks its pause timer, and the controller notices the things only the
	/// outside world knows (the reader went quiet, the recogniser stopped by itself).
	func tick() {
		guard isActive else { return }
		run(machine.tick(at: ports.now()))
		switch machine.phase {
		case .speaking:
			if !ports.isSpeaking() { run(machine.speechFinished()) }
		case .listening, .thinking:
			if !machine.isMuted, !isInterrupted, !starting, !ports.isListening() {
				let now = ports.now()
				restarts = restarts.filter { now.timeIntervalSince($0) < Self.restartWindow } + [now]
				if restarts.count > Self.restartLimit {
					failure = "Couldn't keep listening. Check the microphone and try again."
					end()
					return
				}
				notice = "Listening again…"
				run([.startListening])
			}
		}
	}

	private func run(_ commands: [LiveVoiceMachine.Command]) {
		for command in commands {
			switch command {
			case .startListening: startListening()
			case .stopListening: ports.stopListening()
			case .resetTranscript: ports.resetTranscript()
			case .send(let text): send(text)
			case .speak(let id): ports.speak(id, texts[id] ?? "")
			case .stopSpeaking: ports.stopSpeaking()
			}
		}
	}

	/// One finished line of yours: it goes into the chat at once.
	private func send(_ text: String) {
		turns.append(LiveMeetingTurn(speaker: LiveMeetingNote.youName, text: text, isYou: true))
		ports.send(text)
	}

	private func startListening() {
		guard !starting, !isInterrupted, !ports.isListening() else { return }
		starting = true
		Task { [weak self] in
			guard let self else { return }
			let problem = await self.ports.startListening { [weak self] text, isFinal in
				guard let self, self.isActive else { return }
				self.notice = nil
				self.run(self.machine.heard(text, at: self.ports.now(), isFinal: isFinal))
			}
			self.starting = false
			if let problem {
				self.failure = problem
				self.end()
			}
		}
	}
}
