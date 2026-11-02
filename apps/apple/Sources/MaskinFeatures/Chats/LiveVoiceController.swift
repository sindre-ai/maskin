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
		/// How fast the voice reads (`AVSpeechUtterance.rate`).
		var setSpeechRate: @MainActor (Float) -> Void = { _ in }
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
	/// How the agent's replies are delivered: in beats with listening breaks, or straight through.
	var pace: LiveCallPace {
		didSet {
			pacer.pace = pace
			ports.setSpeechRate(pace.speechRate)
			pace.store(defaults)
		}
	}
	/// The mic is open for you between the beats of a reply: "Your turn…".
	var isYourTurn: Bool { machine.phase == .speaking && onBreak }
	private(set) var onBreak = false
	/// The agent's name on its turns.
	@ObservationIgnored var agentName = "Agent"

	var phase: LiveVoicePhase { machine.phase }
	var transcript: String { machine.transcript }
	var isMuted: Bool { machine.isMuted }
	/// What the agent is saying now, for captions.
	var speakingText: String? { phase == .speaking ? turns.last { !$0.isYou }?.text : nil }

	@ObservationIgnored private let ports: Ports
	@ObservationIgnored private let defaults: UserDefaults
	@ObservationIgnored private let greeting: String?
	@ObservationIgnored private var pacer = ReplyPacer()
	/// A short acknowledgement heard after the reading stopped, waiting to prove it is the whole phrase.
	@ObservationIgnored private var ack: (text: String, since: Date)?
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

	init(
		ports: Ports, tickInterval: Duration = .milliseconds(250),
		defaults: UserDefaults = .standard, pace: LiveCallPace? = nil,
		greeting: String? = LiveVoiceController.defaultGreeting
	) {
		self.ports = ports
		self.tickInterval = tickInterval
		self.defaults = defaults
		self.greeting = greeting
		let chosen = pace ?? LiveCallPace.stored(defaults)
		self.pace = chosen
		pacer.pace = chosen
	}

	/// Said once at the start so the call does not open in silence. Kept out of the chat on purpose: a posted
	/// message would make the agent answer it.
	static let defaultGreeting = "Hi, I am listening."
	private static let greetingID = "live-greeting"

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
		pacer.discard()
		ports.setSpeechRate(pace.speechRate)
		run(machine.begin())
		if let greeting {
			texts[Self.greetingID] = greeting
			run(machine.greet(messageID: Self.greetingID, text: greeting))
		}
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

	/// Send what has been heard now instead of waiting out the pause.
	func sendNow() { run(machine.commitNow(at: ports.now())) }

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
		let now = ports.now()
		resumeIfAsked(at: now)
		run(machine.tick(at: now))
		switch machine.phase {
		case .speaking:
			tickReading(at: now)
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
			case .speak(let id): read(id)
			case .stopSpeaking:
				ports.stopSpeaking()
				// Cut off mid-reading: "go on" picks up at the beat that was interrupted.
				pacer.interrupted(at: ports.now())
				onBreak = false
			}
		}
	}

	// MARK: Reading in beats

	/// Say an agent reply: straight through when quick, otherwise beat by beat with breaks.
	private func read(_ id: String) {
		let spoken = SpokenReply.text(from: texts[id] ?? "")
		guard pace.isPaced else {
			ports.speak(id, spoken)
			return
		}
		runPacer(pacer.enqueue(id: id, text: spoken, at: ports.now()))
	}

	private func runPacer(_ commands: [ReplyPacer.Command]) {
		for command in commands {
			switch command {
			case .speak(let id, let text): ports.speak(id, text)
			case .resetTranscript: ports.resetTranscript()
			case .finished: run(machine.speechFinished())
			case .takeOver(let text):
				// You started talking in a break: the usual barge-in, with the words so far kept.
				// The recogniser keeps its transcript: the words so far are the start of your turn.
				run(machine.interrupt().filter { $0 != .resetTranscript && $0 != .startListening })
				run(machine.heard(text, at: ports.now()))
			}
		}
		onBreak = pacer.isOnBreak
	}

	/// While the agent is speaking: a beat ending starts a break; a break ends by itself, by "go on",
	/// or by you taking over.
	private func tickReading(at now: Date) {
		guard pace.isPaced else {
			if !ports.isSpeaking() { run(machine.speechFinished()) }
			return
		}
		switch pacer.state {
		case .speaking, .speakingCheckIn:
			if !ports.isSpeaking() { runPacer(pacer.beatFinished(at: now)) }
		case .pause, .held:
			runPacer(pacer.tick(at: now))
		case .idle:
			if !ports.isSpeaking() { run(machine.speechFinished()) }
		}
	}

	/// What the recogniser hears: during a break it is you reacting; after the reading stopped, a
	/// short "go on" picks it up again; otherwise it is the machine's to turn into a message.
	private func heard(_ text: String, isFinal: Bool) {
		let now = ports.now()
		if machine.phase == .speaking, pacer.isOnBreak, pace.isPaced {
			guard !machine.isMuted, !machine.isEcho(text), !machine.isFiller(text) else { return }
			runPacer(pacer.heard(text, at: now))
			return
		}
		if machine.phase == .listening, pacer.canResume(at: now), SpokenReaction.classify(text) == .continue {
			if ack?.text != text { ack = (text, now) }
		} else {
			ack = nil
		}
		run(machine.heard(text, at: now, isFinal: isFinal))
	}

	private func resumeIfAsked(at now: Date) {
		guard let candidate = ack, machine.phase == .listening, machine.transcript == candidate.text,
			now.timeIntervalSince(candidate.since) >= ReplyPacer.reactionDelay, pacer.canResume(at: now)
		else { return }
		ack = nil
		run(machine.resumeSpeaking(text: pacer.remainingText))
		runPacer(pacer.resume(at: now))
	}

	/// One finished line of yours: it goes into the chat at once.
	private func send(_ text: String) {
		pacer.discard()
		onBreak = false
		ack = nil
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
				self.heard(text, isFinal: isFinal)
			}
			self.starting = false
			if let problem {
				self.failure = problem
				self.end()
			}
		}
	}
}
