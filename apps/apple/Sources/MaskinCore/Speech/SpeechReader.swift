import AVFoundation
import Foundation
import Observation

/// Reads messages aloud with `AVSpeechSynthesizer`. One shared instance so only one voice speaks.
///
/// Cooperates with dictation: the microphone and the speaker never run together. Dictation calls
/// `inputDidBegin()`, which silences speech and refuses new speech until `inputDidEnd()`.
@MainActor
@Observable
public final class SpeechReader: NSObject {
	public static let shared = SpeechReader()

	/// The message being read, if any.
	public private(set) var speakingID: String?
	public private(set) var isInputActive = false

	@ObservationIgnored private let synthesizer = AVSpeechSynthesizer()

	override public init() {
		super.init()
		synthesizer.delegate = self
	}

	public func isSpeaking(_ id: String) -> Bool { speakingID == id }

	/// Reads `markdown` aloud, replacing anything already being read. No-op while dictating.
	public func speak(markdown: String, id: String) {
		let text = SpeakableText.from(markdown: markdown)
		guard !text.isEmpty, !isInputActive else { return }
		stop()
		activateSession()
		let utterance = AVSpeechUtterance(string: text)
		utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier.replacingOccurrences(of: "_", with: "-"))
			?? AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
		speakingID = id
		synthesizer.speak(utterance)
	}

	public func stop() {
		if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
		finish()
	}

	/// Dictation (or any other input) is starting: go quiet and stay quiet.
	public func inputDidBegin() {
		isInputActive = true
		stop()
	}

	public func inputDidEnd() { isInputActive = false }

	private func finish() {
		guard speakingID != nil else { return }
		speakingID = nil
		deactivateSession()
	}

	private func activateSession() {
		#if os(iOS)
		let session = AVAudioSession.sharedInstance()
		try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
		try? session.setActive(true)
		#endif
	}

	private func deactivateSession() {
		#if os(iOS)
		// Hand the session back so music resumes, and so Dictation can claim `.record`.
		try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
		#endif
	}
}

extension SpeechReader: AVSpeechSynthesizerDelegate {
	nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
		Task { @MainActor in self.finish() }
	}

	nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
		Task { @MainActor in
			if !self.synthesizer.isSpeaking { self.finish() }
		}
	}
}
