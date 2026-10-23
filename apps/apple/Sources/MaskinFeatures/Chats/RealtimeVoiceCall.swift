import Foundation
import MaskinCore
import Observation

enum RealtimeConnectionState: Sendable, Equatable {
	case connected, disconnected, failed
}

enum RealtimeTransportError: Error, Equatable {
	case microphoneDenied
	case setup(String)
}

/// The WebRTC half of a Realtime call, as a seam: the call logic below is tested with a fake, and
/// `WebRTCTransport` is the real one.
@MainActor
protocol RealtimeTransport: AnyObject {
	/// Opens the microphone and the connection and returns the SDP offer to post to the server.
	/// `onEvent` gets every data-channel message; `onConnection` every change in the link.
	func makeOffer(
		onEvent: @escaping @MainActor @Sendable (Data) -> Void,
		onConnection: @escaping @MainActor @Sendable (RealtimeConnectionState) -> Void
	) async throws -> String
	func accept(answer: String) async throws
	func send(_ json: String)
	func setMicEnabled(_ enabled: Bool)
	func restartIce()
	func close()
}

/// A live voice call with one agent over the OpenAI Realtime API, through the Maskin server: the
/// server holds the vendor key and the tools, this app only sends microphone audio and plays the
/// agent's. The same flow as the web app's `use-voice-call.ts`.
///
/// When the server says voice calls aren't available to this person (the `voice-mode-v1` flag is
/// off) or WebRTC isn't built in, it calls `onFallBack` once and does nothing else, so the caller can
/// use the dictation call instead.
@MainActor
@Observable
final class RealtimeVoiceCall: LiveVoiceDriving {
	/// How long a dropped connection gets to come back before the call is ended.
	static let reconnectWindow: Duration = .seconds(15)

	private(set) var machine = RealtimeCallMachine()
	private(set) var failure: String?
	private(set) var isMuted = false

	var phase: LiveVoicePhase { machine.phase }
	var transcript: String { machine.heardText }
	var capturesOwnTranscript: Bool { true }
	var agentWords: String? { machine.lastAgentWords }

	@ObservationIgnored var onFallBack: (@MainActor () -> Void)?
	/// Called with each finished line of the call, yours or the agent's, as it is transcribed, so
	/// the thread can keep it (the call itself posts nothing to the chat).
	@ObservationIgnored var onLine: (@MainActor (_ isYou: Bool, _ text: String) -> Void)?

	@ObservationIgnored private let agentID: String
	@ObservationIgnored private let agentName: String
	@ObservationIgnored private let calls: any VoiceCalling
	@ObservationIgnored private let makeTransport: @MainActor () -> (any RealtimeTransport)?
	@ObservationIgnored private let now: @MainActor () -> Date
	@ObservationIgnored private let reconnectWindow: Duration

	@ObservationIgnored private var transport: (any RealtimeTransport)?
	@ObservationIgnored private var voiceSessionID: String?
	@ObservationIgnored private var isActive = false
	@ObservationIgnored private var startTask: Task<Void, Never>?
	@ObservationIgnored private var reconnectTask: Task<Void, Never>?
	@ObservationIgnored private var restartedIce = false

	init(
		agentID: String, agentName: String, calls: any VoiceCalling,
		makeTransport: @escaping @MainActor () -> (any RealtimeTransport)?,
		now: @escaping @MainActor () -> Date = { Date() },
		reconnectWindow: Duration = RealtimeVoiceCall.reconnectWindow
	) {
		self.agentID = agentID
		self.agentName = agentName
		self.calls = calls
		self.makeTransport = makeTransport
		self.now = now
		self.reconnectWindow = reconnectWindow
	}

	// MARK: LiveVoiceDriving

	/// Start the call. Messages already in the thread don't matter: the conversation is by voice.
	func begin(existing: [ChatMessage]) {
		guard !isActive else { return }
		isActive = true
		failure = nil
		startTask = Task { [weak self] in await self?.connect() }
	}

	func end() {
		guard isActive else { return }
		isActive = false
		startTask?.cancel()
		release(reason: .userHangup)
	}

	func toggleMute() {
		isMuted.toggle()
		transport?.setMicEnabled(!isMuted)
	}

	/// Stop the agent talking and listen at once.
	func interrupt() { run(machine.interrupted(at: now())) }

