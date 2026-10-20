import Foundation

#if os(iOS)
import AVFoundation
import MaskinCore
import MediaPlayer
import Speech

/// What a live call needs from the phone's audio, beyond the recogniser: a `.playAndRecord` session
/// in voice-chat mode (so the microphone and the agent's voice work together, with echo
/// cancellation, over the speaker or Bluetooth), kept active for the whole call so the app keeps
/// running with the screen locked (needs `audio` in `UIBackgroundModes`), plus the events a call has
/// to survive: an interruption (phone call, Siri), a route change (AirPods out), the media server
/// being reset. It also puts the call on the lock screen's Now Playing card with mute / unmute from
/// the card and from headphone buttons.
@MainActor
final class LiveAudioSession {
	struct Handlers {
		var interruptionBegan: @MainActor () -> Void
		var interruptionEnded: @MainActor (_ shouldResume: Bool) -> Void
		var routeChanged: @MainActor (_ name: String) -> Void
		var mediaServicesReset: @MainActor () -> Void
		var setMuted: @MainActor (_ muted: Bool) -> Void
		var toggleMuted: @MainActor () -> Void
	}

	private(set) var routeName = ""
	private var observers: [NSObjectProtocol] = []
	private var commandTargets: [(MPRemoteCommand, Any)] = []
	private var handlers: Handlers?
	private var title = ""

	/// Configure and activate the session and start listening for what can happen to it.
	func activate(title: String, handlers: Handlers) throws {
		self.handlers = handlers
		self.title = title
		try configure()
		routeName = Self.currentRouteName()
		observe()
		registerCommands()
		updateNowPlaying(muted: false, elapsed: 0)
	}

	/// `activate` with the usual wiring: interruptions pause `voice`, headphone buttons mute it.
	func activate(title: String, voice: LiveVoiceController) throws {
		try activate(
			title: title,
			handlers: Handlers(
				interruptionBegan: { voice.interruptionBegan() },
				interruptionEnded: { voice.interruptionEnded(shouldResume: $0) },
				routeChanged: { _ in },
				mediaServicesReset: { voice.audioReset() },
				setMuted: { muted in if voice.isMuted != muted { voice.toggleMute() } },
				toggleMuted: { voice.toggleMute() }))
		// Only once the session is ours: a failed activation has no `deactivate()` to hand it back.
		SpeechReader.shared.usesExternalAudioSession = true
	}

	/// Bring the session back after an interruption or a media-services reset.
	func reactivate() {
		try? configure()
		let name = Self.currentRouteName()
		if name != routeName {
			routeName = name
			handlers?.routeChanged(name)
		}
	}

	func deactivate() {
		SpeechReader.shared.usesExternalAudioSession = false
		let center = NotificationCenter.default
		for observer in observers { center.removeObserver(observer) }
		observers = []
		for (command, target) in commandTargets { command.removeTarget(target) }
		commandTargets = []
		handlers = nil
		MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
		try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
	}

	func updateNowPlaying(muted: Bool, elapsed: TimeInterval) {
		MPNowPlayingInfoCenter.default().nowPlayingInfo = [
			MPMediaItemPropertyTitle: title,
			MPMediaItemPropertyArtist: muted ? "Microphone off" : "Maskin Live",
			MPNowPlayingInfoPropertyIsLiveStream: true,
			MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
			MPNowPlayingInfoPropertyPlaybackRate: muted ? 0.0 : 1.0,
		]
	}

	/// The loudspeaker, or the earpiece. Headphones and Bluetooth routes win over both.
	private var speakerOn = true

	func setSpeaker(_ on: Bool) {
		speakerOn = on
		try? configure()
		try? AVAudioSession.sharedInstance().overrideOutputAudioPort(on ? .speaker : .none)
		routeName = Self.currentRouteName()
		handlers?.routeChanged(routeName)
	}

	private func configure() throws {
		let session = AVAudioSession.sharedInstance()
		try session.setCategory(
			.playAndRecord, mode: .voiceChat,
			options: speakerOn ? [.defaultToSpeaker, .allowBluetoothHFP] : [.allowBluetoothHFP])
		try session.setActive(true)
	}

	nonisolated private static func currentRouteName() -> String {
		AVAudioSession.sharedInstance().currentRoute.outputs.first?.portName ?? ""
	}

	// MARK: Events

