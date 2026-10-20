import Foundation

/// Delivers a spoken reply beat by beat with listening breaks, with no audio in it: it is told when a
/// beat ended, what was heard and what time it is, and answers with what to say next.
///
///     speaking ─(beat ends)─▶ break ─(quiet)─▶ speaking …            check-in every ~3 beats, once
///                               │
///        "yes/go on" ──────────▶ next beat at once
///        "wait/stop" ──────────▶ held until you finish (then what you added is a turn)
///        anything else ────────▶ you take over: remaining beats are kept for "go on" for 30s
public struct ReplyPacer: Sendable, Equatable {
	public enum Command: Equatable, Sendable {
		/// Say this (a beat, or a local check-in that is never posted anywhere).
		case speak(id: String, text: String)
		/// Nothing left to say.
		case finished
		/// You started a turn of your own during a break: stop reading and treat these words as it.
		case takeOver(String)
		/// The words heard so far were an acknowledgement; start the recogniser's transcript afresh.
		case resetTranscript
	}

	public enum Next: Equatable, Sendable { case nextBeat, checkIn }

	public enum State: Equatable, Sendable {
		case idle
		case speaking
		case speakingCheckIn
		case pause(until: Date, then: Next)
		case held(since: Date)
	}

	public private(set) var state: State = .idle
	public var pace: LiveCallPace = .relaxed

	/// A short acknowledgement must hold still this long before it counts (it may be "yes, but…").
	public static let reactionDelay: TimeInterval = 0.5
	/// After a hold phrase, this much quiet means you have finished speaking.
	public static let heldQuiet: TimeInterval = 1.2
	/// A bare "wait" does not stop the reading forever.
	public static let heldLimit: TimeInterval = 30
	/// How long "go on" picks up where the reading stopped.
	public static let resumeWindow: TimeInterval = 30
	public static let beatsPerCheckIn = 3

	private var beats: [SpokenPacing.Beat] = []
	private var current: SpokenPacing.Beat?
	private var replyID = ""
	private var counter = 0
	private var beatsSinceCheckIn = 0
	private var checkedIn = false
	private var resumeUntil: Date?
	private var heardText = ""
	private var heardAt: Date?

	public init(pace: LiveCallPace = .relaxed) { self.pace = pace }

	/// The mic is open for you: between beats, or held.
	public var isOnBreak: Bool {
		switch state {
		case .pause, .held: true
		default: false
		}
	}

	public var isReading: Bool { state != .idle }
	public var hasRemaining: Bool { !beats.isEmpty }
	/// What is left to read, for the echo guard.
	public var remainingText: String { ([current?.text].compactMap { $0 } + beats.map(\.text)).joined(separator: " ") }

	public func canResume(at now: Date) -> Bool {
		state == .idle && !beats.isEmpty && (resumeUntil.map { now < $0 } ?? false)
	}

	/// A reply to read (already `SpokenReply.text`). While one is being read it joins the queue.
	public mutating func enqueue(id: String, text: String, at now: Date) -> [Command] {
		let new = SpokenPacing.beats(from: text)
		guard !new.isEmpty else { return state == .idle ? [.finished] : [] }
		if state == .idle {
			beats = new
			replyID = id
			beatsSinceCheckIn = 0
			checkedIn = false
			resumeUntil = nil
			return nextBeat()
		}
		beats += new
		return []
	}

	/// The beat (or check-in) that was being spoken is over.
	public mutating func beatFinished(at now: Date) -> [Command] {
		switch state {
		case .speakingCheckIn:
			state = .pause(until: now.addingTimeInterval(pace.checkInBreak), then: .nextBeat)
			return [.resetTranscript]
		case .speaking:
			let ended = current
			current = nil
			guard !beats.isEmpty else {
				state = .idle
				return [.finished]
			}
			beatsSinceCheckIn += 1
			let checkIn =
				pace.usesCheckIns && !checkedIn
				&& (beatsSinceCheckIn >= Self.beatsPerCheckIn || ended?.endsSection == true)
			state = .pause(until: now.addingTimeInterval(pace.breakLength), then: checkIn ? .checkIn : .nextBeat)
			return [.resetTranscript]
		default:
			return []
		}
	}

	/// Words heard while the mic is open for you (echo and fillers already filtered out).
	public mutating func heard(_ text: String, at now: Date) -> [Command] {
		guard isOnBreak else { return [] }
		heardText = text
		heardAt = now
		switch SpokenReaction.classify(text) {
		case .continue:
			return []
		case .hold:
			if case .held = state {} else { state = .held(since: now) }
			return []
		case .turn:
			if case .held = state { return [] }
			return takeOver(text, at: now)
		}
	}

	public mutating func tick(at now: Date) -> [Command] {
		switch state {
		case .pause(let until, let next):
			if let heardAt, !heardText.isEmpty {
				guard SpokenReaction.classify(heardText) == .continue,
					now.timeIntervalSince(heardAt) >= Self.reactionDelay
				else { return [] }
				clearHeard()
				_ = next
				return [.resetTranscript] + nextBeat()
			}
			guard now >= until else { return [] }
			return next == .checkIn ? checkIn() : nextBeat()
		case .held(let since):
			if let heardAt, !heardText.isEmpty {
				let quiet = now.timeIntervalSince(heardAt)
				if SpokenReaction.classify(heardText) == .continue {
					guard quiet >= Self.reactionDelay else { return [] }
					clearHeard()
					return [.resetTranscript] + nextBeat()
				}
				guard quiet >= Self.heldQuiet else { return [] }
				let rest = SpokenReaction.afterHold(heardText)
				clearHeard()
				if !rest.isEmpty { return takeOver(rest, at: now) }
				return [.resetTranscript]
			}
			if now.timeIntervalSince(since) >= Self.heldLimit {
				resumeUntil = now.addingTimeInterval(Self.resumeWindow)
				state = .idle
				return [.finished]
			}
			return []
		default:
			return []
		}
	}

	/// You talked over a beat, or tapped to stop it: the rest stays available for "go on".
	public mutating func interrupted(at now: Date) {
		guard state != .idle else { return }
		if let current { beats.insert(current, at: 0) }
		current = nil
		resumeUntil = now.addingTimeInterval(Self.resumeWindow)
		state = .idle
		clearHeard()
	}

	/// "Go on" after the reading stopped: pick up at the beat that was cut off.
	public mutating func resume(at now: Date) -> [Command] {
		guard canResume(at: now) else { return [] }
		resumeUntil = nil
		return nextBeat()
	}

	/// What you said is going to the agent, which will answer with something new.
	public mutating func discard() {
		beats = []
		current = nil
		resumeUntil = nil
		state = .idle
		clearHeard()
	}

	// MARK: Private

	private mutating func takeOver(_ text: String, at now: Date) -> [Command] {
		interrupted(at: now)
		return [.takeOver(text)]
	}

	private mutating func nextBeat() -> [Command] {
		guard !beats.isEmpty else {
			state = .idle
			return [.finished]
		}
		let beat = beats.removeFirst()
		current = beat
		counter += 1
		state = .speaking
		return [.speak(id: "\(replyID)#\(counter)", text: beat.text)]
	}

	private mutating func checkIn() -> [Command] {
		checkedIn = true
		beatsSinceCheckIn = 0
		counter += 1
		state = .speakingCheckIn
		return [.speak(id: "\(replyID)#checkin\(counter)", text: SpokenPacing.checkInLine())]
	}

	private mutating func clearHeard() {
		heardText = ""
		heardAt = nil
	}
}
