import Foundation

/// The few fields of an OpenAI Realtime data-channel event the call cares about.
public struct RealtimeEvent: Decodable, Sendable, Equatable {
	public var type: String?
	public var callId: String?
	public var name: String?
	public var arguments: String?
	public var transcript: String?

	public init(
		type: String?, callId: String? = nil, name: String? = nil, arguments: String? = nil,
		transcript: String? = nil
	) {
		self.type = type
		self.callId = callId
		self.name = name
		self.arguments = arguments
		self.transcript = transcript
	}

	private enum CodingKeys: String, CodingKey {
		case type, name, arguments, transcript
		case callId = "call_id"
	}

	/// Nil for anything that is not a JSON object (the channel only ever carries JSON).
	public static func parse(_ data: Data) -> RealtimeEvent? {
		try? JSONDecoder().decode(RealtimeEvent.self, from: data)
	}
}

/// The state of a Realtime voice call, with no WebRTC in it: it is fed the events that arrive on the
/// data channel and answers with what to send back. Mirrors `use-voice-call.ts` and `voice-relay.ts`
/// in the web app, mapped onto the same three phases the live call screen already draws.
///
///     listening ──(you stop talking)──▶ thinking ──(agent audio starts)──▶ speaking ──(audio ends)──▶ listening
///
/// Barge-in is the server's job (server VAD cancels the response when you start talking), so the
/// machine only mirrors it.
public struct RealtimeCallMachine: Sendable, Equatable {
	public enum Command: Equatable, Sendable {
		/// A JSON event to send on the data channel.
		case sendEvent(String)
	}

	public struct Line: Equatable, Sendable, Identifiable {
		public enum Kind: Sendable { case user, assistant, tool }
		public var id: Int
		public var kind: Kind
		public var text: String
	}

	public private(set) var phase: LiveVoicePhase = .listening
	public private(set) var lines: [Line] = []
	/// What you last said, as transcribed, until the agent starts answering.
	public private(set) var heardText = ""
	/// False when the server could not attach its tool connection; set from the offer's answer.
	public var toolsAvailable = true

	private var connectedAt: Date?
	private var speakingSince: Date?
	private var outputAudioSeconds: TimeInterval = 0

	public init() {}

	/// What the agent last said, for captions.
	public var lastAgentWords: String? { lines.last { $0.kind == .assistant }?.text }

	/// Seconds of microphone audio sent: the length of the connected call.
	public func inputSeconds(at now: Date) -> Int {
		guard let connectedAt else { return 0 }
		return max(0, Int(now.timeIntervalSince(connectedAt).rounded()))
	}

	/// Seconds of agent audio received, counting an utterance still in progress.
	public func outputSeconds(at now: Date) -> Int {
		let live = speakingSince.map { now.timeIntervalSince($0) } ?? 0
		return max(0, Int((outputAudioSeconds + live).rounded()))
	}

	public mutating func handle(_ event: RealtimeEvent, at now: Date) -> [Command] {
		switch event.type {
		case "session.created":
			if connectedAt == nil { connectedAt = now }
			phase = .listening
		case "input_audio_buffer.speech_started":
			phase = .listening
			heardText = ""
		case "input_audio_buffer.speech_stopped":
			phase = .thinking
		case "output_audio_buffer.started":
			speakingSince = speakingSince ?? now
			phase = .speaking
			heardText = ""
		case "output_audio_buffer.stopped", "output_audio_buffer.cleared":
			finishUtterance(at: now)
			phase = .listening
		case "conversation.item.input_audio_transcription.completed":
			if let text = event.transcript?.trimmedOrNil {
				heardText = text
				addLine(.user, text)
			}
		// GA name first; the beta name is kept for an older edge.
		case "response.output_audio_transcript.done", "response.audio_transcript.done":
			if let text = event.transcript?.trimmedOrNil { addLine(.assistant, text) }
		case "response.function_call_arguments.done":
			guard let callId = event.callId, let name = event.name else { return [] }
			phase = .thinking
			addLine(.tool, Self.describeToolCall(name: name, arguments: event.arguments))
			guard !toolsAvailable else { return [] }
			return [
				.sendEvent(Self.toolUnavailableOutput(callId: callId)),
				.sendEvent(#"{"type":"response.create"}"#),
			]
		default:
			break
		}
		return []
	}

	/// The connection is gone: whatever was being said is over.
	public mutating func connectionEnded(at now: Date) {
		finishUtterance(at: now)
		phase = .listening
	}

	/// You tapped to cut the agent off. The server stops the audio; this puts the screen back to listening.
	public mutating func interrupted(at now: Date) -> [Command] {
		guard phase == .speaking || phase == .thinking else { return [] }
		finishUtterance(at: now)
		phase = .listening
		return [
			.sendEvent(#"{"type":"response.cancel"}"#),
			.sendEvent(#"{"type":"output_audio_buffer.clear"}"#),
		]
	}

	// MARK: Pieces

	private mutating func finishUtterance(at now: Date) {
		if let since = speakingSince { outputAudioSeconds += max(0, now.timeIntervalSince(since)) }
		speakingSince = nil
	}

	private mutating func addLine(_ kind: Line.Kind, _ text: String) {
		lines.append(Line(id: lines.count + 1, kind: kind, text: text))
	}

	/// Short tag for the transcript while a tool runs.
	static func describeToolCall(name: String, arguments: String?) -> String {
		if name == "search_objects", let data = arguments?.data(using: .utf8),
			let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
		{
			let query = (object["q"] as? String) ?? (object["query"] as? String)
			if let query = query?.trimmedOrNil { return "searching for \(query)…" }
		}
		return "running \(name)…"
	}

	/// A line someone typed in the chat during the call, as a conversation item the agent can use. It
	/// does not ask for a response: the agent answers when the person speaks.
	public static func chatMessageItem(from name: String, text: String) -> String {
		let note = "\(name) typed in the chat during this call: \(text.prefix(chatMessageLimit))"
		let event: [String: Any] = [
			"type": "conversation.item.create",
			"item": [
				"type": "message", "role": "user",
				"content": [["type": "input_text", "text": note]],
			],
		]
		let data = (try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])) ?? Data()
		return String(decoding: data, as: UTF8.self)
	}

	/// A plain note from the person as a conversation item, with no framing: what a tap in the dock
	/// chose. Pair it with `responseRequest` to have the agent carry on.
	public static func userNoteItem(_ text: String) -> String {
		let event: [String: Any] = [
			"type": "conversation.item.create",
			"item": [
				"type": "message", "role": "user",
				"content": [["type": "input_text", "text": String(text.prefix(chatMessageLimit))]],
			],
		]
		let data = (try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])) ?? Data()
		return String(decoding: data, as: UTF8.self)
	}

	/// Asks the model to answer now, with no overrides .
	public static let responseRequest: String = #"{"type":"response.create"}"#

	/// Longest typed message handed to the call, in characters.
	static let chatMessageLimit = 2000

	static func toolUnavailableOutput(callId: String) -> String {
		let output = #"{"error":"Tools are unavailable on this call right now.","error_code":"voice_channel_unavailable"}"#
		let event: [String: Any] = [
			"type": "conversation.item.create",
			"item": ["type": "function_call_output", "call_id": callId, "output": output],
		]
		let data = (try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])) ?? Data()
		return String(decoding: data, as: UTF8.self)
	}
}

extension String {
	fileprivate var trimmedOrNil: String? {
		let value = trimmingCharacters(in: .whitespacesAndNewlines)
		return value.isEmpty ? nil : value
	}
}