	private func observe() {
		let center = NotificationCenter.default
		let session = AVAudioSession.sharedInstance()
		observers = [
			center.addObserver(
				forName: AVAudioSession.interruptionNotification, object: session, queue: .main,
				using: Self.interruptionBlock(
					began: { [weak self] in self?.handlers?.interruptionBegan() },
					ended: { [weak self] resume in
						self?.reactivate()
						self?.handlers?.interruptionEnded(resume)
					})),
			center.addObserver(
				forName: AVAudioSession.routeChangeNotification, object: session, queue: .main,
				using: Self.simpleBlock { [weak self] in
					guard let self else { return }
					let name = Self.currentRouteName()
					guard name != self.routeName else { return }
					self.routeName = name
					self.handlers?.routeChanged(name)
				}),
			center.addObserver(
				forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: .main,
				using: Self.simpleBlock { [weak self] in
					self?.reactivate()
					self?.handlers?.mediaServicesReset()
				}),
		]
	}

	// Notification blocks run on `.main` but are not main-actor-isolated for the compiler; build them
	// outside the class so Swift 6 doesn't trap on an isolation mismatch, and hop explicitly.
	nonisolated private static func interruptionBlock(
		began: @escaping @MainActor () -> Void, ended: @escaping @MainActor (Bool) -> Void
	) -> @Sendable (Notification) -> Void {
		{ note in
			let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
			let options = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
			guard let raw, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
			let resume = AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume)
			Task { @MainActor in
				switch type {
				case .began: began()
				case .ended: ended(resume)
				@unknown default: break
				}
			}
		}
	}

	nonisolated private static func simpleBlock(
		_ action: @escaping @MainActor () -> Void
	) -> @Sendable (Notification) -> Void {
		{ _ in Task { @MainActor in action() } }
	}

	// MARK: Lock-screen and headphone controls

	private func registerCommands() {
		let center = MPRemoteCommandCenter.shared()
		let handlers = handlers
		center.pauseCommand.isEnabled = true
		center.playCommand.isEnabled = true
		center.togglePlayPauseCommand.isEnabled = true
		commandTargets = [
			(center.pauseCommand, center.pauseCommand.addTarget(handler: Self.commandBlock { handlers?.setMuted(true) })),
			(center.playCommand, center.playCommand.addTarget(handler: Self.commandBlock { handlers?.setMuted(false) })),
			(
				center.togglePlayPauseCommand,
				center.togglePlayPauseCommand.addTarget(handler: Self.commandBlock { handlers?.toggleMuted() })
			),
		]
	}

	nonisolated private static func commandBlock(
		_ action: @escaping @MainActor () -> Void
	) -> @Sendable (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus {
		{ _ in
			Task { @MainActor in action() }
			return .success
		}
	}
}

/// The call's recogniser. Unlike dictation it never stops on its own: the engine keeps running and
/// the recognition request is swapped underneath it, so a recogniser that ends on a pause or its
/// time limit, or a transcript the call wants cleared after sending, costs no audio and no words.
/// Words recognised before a swap stay in the transcript until `resetTranscript()`.
///
/// The audio session belongs to `LiveAudioSession`; this class never configures or releases it.
@MainActor
final class LiveListener {
	private(set) var lastProblem: String?
	var isListening: Bool { engine?.isRunning == true }

	private var engine: AVAudioEngine?
	private var task: SFSpeechRecognitionTask?
	private let feed = RequestFeed()
	private var onText: (@MainActor (String, Bool) -> Void)?
	private var recognizer: SFSpeechRecognizer?
	/// Bumped whenever a task is replaced, so a cancelled task's late callback is ignored.
	private var generation = 0
	private var accumulator = DictationAccumulator()
	private var taskStartedAt = Date()
	private var heardText = false
	private var quickFailures = 0

