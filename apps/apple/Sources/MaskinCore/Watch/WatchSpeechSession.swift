import Foundation

/// The audio session as the watch's speech sees it: whether the sound would go to headphones, and
/// how to switch the session on. A seam so the choice below tests without audio hardware.
@MainActor
public protocol SpeechAudioSession {
	var outputIsHeadphones: Bool { get }
	/// Switches the session on for spoken audio. Long-form routes to headphones only and waits for
	/// one to be picked; the standard one plays on the watch speaker.
	func activate(longForm: Bool) async throws
}

public enum WatchSpeech {
	/// Gets the session ready to speak. Long-form audio only with headphones: on a bare watch it
	/// waits for a route that never comes, so nothing was ever spoken. If long-form fails anyway, it
	/// falls back to the standard session. Returns whether a session is on.
	@discardableResult
	public static func prepare(_ session: any SpeechAudioSession) async -> Bool {
		let longForm = session.outputIsHeadphones
		do {
			try await session.activate(longForm: longForm)
			return true
		} catch {
			guard longForm else { return false }
			return (try? await session.activate(longForm: false)) != nil
		}
	}
}

/// Where spoken audio is, as the player shows it. Speech is only "speaking" once the synthesizer
/// reports its first sound: asking it to speak is not the same, and a pause button over silence is
/// a lie. If no sound starts in time, it is `failed`, and the player says so.
public struct SpeechPlayback: Equatable, Sendable {
	public enum Phase: Equatable, Sendable { case idle, starting, speaking, paused, failed }

	/// How long a start may take before it counts as failed.
	public static let startTimeout: Duration = .seconds(5)

	public private(set) var phase: Phase = .idle

	public init() {}

	/// Whether there is audio, or an attempt at it, that Stop would end.
	public var isActive: Bool { phase == .starting || phase == .speaking || phase == .paused }

	public mutating func begin() { phase = .starting }

	/// The synthesizer started making sound.
	public mutating func audioStarted() {
		if phase == .starting { phase = .speaking }
	}

	/// The start window ran out with no sound. Returns whether it counts as a failure.
	@discardableResult
	public mutating func startTimedOut() -> Bool {
		guard phase == .starting else { return false }
		phase = .failed
		return true
	}

	public mutating func pause() {
		if phase == .speaking { phase = .paused }
	}

	public mutating func resume() {
		if phase == .paused { phase = .speaking }
	}

	/// Finished, stopped or cancelled.
	public mutating func finish() { phase = .idle }
}
