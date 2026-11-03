import MaskinCore

/// What the live call screen needs from whatever is carrying the conversation: the dictation loop
/// (`LiveVoiceController`: you speak, it sends a chat message, the reply is read aloud) or an OpenAI
/// Realtime call (`RealtimeVoiceCall`: audio flows both ways and the agent answers by voice).
@MainActor
protocol LiveVoiceDriving: AnyObject {
	var phase: LiveVoicePhase { get }
	/// What you are saying right now, for the status line.
	var transcript: String { get }
	var isMuted: Bool { get }
	/// Why the conversation could not start or had to stop.
	var failure: String? { get }
	/// A passing note for the status line (e.g. a pause), if the driver has one.
	var notice: String? { get }
	/// The agent has paused and it is the person's turn to speak.
	var isYourTurn: Bool { get }

	/// True when the driver keeps its own transcript, so captions come from `agentWords` rather than
	/// from messages arriving in the chat.
	var capturesOwnTranscript: Bool { get }
	var agentWords: String? { get }
	/// Whether the conversation is up, for the call orb: false while a call is being set up.
	var isConnected: Bool { get }
	/// Live audio levels for the call orb; nil when the driver has none (the dictation loop).
	var levels: CallLevelMeter? { get }

	func begin(existing: [ChatMessage])
	func end()
	func toggleMute()
	func interrupt()
	func messagesChanged(_ messages: [ChatMessage])
}

extension LiveVoiceController: LiveVoiceDriving {
	var capturesOwnTranscript: Bool { false }
	var agentWords: String? { nil }
	var isConnected: Bool { true }
	var levels: CallLevelMeter? { nil }
}

extension RealtimeVoiceCall {
	/// The Realtime call talks over the person and has no pauses to hand back.
	var notice: String? { nil }
	var isYourTurn: Bool { false }
	var levels: CallLevelMeter? { meter }
}