	/// The conversation is by voice; chat messages are not part of it.
	func messagesChanged(_ messages: [ChatMessage]) {}

	// MARK: Connecting

	private func connect() async {
		guard let transport = makeTransport() else {
			fallBack()
			return
		}
		self.transport = transport
		do {
			let id = try await calls.create(agentActorID: agentID)
			voiceSessionID = id
			// Ended while the slot was being reserved: give it straight back.
			guard isActive else {
				transport.close()
				release(reason: .userHangup)
				return
			}
			let sdp = try await transport.makeOffer(
				onEvent: { [weak self] data in self?.received(data) },
				onConnection: { [weak self] state in self?.connectionChanged(state) })
			// Ended while the offer was being made: `release` has already dropped its reference to
			// this transport, so close the local one (this frees a microphone opened late).
			guard isActive else {
				transport.close()
				release(reason: .userHangup)
				return
			}
			let answer = try await calls.offer(voiceSessionID: id, sdp: sdp)
			machine.toolsAvailable = answer.toolsAvailable
			try await transport.accept(answer: answer.sdp)
			transport.setMicEnabled(!isMuted)
		} catch let error as VoiceCallFailure {
			if error.shouldFallBack, voiceSessionID == nil {
				fallBack()
			} else {
				stop(because: error.message)
			}
		} catch RealtimeTransportError.microphoneDenied {
			stop(because: "Allow Microphone access in Settings to talk with \(agentName).")
		} catch is CancellationError {
			transport.close()
			return
		} catch {
			stop(because: "Couldn't connect the call. Try again.")
		}
	}

	/// Nothing was reserved (or it has been released): hand over to the dictation call.
	private func fallBack() {
		guard isActive else { return }
		isActive = false
		release(reason: .networkError)
		onFallBack?()
	}

	/// The call can't continue: say why and let go of everything.
	private func stop(because message: String) {
		guard isActive else { return }
		failure = message
		isActive = false
		release(reason: .networkError)
	}

	// MARK: Events

	private func received(_ data: Data) {
		guard isActive, let event = RealtimeEvent.parse(data) else { return }
		let seen = machine.lines.count
		run(machine.handle(event, at: now()))
		for line in machine.lines.dropFirst(seen) where line.kind != .tool {
			onLine?(line.kind == .user, line.text)
		}
	}

	private func run(_ commands: [RealtimeCallMachine.Command]) {
		for command in commands {
			switch command {
			case .sendEvent(let json): transport?.send(json)
			}
		}
	}

	private func connectionChanged(_ state: RealtimeConnectionState) {
		guard isActive else { return }
		switch state {
		case .connected:
			reconnectTask?.cancel()
			reconnectTask = nil
			restartedIce = false
		case .disconnected, .failed:
			// One ICE restart per drop, then the call gets a window to recover before it is ended.
			if state == .failed, !restartedIce {
				restartedIce = true
				transport?.restartIce()
			}
			guard reconnectTask == nil else { return }
			let window = reconnectWindow
			reconnectTask = Task { [weak self] in
				try? await Task.sleep(for: window)
				guard !Task.isCancelled else { return }
				self?.stop(because: "The connection dropped and could not be restored.")
			}
		}
	}

	// MARK: Ending

	/// Tell the server the call is over (so the caller's live-call slot is free and the transcript
	/// is saved) and let go of the microphone and the connection. Safe to call twice.
	private func release(reason: VoiceCallEndReason) {
		reconnectTask?.cancel()
		reconnectTask = nil
		let date = now()
		let id = voiceSessionID
		voiceSessionID = nil
		let input = machine.inputSeconds(at: date)
		let output = machine.outputSeconds(at: date)
		machine.connectionEnded(at: date)
		transport?.close()
		transport = nil
		guard let id else { return }
		let calls = calls
		Task {
			// A hangup that fails must not trap anyone: the server's idle sweeper closes the call anyway.
			_ = try? await calls.hangup(
				voiceSessionID: id, reason: reason, inputAudioSeconds: input, outputAudioSeconds: output)
		}
	}
}

extension RealtimeVoiceCall {
	/// The real WebRTC connection, where it is built in (iOS with the WebRTC package).
	static func deviceTransport() -> (any RealtimeTransport)? {
		#if os(iOS) && canImport(WebRTC)
		return WebRTCTransport()
		#else
		return nil
		#endif
	}
}
