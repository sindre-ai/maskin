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
	/// The utterance whose end we are waiting for. Delegate callbacks for any other (a replaced or
	/// stopped one finishing late) are stale and must not touch state.
	@ObservationIgnored private var current: AVSpeechUtterance?
	@ObservationIgnored private var pending: [(id: String, text: String)] = []

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
		begin(text: text, id: id)
	}

	/// Reads `markdown` after whatever is being read now (hands-free: every new reply, in order).
	public func enqueue(markdown: String, id: String) {
		let text = SpeakableText.from(markdown: markdown)
		guard !text.isEmpty, !isInputActive else { return }
		if current == nil { begin(text: text, id: id) } else { pending.append((id, text)) }
	}

	private func begin(text: String, id: String) {
		activateSession()
		let utterance = AVSpeechUtterance(string: text)
		utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier.replacingOccurrences(of: "_", with: "-"))
			?? AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
		adopt(utterance, id: id)
		synthesizer.speak(utterance)
	}

	/// Makes `utterance` the one whose callbacks count. Split from `begin` so the stale-callback
	/// rule is testable without producing sound.
	func adopt(_ utterance: AVSpeechUtterance, id: String) {
		current = utterance
		speakingID = id
	}

	public func stop() {
		pending = []
		// Forget the utterance first: stopping makes the synthesizer call back for it, and that
		// callback must be ignored.
		current = nil
		if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
		finish()
	}

	/// An utterance ended (finished or cancelled). Ignored unless it is the current one.
	func utteranceDidEnd(_ key: ObjectIdentifier) {
		guard let current, ObjectIdentifier(current) == key else { return }
		self.current = nil
		if pending.isEmpty {
			finish()
		} else {
			let next = pending.removeFirst()
			begin(text: next.text, id: next.id)
		}
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
		let key = ObjectIdentifier(utterance)
		Task { @MainActor in self.utteranceDidEnd(key) }
	}

	nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
		let key = ObjectIdentifier(utterance)
		Task { @MainActor in self.utteranceDidEnd(key) }
	}
}
