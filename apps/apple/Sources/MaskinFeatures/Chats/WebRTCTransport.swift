#if os(iOS) && canImport(WebRTC)
import AVFoundation
import Foundation
import MaskinCore
import WebRTC

/// The microphone, the speaker and the peer connection to the OpenAI Realtime edge. Audio goes in
/// and out through WebRTC's own audio unit (echo cancelled); control events travel on the
/// `oai-events` data channel. The server does the vendor handshake: this only makes the offer and
/// applies the answer, so no vendor credential is ever on the device.
@MainActor
final class WebRTCTransport: RealtimeTransport {
	private let bridge = Bridge()
	private var factory: RTCPeerConnectionFactory?
	private var peer: RTCPeerConnection?
	private var channel: RTCDataChannel?
	private var micTrack: RTCAudioTrack?
	private var audioSessionActive = false
	private var meterTask: Task<Void, Never>?
	/// Set by `close()`. An offer still waiting on the permission prompt must not open the
	/// microphone after the call was hung up.
	private var isClosed = false

	func makeOffer(
		onEvent: @escaping @MainActor @Sendable (Data) -> Void,
		onConnection: @escaping @MainActor @Sendable (RealtimeConnectionState) -> Void
	) async throws -> String {
		guard await AVAudioApplication.requestRecordPermission() else {
			throw RealtimeTransportError.microphoneDenied
		}
		guard !isClosed else { throw CancellationError() }
		try configureAudioSession()

		bridge.onMessage = { data in Task { @MainActor in onEvent(data) } }
		bridge.onConnection = { state in Task { @MainActor in onConnection(state) } }

		let factory = RTCPeerConnectionFactory()
		self.factory = factory

		let config = RTCConfiguration()
		config.sdpSemantics = .unifiedPlan
		config.continualGatheringPolicy = .gatherContinually
		let constraints = RTCMediaConstraints(
			mandatoryConstraints: nil, optionalConstraints: ["DtlsSrtpKeyAgreement": "true"])
		guard let peer = factory.peerConnection(with: config, constraints: constraints, delegate: bridge)
		else { throw RealtimeTransportError.setup("Couldn't start the audio connection.") }
		self.peer = peer

		// Local audio goes to OpenAI on this track; muting flips `isEnabled`.
		let source = factory.audioSource(
			with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
		let track = factory.audioTrack(with: source, trackId: "maskin-mic")
		micTrack = track
		peer.add(track, streamIds: ["maskin"])

		guard let channel = peer.dataChannel(forLabel: "oai-events", configuration: RTCDataChannelConfiguration())
		else { throw RealtimeTransportError.setup("Couldn't open the event channel.") }
		channel.delegate = bridge
		self.channel = channel

		let offer = try await Self.createOffer(peer)
		try await Self.setLocal(peer, sdp: offer)
		return offer
	}

	func accept(answer: String) async throws {
		guard let peer else { throw RealtimeTransportError.setup("The call was closed.") }
		try await Self.setRemote(peer, sdp: answer)
	}

	func send(_ json: String) {
		guard let channel, channel.readyState == .open else { return }
		channel.sendData(RTCDataBuffer(data: Data(json.utf8), isBinary: false))
	}

	/// Read after the audio session is configured, so the route (speaker, headset, earpiece) is the
	/// one the call starts on.
	var noiseReduction: VoiceNoiseReduction? {
		LiveAudioRoute.noiseReduction(for: LiveAudioSession.currentOutput())
	}

	/// Polls the connection's stats about 20 times a second: `audioLevel` on the inbound audio is the
	/// agent's voice, on the local audio source is your microphone (it reads 0 while muted).
	func startMetering(into meter: CallLevelMeter) {
		meterTask?.cancel()
		meterTask = Task { [weak self] in
			while !Task.isCancelled {
				self?.peer?.statistics { report in
					var input: Double?
					var output: Double?
					for stat in report.statistics.values {
						guard let level = (stat.values["audioLevel"] as? NSNumber)?.doubleValue else { continue }
						switch stat.type {
						case "inbound-rtp": output = max(output ?? 0, level)
						case "media-source": input = max(input ?? 0, level)
						default: break
						}
					}
					meter.record(input: input, output: output)
				}
				try? await Task.sleep(for: .milliseconds(50))
			}
		}
	}

	func setMicEnabled(_ enabled: Bool) { micTrack?.isEnabled = enabled }

	func restartIce() { peer?.restartIce() }

	func close() {
		isClosed = true
		meterTask?.cancel()
		meterTask = nil
		bridge.onMessage = nil
		bridge.onConnection = nil
		channel?.close()
		channel = nil
		micTrack?.isEnabled = false
		micTrack = nil
		peer?.close()
		peer = nil
		factory = nil
		if audioSessionActive {
			audioSessionActive = false
			try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
		}
	}

	// MARK: Audio session

	/// Speaker by default (this is a call you hold in front of you, not to your ear), headsets allowed.
	/// `.voiceChat` is what turns on the hardware echo canceller and gain control; without it the
	/// agent's own voice would come back through the microphone and cut it off.
	private func configureAudioSession() throws {
		let session = AVAudioSession.sharedInstance()
		do {
			try session.setCategory(
				.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
			try session.setActive(true)
			audioSessionActive = true
		} catch {
			throw RealtimeTransportError.setup("Couldn't use the microphone and speaker.")
		}
	}

	// MARK: SDP, as plain strings so nothing non-Sendable crosses an await

	private static func createOffer(_ peer: RTCPeerConnection) async throws -> String {
		let constraints = RTCMediaConstraints(
			mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil)
		return try await withCheckedThrowingContinuation { continuation in
			peer.offer(for: constraints) { @Sendable description, error in
				if let description {
					continuation.resume(returning: description.sdp)
				} else {
					continuation.resume(
						throwing: error ?? RealtimeTransportError.setup("Couldn't create the call offer."))
				}
			}
		}
	}

	private static func setLocal(_ peer: RTCPeerConnection, sdp: String) async throws {
		try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
			peer.setLocalDescription(RTCSessionDescription(type: .offer, sdp: sdp)) { @Sendable error in
				if let error { continuation.resume(throwing: error) } else { continuation.resume() }
			}
		}
	}

	private static func setRemote(_ peer: RTCPeerConnection, sdp: String) async throws {
		try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
			peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { @Sendable error in
				if let error { continuation.resume(throwing: error) } else { continuation.resume() }
			}
		}
	}
}

/// WebRTC calls its delegates on its own threads, so this holds no state of its own and only
/// forwards plain values (`Data`, a connection state) to the main actor.
private final class Bridge: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate,
	@unchecked Sendable
{
	var onMessage: (@Sendable (Data) -> Void)?
	var onConnection: (@Sendable (RealtimeConnectionState) -> Void)?

	func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
		switch newState {
		case .connected, .completed: onConnection?(.connected)
		case .disconnected: onConnection?(.disconnected)
		case .failed: onConnection?(.failed)
		default: break
		}
	}

	func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
		guard !buffer.isBinary else { return }
		onMessage?(buffer.data)
	}

	func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}

	// The rest of the delegate is required but of no use here: the media is one audio track each way
	// and nothing is renegotiated.
	func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
	func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
	func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
	func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
	func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
	func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
	func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
	func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
#endif
