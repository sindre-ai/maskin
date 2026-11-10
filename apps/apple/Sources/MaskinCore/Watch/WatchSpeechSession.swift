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
