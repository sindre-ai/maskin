import Foundation
import MaskinCore
import Observation

#if os(iOS)
import AVFoundation
import Speech

/// Live dictation into the composer. Prefers on-device recognition (no audio leaves the phone);
/// when the device or language can't, the system's recogniser is used instead.
///
/// Needs `NSSpeechRecognitionUsageDescription` and `NSMicrophoneUsageDescription` in Info.plist.
@MainActor
@Observable
final class Dictation {
	enum State: Equatable {
		case idle
		case listening
		/// Permission refused or the recogniser is unavailable; the string says what to do.
		case unavailable(String)
	}

	private(set) var state: State = .idle
	var isListening: Bool { state == .listening }

	/// Built per session: an engine kept across sessions holds a stale input format once the audio
	/// session has been deactivated or the route changed, and the tap then fails or delivers nothing.
	@ObservationIgnored private var engine: AVAudioEngine?
	@ObservationIgnored private var task: SFSpeechRecognitionTask?
	@ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
	@ObservationIgnored private var onText: (@MainActor (String) -> Void)?
	/// Bumped on every start and stop, so a cancelled task's late callback can't end a newer session.
	@ObservationIgnored private var generation = 0

	/// Start listening; `onText` gets the running transcript (the whole utterance so far).
	func start(onText: @escaping @MainActor (String) -> Void) async {
		guard state != .listening else { return }
		self.onText = onText
		guard await requestPermissions() else { return }
		guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(),
			recognizer.isAvailable
		else {
			state = .unavailable("Dictation isn't available for this language right now.")
			return
		}
		// The speaker and the microphone never run together.
		SpeechReader.shared.inputDidBegin()
		do {
			let session = AVAudioSession.sharedInstance()
			try session.setCategory(.record, mode: .measurement, options: .duckOthers)
			try session.setActive(true, options: .notifyOthersOnDeactivation)
			let request = SFSpeechAudioBufferRecognitionRequest()
			request.shouldReportPartialResults = true
			request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
			self.request = request
			generation += 1
			let current = generation
			let engine = AVAudioEngine()
			self.engine = engine
			let input = engine.inputNode
			let format = input.outputFormat(forBus: 0)
			guard format.sampleRate > 0, format.channelCount > 0 else { throw DictationError.noInput }
			input.installTap(
				onBus: 0, bufferSize: 1024, format: format,
				block: Self.makeTap(AudioFeed(request: request)))
			engine.prepare()
			try engine.start()
			task = recognizer.recognitionTask(
				with: request,
				resultHandler: Self.makeHandler { [weak self] text, finished, error in
					Task { @MainActor in
						guard let self, self.generation == current else { return }
						if let text { self.onText?(text) }
						guard finished else { return }
						self.stop()
						if let error, text == nil, let message = Self.message(for: error) {
							self.state = .unavailable(message)
						}
					}
				})
			state = .listening
		} catch {
			stop()
			state = .unavailable(
				(error as? DictationError)?.message
					?? "Couldn't start the microphone (\(error.localizedDescription)).")
		}
	}

	// The audio tap and the recogniser's callback fire on background queues. Closures written inside
	// this @MainActor class would be inferred main-actor-isolated, and Swift 6 traps when they run
	// anywhere else — so they are built here, where nothing is isolated.
	nonisolated private static func makeTap(_ feed: AudioFeed) -> AVAudioNodeTapBlock {
		{ buffer, _ in feed.append(buffer) }
	}

	nonisolated private static func makeHandler(
		_ deliver: @escaping @Sendable (String?, Bool, Error?) -> Void
	) -> @Sendable (SFSpeechRecognitionResult?, Error?) -> Void {
		{ result, error in
			deliver(
				result?.bestTranscription.formattedString, result?.isFinal == true || error != nil, error)
		}
	}

	private enum DictationError: Error {
		case noInput
		var message: String { "No microphone input is available right now." }
	}

	/// What to tell the user for a recogniser error; nil for the ones that aren't failures
	/// (cancelled by us, or nothing was said).
	private static func message(for error: Error) -> String? {
		let ns = error as NSError
		if ns.domain == "kAFAssistantErrorDomain", [216, 301, 1110].contains(ns.code) { return nil }
		if ns.domain == "kLSRErrorDomain", ns.code == 301 { return nil }
		return "Dictation stopped: \(ns.localizedDescription)"
	}

	/// TCC calls the completion on a background queue. Written here, in a nonisolated context, the
	/// closure isn't inferred main-actor-isolated (which Swift 6 traps on when it runs off-main).
	nonisolated private static func speechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
		await withCheckedContinuation { continuation in
			SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
		}
	}

	func stop() {
		generation += 1
		if let engine {
			if engine.isRunning { engine.stop() }
			engine.inputNode.removeTap(onBus: 0)
		}
		engine = nil
		request?.endAudio()
		task?.cancel()
		task = nil
		request = nil
		try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
		if state == .listening { state = .idle }
		SpeechReader.shared.inputDidEnd()
	}

	func clearError() {
		if case .unavailable = state { state = .idle }
	}

	private func requestPermissions() async -> Bool {
		let speech = await Self.speechAuthorization()
		guard speech == .authorized else {
			state = .unavailable("Allow Speech Recognition in Settings to dictate.")
			return false
		}
		let mic = await AVAudioApplication.requestRecordPermission()
		guard mic else {
			state = .unavailable("Allow Microphone access in Settings to dictate.")
			return false
		}
		return true
	}

	/// The tap runs on the audio thread; the request is only ever appended to.
	private final class AudioFeed: @unchecked Sendable {
		let request: SFSpeechAudioBufferRecognitionRequest
		init(request: SFSpeechAudioBufferRecognitionRequest) { self.request = request }
		func append(_ buffer: AVAudioPCMBuffer) { request.append(buffer) }
	}
}
#endif
