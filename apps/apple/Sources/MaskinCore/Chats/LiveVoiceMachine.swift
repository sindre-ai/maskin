import Foundation

/// The turn-taking of a live voice conversation with an agent, with no audio in it: it is told what
/// was heard, what time it is, when a reply arrives and when speech ends, and answers with what to do.
///
///     listening ──(you pause)──▶ thinking ──(reply arrives)──▶ speaking ──(speech ends)──▶ listening
///
/// The microphone and the speaker never run together: listening stops before a message is sent and
/// only starts again once the reply has been spoken (or you interrupt it).
public struct LiveVoiceMachine: Sendable, Equatable {
	public enum Command: Equatable, Sendable {
		case startListening
		case stopListening
		/// Send what was said as a message.
		case send(String)
		/// Read this message aloud (queued after any already being read).
		case speak(messageID: String)
		case stopSpeaking
	}

	public private(set) var phase: LiveVoicePhase = .listening
	/// What has been heard since the last message was sent.
	public private(set) var transcript = ""
	public private(set) var isMuted = false

	/// How long you must stop talking before what you said is sent.
	public var silenceWindow: TimeInterval = 1.5
	/// A cough or "um" is not a message: fewer words than this are dropped.
	public var minimumWords = 2
	/// How long to wait for a reply before listening again.
	public var replyTimeout: TimeInterval = 90
	/// How long a too-short fragment is kept before it is forgotten.
	public var fragmentLifetime: TimeInterval = 4

	private var lastHeardAt: Date?
	private var thinkingSince: Date?

	public init() {}

	/// Start (or restart) the conversation, listening.
	public mutating func begin() -> [Command] { resumeListening() }

	/// The recogniser's running transcript. Only a change counts as speech: the pause is measured
	/// from the last time the words changed.
	public mutating func heard(_ text: String, at now: Date) -> [Command] {
		guard phase == .listening, !isMuted else { return [] }
		if text != transcript {
			transcript = text
			lastHeardAt = now
		}
		return []
	}

	public mutating func tick(at now: Date) -> [Command] {
		switch phase {
		case .listening:
			guard !isMuted, let heardAt = lastHeardAt else { return [] }
			let quiet = now.timeIntervalSince(heardAt)
			let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
			let words = text.split(whereSeparator: \.isWhitespace).count
			guard words >= minimumWords else {
				if quiet >= fragmentLifetime {
					transcript = ""
					lastHeardAt = nil
				}
				return []
			}
			guard quiet >= silenceWindow else { return [] }
			transcript = ""
			lastHeardAt = nil
			phase = .thinking
			thinkingSince = now
			return [.stopListening, .send(text)]
		case .thinking:
			if let since = thinkingSince, now.timeIntervalSince(since) >= replyTimeout { return resumeListening() }
			return []
		case .speaking:
			return []
		}
	}

	/// An agent message arrived. While waiting for one it starts being read; while one is being read
	/// it joins the queue; at any other time (a reply to something typed) it is left alone.
	public mutating func replyArrived(messageID: String) -> [Command] {
		switch phase {
		case .thinking:
			phase = .speaking
			return [.speak(messageID: messageID)]
		case .speaking:
			return [.speak(messageID: messageID)]
		case .listening:
			return []
		}
	}

	/// The agent's turn ended in an error: nothing to read, so listen again.
	public mutating func replyFailed() -> [Command] {
		guard phase == .thinking else { return [] }
		return resumeListening()
	}

	/// The reader finished everything queued.
	public mutating func speechFinished() -> [Command] {
		guard phase == .speaking else { return [] }
		return resumeListening()
	}

	/// You started talking over the agent, or tapped to stop it.
	public mutating func interrupt() -> [Command] {
		guard phase == .speaking || phase == .thinking else { return [] }
		return [.stopSpeaking] + resumeListening()
	}

	public mutating func setMuted(_ muted: Bool) -> [Command] {
		guard muted != isMuted else { return [] }
		isMuted = muted
		guard phase == .listening else { return [] }
		if muted {
			transcript = ""
			lastHeardAt = nil
			return [.stopListening]
		}
		return [.startListening]
	}

	public mutating func end() -> [Command] { [.stopListening, .stopSpeaking] }

	private mutating func resumeListening() -> [Command] {
		phase = .listening
		transcript = ""
		lastHeardAt = nil
		thinkingSince = nil
		return isMuted ? [] : [.startListening]
	}
}
