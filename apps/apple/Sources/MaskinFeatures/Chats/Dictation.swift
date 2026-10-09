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
	@ObservationIgnored private var continuous = false
	@ObservationIgnored private var accumulator = DictationAccumulator()
	@ObservationIgnored private var restartPolicy = DictationRestartPolicy()
	@ObservationIgnored private var taskStartedAt = Date()
	@ObservationIgnored private var heardText = false

	/// Start listening; `onText` gets the running transcript (the whole utterance so far).
	///
	/// `continuous` keeps recording across the recogniser ending on a pause, until `stop()`: the
	/// transcript then accumulates across restarts. Without it (a live conversation, which treats
	/// the end of an utterance as a turn) the session ends when the recogniser does.
	func start(continuous: Bool = false, onText: @escaping @MainActor (String) -> Void) async {
		guard state != .listening else { return }
		self.onText = onText
		self.continuous = continuous
		accumulator = DictationAccumulator()
		restartPolicy = DictationRestartPolicy()
		guard await requestPermissions() else { return }
		guard let recognizer = Self.makeRecognizer() else {
			state = .unavailable("Dictation isn't available for this language right now.")
			return
		}
		// The speaker and the microphone never run together.
		SpeechReader.shared.inputDidBegin()
		do {
			try launch(recognizer)
			state = .listening
		} catch {
			stop()
			state = .unavailable(
				(error as? DictationError)?.message
					?? "Couldn't start the microphone (\(error.localizedDescription)).")
		}
	}

	private static func makeRecognizer() -> SFSpeechRecognizer? {
		guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(),
			recognizer.isAvailable
		else { return nil }
		return recognizer
	}

	/// Builds one engine, request and recognition task. Called again for each restart.
	private func launch(_ recognizer: SFSpeechRecognizer) throws {
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
		taskStartedAt = Date()
		heardText = false
		task = recognizer.recognitionTask(
			with: request,
			resultHandler: Self.makeHandler { [weak self] text, finished, error in
				Task { @MainActor in
					guard let self, self.generation == current else { return }
					if let text {
						self.heardText = self.heardText || !text.isEmpty
						self.accumulator.update(text)
						self.onText?(self.accumulator.text)
					}
					guard finished else { return }
					self.taskEnded(error: error, hadText: text != nil)
				}
			})
	}

	/// The recogniser finished (a pause, its time limit, or an error). Continuous dictation starts
	/// a fresh task, keeping the text so far; anything else ends the session.
	private func taskEnded(error: Error?, hadText: Bool) {
		let message = error.flatMap { Self.message(for: $0) }
		if continuous {
			let decision = restartPolicy.taskEnded(
				ranFor: Date().timeIntervalSince(taskStartedAt), heardText: heardText,
				fatal: message != nil)
			if decision == .restart, let recognizer = Self.makeRecognizer() {
				accumulator.roll()
				teardownAudio()
				do {
					try launch(recognizer)
					return
				} catch {
					stop()
					state = .unavailable("Dictation stopped: \(error.localizedDescription)")
					return
				}
			}
		}
		stop()
		if let message, !hadText { state = .unavailable(message) }
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

	/// Releases the engine, request and task of the current recognition without ending the session.
	private func teardownAudio() {
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
	}

	func stop() {
		teardownAudio()
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