	/// Start the engine and the first recognition task. Returns what went wrong, if anything.
	func start(onText: @escaping @MainActor (String, Bool) -> Void) async -> String? {
		guard !isListening else {
			self.onText = onText
			return nil
		}
		lastProblem = nil
		self.onText = onText
		if let problem = await requestPermissions() { return problem }
		guard let recognizer = Self.makeRecognizer() else {
			return "Speech recognition isn't available for this language right now."
		}
		self.recognizer = recognizer
		teardown()
		do {
			let engine = AVAudioEngine()
			let input = engine.inputNode
			// Echo cancellation, so the agent's own voice isn't taken for you talking over it.
			try? input.setVoiceProcessingEnabled(true)
			let format = input.outputFormat(forBus: 0)
			guard format.sampleRate > 0, format.channelCount > 0 else {
				return "No microphone input is available right now."
			}
			input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.makeTap(feed))
			engine.prepare()
			try engine.start()
			self.engine = engine
			accumulator = DictationAccumulator()
			quickFailures = 0
			launchTask()
			return nil
		} catch {
			teardown()
			return "Couldn't start the microphone (\(error.localizedDescription))."
		}
	}

	/// Forget what has been recognised so far and start the next utterance clean.
	func resetTranscript() {
		accumulator = DictationAccumulator()
		guard isListening else { return }
		launchTask()
	}

	func stop() {
		teardown()
	}

	private func teardown() {
		generation += 1
		if let engine {
			if engine.isRunning { engine.stop() }
			engine.inputNode.removeTap(onBus: 0)
		}
		engine = nil
		feed.swap(nil)?.endAudio()
		task?.cancel()
		task = nil
	}

	/// A new request and task on the running engine. The old one is ended and its callbacks ignored.
	private func launchTask() {
		guard let recognizer else { return }
		let request = SFSpeechAudioBufferRecognitionRequest()
		request.shouldReportPartialResults = true
		request.taskHint = .dictation
		request.addsPunctuation = true
		request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
		generation += 1
		let current = generation
		feed.swap(request)?.endAudio()
		task?.cancel()
		taskStartedAt = Date()
		heardText = false
		task = recognizer.recognitionTask(
			with: request,
			resultHandler: Self.makeHandler { [weak self] text, isFinal, error in
				Task { @MainActor in
					guard let self, self.generation == current else { return }
					if let text, !text.isEmpty {
						self.heardText = true
						self.accumulator.update(text)
						self.onText?(self.accumulator.text, isFinal)
					}
					guard isFinal || error != nil else { return }
					self.taskEnded(error: error)
				}
			})
	}

	/// The recogniser ended (a pause, its time limit, an error): carry on with a fresh task, keeping
	/// the words so far, unless it keeps failing at once.
	private func taskEnded(error: Error?) {
		if let message = error.flatMap({ Self.message(for: $0) }), !heardText {
			lastProblem = message
			teardown()
			return
		}
		if heardText || Date().timeIntervalSince(taskStartedAt) >= 1 {
			quickFailures = 0
		} else {
			quickFailures += 1
			if quickFailures >= 3 {
				lastProblem = "Speech recognition keeps stopping."
				teardown()
				return
			}
		}
		accumulator.roll()
		launchTask()
	}

	// The tap and the recogniser's callback fire on background queues; closures written inside this
	// @MainActor class would be inferred main-actor-isolated, which Swift 6 traps on off-main.
	nonisolated private static func makeTap(_ feed: RequestFeed) -> AVAudioNodeTapBlock {
		{ buffer, _ in feed.append(buffer) }
	}

	nonisolated private static func makeHandler(
		_ deliver: @escaping @Sendable (String?, Bool, Error?) -> Void
	) -> @Sendable (SFSpeechRecognitionResult?, Error?) -> Void {
		{ result, error in
			deliver(result?.bestTranscription.formattedString, result?.isFinal == true, error)
		}
	}

	private static func makeRecognizer() -> SFSpeechRecognizer? {
		guard let recognizer = SFSpeechRecognizer(locale: Locale.current) ?? SFSpeechRecognizer(),
			recognizer.isAvailable
		else { return nil }
		return recognizer
	}

	/// What to tell the user for a recogniser error; nil for the ones that aren't failures
	/// (cancelled by us, or nothing was said).
	private static func message(for error: Error) -> String? {
		let ns = error as NSError
		if ns.domain == "kAFAssistantErrorDomain", [216, 301, 1110].contains(ns.code) { return nil }
		if ns.domain == "kLSRErrorDomain", ns.code == 301 { return nil }
		return "Speech recognition stopped: \(ns.localizedDescription)"
	}

	nonisolated private static func speechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
		await withCheckedContinuation { continuation in
			SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
		}
	}

	private func requestPermissions() async -> String? {
		guard await Self.speechAuthorization() == .authorized else {
			return "Allow Speech Recognition in Settings to talk live."
		}
		guard await AVAudioApplication.requestRecordPermission() else {
			return "Allow Microphone access in Settings to talk live."
		}
		return nil
	}

	/// The tap runs on the audio thread and the request is swapped from the main thread.
	final class RequestFeed: @unchecked Sendable {
		private let lock = NSLock()
		private var request: SFSpeechAudioBufferRecognitionRequest?

		func append(_ buffer: AVAudioPCMBuffer) {
			lock.lock()
			let current = request
			lock.unlock()
			current?.append(buffer)
		}

		/// Installs `new` and returns what it replaced.
		func swap(_ new: SFSpeechAudioBufferRecognitionRequest?) -> SFSpeechAudioBufferRecognitionRequest? {
			lock.lock()
			defer { lock.unlock() }
			let old = request
			request = new
			return old
		}
	}
}
#endif
