import Foundation

/// The microphone as the listening store sees it: it opens, hands back one WAV recording (16 kHz
/// mono) for each phrase the speaker closes with a pause, and stops. A seam so the listening logic
/// tests without audio hardware.
@MainActor
public protocol PhraseMicrophone: AnyObject {
	/// Asks for microphone access (the system prompt the first time). False when it is refused.
	func requestAccess() async -> Bool
	/// Opens the microphone. Throws when there is no input or it cannot start. The stream ends after
	/// `stop()`, with the last unfinished phrase delivered first.
	func start() throws -> AsyncStream<Data>
	/// Closes the microphone.
	func stop()
}

extension PhraseMicrophone {
	public func requestAccess() async -> Bool { true }
}

#if canImport(AVFoundation) && (os(iOS) || os(watchOS) || os(macOS))
	import AVFoundation

	/// The real microphone: an `AVAudioEngine` input tap, cut into phrases by `PhraseSegmenter` (the
	/// same rules as the iPhone's dictation). The watch uses it for live listening; the audio session
	/// category is only set where the platform has one.
	@MainActor
	public final class EnginePhraseMicrophone: PhraseMicrophone {
		private let engine = AVAudioEngine()
		private var capture: PhraseCapture?

		public init() {}

		/// The engine only gets samples once access is granted; asking first means the first tap on
		/// the mic shows the prompt instead of opening a microphone that hears nothing.
		public func requestAccess() async -> Bool {
			await AVAudioApplication.requestRecordPermission()
		}

		public func start() throws -> AsyncStream<Data> {
			#if os(iOS) || os(watchOS)
				let session = AVAudioSession.sharedInstance()
				try session.setCategory(.record, mode: .measurement, options: .duckOthers)
				try session.setActive(true, options: .notifyOthersOnDeactivation)
			#endif
			let input = engine.inputNode
			let format = input.outputFormat(forBus: 0)
			guard format.sampleRate > 0, format.channelCount > 0 else { throw MicrophoneError.noInput }
			let (phrases, continuation) = AsyncStream.makeStream(of: Data.self)
			let capture = try PhraseCapture(inputFormat: format, phrases: continuation)
			self.capture = capture
			input.installTap(onBus: 0, bufferSize: 1024, format: format, block: Self.makeTap(capture))
			engine.prepare()
			try engine.start()
			return phrases
		}

		public func stop() {
			if engine.isRunning { engine.stop() }
			engine.inputNode.removeTap(onBus: 0)
			capture?.finish()
			capture = nil
			#if os(iOS) || os(watchOS)
				try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
			#endif
		}

		public enum MicrophoneError: Error { case noInput }

		// The tap fires on an audio thread; built here, where nothing is main-actor-isolated (Swift 6
		// traps on a main-actor closure that runs elsewhere).
		nonisolated private static func makeTap(_ capture: PhraseCapture) -> AVAudioNodeTapBlock {
			{ buffer, _ in capture.append(buffer) }
		}
	}

	/// Turns microphone buffers into closed phrases. Lives on the audio thread: converts to 16 kHz
	/// mono, runs the pause detector on the level, and yields one WAV per finished phrase.
	private final class PhraseCapture: @unchecked Sendable {
		private let lock = NSLock()
		private let converter: AVAudioConverter
		private let outputFormat: AVAudioFormat
		private let phrases: AsyncStream<Data>.Continuation
		private var segmenter = PhraseSegmenter()
		private var samples: [Float] = []
		/// Milliseconds of audio seen, so pauses are measured in recorded time, not wall time.
		private var clockMs = 0.0
		private var finished = false

		init(inputFormat: AVAudioFormat, phrases: AsyncStream<Data>.Continuation) throws {
			guard
				let output = AVAudioFormat(
					commonFormat: .pcmFormatFloat32, sampleRate: Double(WAVEncoding.sampleRate), channels: 1,
					interleaved: false),
				let converter = AVAudioConverter(from: inputFormat, to: output)
			else { throw EnginePhraseMicrophone.MicrophoneError.noInput }
			self.outputFormat = output
			self.converter = converter
			self.phrases = phrases
		}

		func append(_ buffer: AVAudioPCMBuffer) {
			let converted = convert(buffer)
			guard !converted.isEmpty else { return }
			var phrase: [Float]?
			lock.lock()
			if !finished {
				samples.append(contentsOf: converted)
				clockMs += Double(converted.count) * 1000 / Double(WAVEncoding.sampleRate)
				switch segmenter.push(rms: Self.rms(converted), atMs: clockMs) {
				case .cut:
					phrase = samples
					samples = []
					segmenter.reset(atMs: clockMs)
				case .discard:
					samples = []
					segmenter.reset(atMs: clockMs)
				case nil:
					break
				}
			}
			lock.unlock()
			if let phrase { phrases.yield(Self.wav(phrase)) }
		}

		/// The microphone is closed: sends what was said since the last pause, then ends the stream.
		func finish() {
			lock.lock()
			let tail = !finished && segmenter.hasVoice ? samples : []
			finished = true
			samples = []
			lock.unlock()
			if !tail.isEmpty { phrases.yield(Self.wav(tail)) }
			phrases.finish()
		}

		private static func wav(_ samples: [Float]) -> Data {
			WAVEncoding.wav(pcm16: WAVEncoding.pcm16(from: samples))
		}

		private static func rms(_ samples: [Float]) -> Double {
			var sum = 0.0
			for sample in samples { sum += Double(sample) * Double(sample) }
			return (sum / Double(samples.count)).squareRoot()
		}

		private func convert(_ buffer: AVAudioPCMBuffer) -> [Float] {
			let ratio = outputFormat.sampleRate / buffer.format.sampleRate
			let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
			guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return [] }
			let supply = Supply(buffer)
			var error: NSError?
			_ = converter.convert(to: output, error: &error) { count, status in supply.next(count, status) }
			guard error == nil, let channel = output.floatChannelData else { return [] }
			return Array(UnsafeBufferPointer(start: channel[0], count: Int(output.frameLength)))
		}

		/// Hands the converter its one buffer, then says there is no more for now.
		private final class Supply: @unchecked Sendable {
			private var buffer: AVAudioPCMBuffer?
			init(_ buffer: AVAudioPCMBuffer) { self.buffer = buffer }
			func next(_ count: AVAudioPacketCount, _ status: UnsafeMutablePointer<AVAudioConverterInputStatus>)
				-> AVAudioBuffer?
			{
				guard let buffer else {
					status.pointee = .noDataNow
					return nil
				}
				self.buffer = nil
				status.pointee = .haveData
				return buffer
			}
		}
	}
#endif
