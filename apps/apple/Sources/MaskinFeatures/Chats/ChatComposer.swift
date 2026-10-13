import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The composer as the thread, For you and the loop views have called it: a thin wrapper that maps
/// the old parameters onto `MaskinComposer` and keeps the live voice conversation (the waveform
/// button while the field is empty, and the panel that replaces the bar) running through
/// `LiveVoiceController`.
///
/// Hosts should switch to `MaskinComposer` directly; this stays until they have.
struct ChatComposer: View {
	@Bindable var model: ChatComposerModel
	let placeholder: String
	/// People and agents the `@` picker offers for a query. Ignored when `roster` is set.
	var suggestions: (String) -> [ChatParticipant] = { _ in [] }
	/// People already in the conversation: listed first by the `@` picker.
	var inConversation: Set<String> = []
	let onSend: () -> Void
	/// Whom a live conversation is with, for the panel's wording.
	var agentName = "Agent"
	/// The mic and live controls. They need the Speech framework, so they are iOS-only unless a
	/// preview asks for them.
	var showsVoiceControls: Bool = {
		#if os(iOS)
		true
		#else
		false
		#endif
	}()
	/// Starts a preview in this voice state (design review); real use starts idle.
	var previewVoice: ComposerVoiceState = .idle
	/// The latest messages, so a live conversation can hear the agent's reply arrive.
	var replies: [ChatMessage] = []
	/// Everyone `@` can tag (workspace members and agents, with their roles). Nil falls back to
	/// `suggestions`.
	var roster: MentionRoster?
	/// Photos, camera and files in the `+` menu.
	var allowsAttach = true
	/// The Go live button (iOS only, and only with `showsVoiceControls`).
	var allowsLive = true
	/// Told when the field gains or loses focus (For you hides its quick-question chips while typing).
	var onFocusChange: ((Bool) -> Void)?
	/// An agent is working on a reply: Stop takes the last slot while the field is empty.
	var busy = false
	var onStop: (() -> Void)?

	/// Set once the reader acts; until then the preview state (idle in real use) stands.
	@State var voiceChoice: ComposerVoiceState?
	@State var muted = false
	#if os(iOS)
	@State var liveDictation = Dictation()
	@State var live: LiveVoiceController?
	@State var liveAudio: LiveAudioSession?
	@Environment(\.openURL) var openURL
	#endif
	/// What went wrong with a live conversation, shown once with a way to Settings.
	@State var voiceProblem: String?

	var voice: ComposerVoiceState {
		get { voiceChoice ?? previewVoice }
		nonmutating set { voiceChoice = newValue }
	}

	var body: some View {
		Group {
			if let panel = livePanel {
				LiveVoicePanel(
					phase: panel.phase, agentName: agentName, transcript: panel.transcript, muted: panel.muted,
					onToggleMute: toggleLiveMute, onEnd: endLive, onInterrupt: interruptLive
				)
				.transition(.opacity.combined(with: .scale(scale: 0.98)))
			} else {
				MaskinComposer(model: model, config: config, busy: busy, onStop: onStop, onSend: onSend)
					.composerPreview(previewVoice == .dictating ? .init(dictating: true) : nil)
			}
		}
		.animation(MaskinMotion.standard, value: voice)
		.liveLifecycle(self)
	}

	private var config: MaskinComposerConfig {
		MaskinComposerConfig(
			placeholder: placeholder, showsAttach: allowsAttach, showsMic: showsVoiceControls,
			goLive: allowsLive && showsVoiceControls ? { startLive() } : nil,
			suggestions: suggestions, inConversation: inConversation, roster: roster, onFocusChange: onFocusChange)
	}
}

// MARK: - Live voice

extension ChatComposer {
	/// The live panel's content: the real conversation when one is running, the preview state in design review.
	fileprivate var livePanel: (phase: LiveVoicePhase, transcript: String, muted: Bool)? {
		#if os(iOS)
		if let live, live.isActive { return (live.phase, live.transcript, live.isMuted) }
		#endif
		if case .live(let phase) = voice { return (phase, model.text, muted) }
		return nil
	}

	fileprivate func startLive() {
		#if os(iOS)
		guard live == nil else { return }
		let model = model
		let onSend = onSend
		// The same engine as the full-screen call: its own recogniser and audio session.
		let controller = LiveVoiceController(
			ports: LiveMeetingSession.devicePorts(send: { text in
				model.text = text
				onSend()
			}))
		let audio = LiveAudioSession()
		do {
			try audio.activate(title: "Live conversation", voice: controller)
			liveAudio = audio
		} catch {
			voiceProblem = "Couldn't open the audio session (\(error.localizedDescription))."
			return
		}
		live = controller
		controller.begin(existing: replies)
		#else
		voice = .live(.listening)
		#endif
	}

	fileprivate func endLive() {
		#if os(iOS)
		live?.end()
		live = nil
		liveAudio?.deactivate()
		liveAudio = nil
		#endif
		voice = .idle
	}

	fileprivate func toggleLiveMute() {
		#if os(iOS)
		if let live {
			live.toggleMute()
			return
		}
		#endif
		muted.toggle()
	}

	fileprivate func interruptLive() {
		#if os(iOS)
		live?.interrupt()
		#endif
	}
}

/// Keeps a live conversation tidy: ends it when the composer goes away, hands the agent's replies
/// to it, and explains a failure.
private struct LiveLifecycle: ViewModifier {
	let composer: ChatComposer

	func body(content: Content) -> some View {
		#if os(iOS)
		content
			.onDisappear {
				composer.live?.end()
				composer.liveAudio?.deactivate()
			}
			.onChange(of: composer.replies.map(\.id)) { _, _ in composer.live?.messagesChanged(composer.replies) }
			.onChange(of: composer.live?.isActive) { _, active in
				guard active == false, let live = composer.live else { return }
				if let failure = live.failure { composer.voiceProblem = failure }
				composer.live = nil
				composer.liveAudio?.deactivate()
				composer.liveAudio = nil
			}
			.alert("Voice", isPresented: Binding(get: { composer.voiceProblem != nil }, set: { if !$0 { composer.voiceProblem = nil } })) {
				Button("Open Settings") {
					if let url = URL(string: UIApplication.openSettingsURLString) { composer.openURL(url) }
				}
				Button("OK", role: .cancel) {}
			} message: {
				Text(composer.voiceProblem ?? "")
			}
		#else
		content
		#endif
	}
}

private extension View {
	func liveLifecycle(_ composer: ChatComposer) -> some View { modifier(LiveLifecycle(composer: composer)) }
}
