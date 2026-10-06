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
		/// Starts the recogniser; `onText` gets the running transcript. Returns what went wrong, if it
		/// could not start (permission refused, language unavailable).
		var startListening: @MainActor (_ onText: @escaping @MainActor (String) -> Void) async -> String?
		var stopListening: @MainActor () -> Void
		var isListening: @MainActor () -> Bool
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

	var phase: LiveVoicePhase { machine.phase }
	var transcript: String { machine.transcript }
	var isMuted: Bool { machine.isMuted }

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
		failure = nil
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

	func end() {
		guard isActive else { return }
		run(machine.end())
		ticker?.cancel()
		ticker = nil
		isActive = false
	}

	func toggleMute() { run(machine.setMuted(!machine.isMuted)) }

	/// Stop the agent talking and listen at once.
	func interrupt() { run(machine.interrupt()) }

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
			run(machine.replyArrived(messageID: message.id))
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
		case .listening:
			if !machine.isMuted, !starting, !ports.isListening() {
				let now = ports.now()
				restarts = restarts.filter { now.timeIntervalSince($0) < Self.restartWindow } + [now]
				if restarts.count > Self.restartLimit {
					failure = "Couldn't keep listening. Check the microphone and try again."
					end()
					return
				}
				run([.startListening])
			}
		case .thinking:
			break
		}
	}

	private func run(_ commands: [LiveVoiceMachine.Command]) {
		for command in commands {
			switch command {
			case .startListening: startListening()
			case .stopListening: ports.stopListening()
			case .send(let text): ports.send(text)
			case .speak(let id): ports.speak(id, texts[id] ?? "")
			case .stopSpeaking: ports.stopSpeaking()
			}
		}
	}

	private func startListening() {
		guard !starting else { return }
		starting = true
		Task { [weak self] in
			guard let self else { return }
			let problem = await self.ports.startListening { [weak self] text in
				guard let self else { return }
				self.run(self.machine.heard(text, at: self.ports.now()))
			}
			self.starting = false
			if let problem {
				self.failure = problem
				self.end()
			}
		}
	}
}
