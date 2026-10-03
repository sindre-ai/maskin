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

	@ObservationIgnored private let engine = AVAudioEngine()
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
			let input = engine.inputNode
			input.removeTap(onBus: 0)
			input.installTap(
				onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0),
				block: Self.makeTap(AudioFeed(request: request)))
			engine.prepare()
			try engine.start()
			task = recognizer.recognitionTask(
				with: request,
				resultHandler: Self.makeHandler { [weak self] text, finished in
					Task { @MainActor in
						guard let self, self.generation == current else { return }
						if let text { self.onText?(text) }
						if finished { self.stop() }
					}
				})
			state = .listening
		} catch {
			stop()
			state = .unavailable("Couldn't start the microphone.")
		}
	}

	// The audio tap and the recogniser's callback fire on background queues. Closures written inside
	// this @MainActor class would be inferred main-actor-isolated, and Swift 6 traps when they run
	// anywhere else — so they are built here, where nothing is isolated.
	nonisolated private static func makeTap(_ feed: AudioFeed) -> AVAudioNodeTapBlock {
		{ buffer, _ in feed.append(buffer) }
	}

	nonisolated private static func makeHandler(
		_ deliver: @escaping @Sendable (String?, Bool) -> Void
	) -> @Sendable (SFSpeechRecognitionResult?, Error?) -> Void {
		{ result, error in
			deliver(result?.bestTranscription.formattedString, result?.isFinal == true || error != nil)
		}
	}

	func stop() {
		generation += 1
		if engine.isRunning {
			engine.stop()
			engine.inputNode.removeTap(onBus: 0)
		}
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
		let speech = await withCheckedContinuation { (continuation: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
			SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
		}
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
