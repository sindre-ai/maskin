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
/// When the server says it can't take this call (the agent isn't in the workspace) or WebRTC isn't
/// built in, it calls `onFallBack` once and does nothing else, so the caller can use the dictation
/// call instead.
@MainActor
@Observable
final class RealtimeVoiceCall: LiveVoiceDriving {
	/// How long a dropped connection gets to come back by itself before a new call is started.
	static let reconnectWindow: Duration = .seconds(30)
	/// How long to wait before each try at a new call once the old one is lost, which also bounds how
	/// many tries there are. A cell handover or a tunnel is usually over within this.
	static let recoveryDelays: [Duration] = [.seconds(1), .seconds(3), .seconds(6), .seconds(10), .seconds(15)]

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
	@ObservationIgnored private let conversationID: String?
	@ObservationIgnored private let calls: any VoiceCalling
	@ObservationIgnored private let makeTransport: @MainActor () -> (any RealtimeTransport)?
	@ObservationIgnored private let now: @MainActor () -> Date
	@ObservationIgnored private let reconnectWindow: Duration
	@ObservationIgnored private let recoveryDelays: [Duration]

	@ObservationIgnored private var transport: (any RealtimeTransport)?
	@ObservationIgnored private var voiceSessionID: String?
	@ObservationIgnored private var isActive = false
	@ObservationIgnored private var startTask: Task<Void, Never>?
	@ObservationIgnored private var reconnectTask: Task<Void, Never>?
	@ObservationIgnored private var restartedIce = false
	/// A call that was lost and whose hangup may not have reached the server, which would keep the
	/// person's one live-call slot taken and make the next call a 409.
	@ObservationIgnored private var lostSession: (id: String, input: Int, output: Int)?
	/// Messages already in the thread when the call began, or already looked at.
	@ObservationIgnored private var knownMessageIDs: Set<String> = []
	/// The data channel is open once the edge's first event has arrived.
	@ObservationIgnored private var channelOpen = false
	/// Typed lines waiting for the data channel to open.
	@ObservationIgnored private var queuedChatItems: [String] = []

	/// `conversationID` is the chat the call is started from; the server gives the agent its recent
	/// messages. Nil when the call isn't tied to a chat.
	init(
		agentID: String, agentName: String, conversationID: String? = nil, calls: any VoiceCalling,
		makeTransport: @escaping @MainActor () -> (any RealtimeTransport)?,
		now: @escaping @MainActor () -> Date = { Date() },
		reconnectWindow: Duration = RealtimeVoiceCall.reconnectWindow,
		recoveryDelays: [Duration] = RealtimeVoiceCall.recoveryDelays
	) {
		self.agentID = agentID
		self.agentName = agentName
		self.conversationID = conversationID
		self.calls = calls
		self.makeTransport = makeTransport
		self.now = now
		self.reconnectWindow = reconnectWindow
		self.recoveryDelays = recoveryDelays
	}

	// MARK: LiveVoiceDriving

