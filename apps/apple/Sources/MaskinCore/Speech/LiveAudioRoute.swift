import Foundation

/// Where a live call's sound should go, as a rule with no audio framework in it so it can be tested.
///
/// The call asks for the loudspeaker through the audio session's `.defaultToSpeaker` option. That
/// option does not survive something else changing the session's category, and the voice call's
/// WebRTC audio unit does exactly that when it starts: it sets its own `.playAndRecord` category
/// without the option, and the agent's voice falls back to the earpiece. So the call watches the
/// route and puts the speaker back whenever the output has become the earpiece.
public enum LiveAudioRoute {
	public enum Output: Equatable, Sendable {
		/// The earpiece at the top of the phone.
		case receiver
		/// The loudspeaker.
		case speaker
		/// Headphones, AirPods, a car, anything the person plugged in or paired.
		case other
	}

	/// Whether the speaker must be forced on: the person wants it, and the sound is going to the
	/// earpiece. Headphones and Bluetooth win over the speaker, so those are never overridden.
	public static func needsSpeakerOverride(wantsSpeaker: Bool, output: Output?) -> Bool {
		wantsSpeaker && output == .receiver
	}

	/// The microphone hint the server tunes noise reduction with. A headset, earbuds, a car or a
	/// phone held to the face have the mic close to the mouth (`near_field`); the loudspeaker means
	/// the phone is held out or set down, so the mic is further away (`far_field`). With no route
	/// known there is no hint, and the server uses its own default.
	public static func noiseReduction(for output: Output?) -> VoiceNoiseReduction? {
		switch output {
		case .receiver, .other: .nearField
		case .speaker: .farField
		case nil: nil
		}
	}
}