	/// Start the call. The thread's earlier messages aren't sent from here: the server reads them
	/// from `conversationID` and hands them to the agent.
	func begin(existing: [ChatMessage]) {
		guard !isActive else { return }
		isActive = true
		knownMessageIDs = Set(existing.map(\.id))
		channelOpen = false
		queuedChatItems = []
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

	/// The conversation is by voice, but a line typed in the chat during the call (yours, or another
	/// person's in a group chat) is handed to the agent as a conversation item. The server saves the
	/// call's own spoken lines into the thread as the call runs (marked as voice), so those and agent
	/// messages are skipped: nothing the call said comes back to it.
	func messagesChanged(_ messages: [ChatMessage]) {
		guard isActive else { return }
		for message in messages where !knownMessageIDs.contains(message.id) {
			// A line that hasn't reached the thread yet is looked at again when it has.
			if message.isFailed { continue }
			if case .waiting = message.status { continue }
			knownMessageIDs.insert(message.id)
			guard message.author != .agent, !message.isVoiceTranscript, message.showsInTimeline, !message.isSystem,
				!message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
			else { continue }
			let item = RealtimeCallMachine.chatMessageItem(from: message.actorName, text: message.content)
			if channelOpen { transport?.send(item) } else { queuedChatItems.append(item) }
		}
	}

	/// Tell the agent something the person did mid-call (a tap in the dock) and have it carry on.
	/// While the agent is speaking only the note is added: a second response then would be refused
	/// as "already active", and the agent sees the note on its next turn. Waits for the data channel
	/// like a typed line does.
	func tell(_ text: String) {
		guard isActive else { return }
		var events = [RealtimeCallMachine.userNoteItem(text)]
		if machine.phase != .speaking { events.append(RealtimeCallMachine.responseRequest) }
		if channelOpen {
			for event in events { transport?.send(event) }
		} else {
			queuedChatItems += events
		}
	}

	// MARK: Connecting

	/// Sets up one call. While `recovering`, a failure that may be the network still being down returns
	/// false so the caller tries again; otherwise a failure ends the call. True means it is over or up.
	@discardableResult
	private func connect(recovering: Bool = false) async -> Bool {
		guard let transport = makeTransport() else {
			fallBack()
			return true
		}
		self.transport = transport
		do {
			let id = try await calls.create(agentActorID: agentID, conversationID: conversationID)
			voiceSessionID = id
			// Ended while the slot was being reserved: give it straight back.
			guard isActive else {
				transport.close()
				release(reason: .userHangup)
				return true
			}
			let sdp = try await transport.makeOffer(
				onEvent: { [weak self] data in self?.received(data) },
				onConnection: { [weak self] state in self?.connectionChanged(state) })
			// Ended while the offer was being made: `release` has already dropped its reference to
			// this transport, so close the local one (this frees a microphone opened late).
			guard isActive else {
				transport.close()
				release(reason: .userHangup)
				return true
			}
			let answer = try await calls.offer(voiceSessionID: id, sdp: sdp)
			machine.toolsAvailable = answer.toolsAvailable
			try await transport.accept(answer: answer.sdp)
			transport.setMicEnabled(!isMuted)
			return true
		} catch RealtimeTransportError.microphoneDenied {
			stop(because: "Allow Microphone access in Settings to talk with \(agentName).")
		} catch is CancellationError {
			transport.close()
		} catch let error as VoiceCallFailure {
			if recovering, !error.shouldFallBack { return retryLater(transport) }
			if error.shouldFallBack, voiceSessionID == nil {
				fallBack()
			} else {
				stop(because: error.message)
			}
		} catch {
			if recovering { return retryLater(transport) }
			stop(because: "Couldn't connect the call. Try again.")
		}
		return true
	}

	/// This try at a new call failed and the network may simply still be down: give back what it took
	/// (the slot it reserved, the microphone) and say the caller should try again.
	private func retryLater(_ transport: any RealtimeTransport) -> Bool {
		transport.close()
		self.transport = nil
		if let id = voiceSessionID {
			voiceSessionID = nil
			lostSession = (id, 0, 0)
		}
		return false
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
		if !channelOpen {
			channelOpen = true
			for item in queuedChatItems { transport?.send(item) }
			queuedChatItems = []
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
				self?.recoverLostCall()
			}
		}
	}

	/// The connection did not come back by itself. The person is still there, so rather than ending
	/// the call, close this one and start a new call on the same chat (the server hands the agent the
	/// chat's recent messages, including this call's lines), trying again for a while.
	private func recoverLostCall() {
		guard isActive else { return }
		startTask?.cancel()
		release(reason: .networkError)
		channelOpen = false
		startTask = Task { [weak self] in await self?.recover() }
	}

	private func recover() async {
		for delay in recoveryDelays {
			try? await Task.sleep(for: delay)
			guard isActive, !Task.isCancelled else { return }
			await freeLostSlot()
			guard isActive, !Task.isCancelled else { return }
			if await connect(recovering: true) { return }
		}
		await freeLostSlot()
		stop(because: "The connection dropped and could not be restored.")
	}

	/// Says the lost call is over, until the server has heard it, so the next call is not refused.
	private func freeLostSlot() async {
		guard let lost = lostSession else { return }
		do {
			// The receipt it returns is not needed; only that the server heard it.
			_ = try await calls.hangup(
				voiceSessionID: lost.id, reason: .networkError, inputAudioSeconds: lost.input,
				outputAudioSeconds: lost.output)
			lostSession = nil
		} catch {
			// Still offline: it is said again before the next try.
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
		Task { [weak self] in
			// A hangup that fails must not trap anyone: the server's idle sweeper closes the call anyway.
			let done: Bool
			do {
				_ = try await calls.hangup(
					voiceSessionID: id, reason: reason, inputAudioSeconds: input, outputAudioSeconds: output)
				done = true
			} catch {
				done = false
			}
			// A lost call whose hangup did not land is said again before the next call is made.
			if !done, reason == .networkError { self?.lostSession = (id, input, output) }
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
