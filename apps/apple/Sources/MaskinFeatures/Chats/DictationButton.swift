import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
#if os(iOS)
import UIKit
#endif

/// The composer's mic. Dictates into `text`, appending to whatever was already typed, and shows
/// the reason (permission refused, language unsupported) under the bar instead of failing silently.
/// Speech goes to the Maskin server, with the phone's recogniser as the fallback; `engineNote` carries
/// the plain-words note (the phone took over, the server heard nothing) for the host to show under the bar.
struct DictationButton: View {
	/// Dictation through the server, as in the chat composer. Not a setting: the phone is only the fallback.
	static let usesServer = true

	@Binding var text: String
	/// True while the mic is open, so the composer keeps it in place of Send.
	@Binding var listening: Bool
	/// Set when dictation is not going as it should; nil while all is well. Kept after the mic closes.
	@Binding var engineNote: String?
	#if os(iOS)
	@State private var dictation = Dictation()
	@State private var draft = DictationDraft(base: "")
	#endif

	#if os(iOS)
	@Environment(\.openURL) private var openURL

	private var failure: String? {
		if case .unavailable(let message) = dictation.state { message } else { nil }
	}

	private var failed: Binding<Bool> {
		Binding(get: { failure != nil }, set: { if !$0 { dictation.clearError() } })
	}

	private func openSettings() {
		if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
	}
	#endif

	var body: some View {
		#if os(iOS)
		Button {
			MaskinHaptics.play(.selection)
			if dictation.isListening {
				// Through the server the last phrase is still being transcribed: finish lets it land.
				Task { await dictation.finish() }
			} else {
				draft = DictationDraft(base: text)
				Task {
					await dictation.start(backend: Self.usesServer) { transcript in
						text = draft.apply(transcript: transcript, field: text)
					}
				}
			}
		} label: {
			ComposerMicLabel(listening: dictation.isListening)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel(dictation.isListening ? "Stop dictation" : "Start dictation")
		.onDisappear { dictation.stop() }
		.onChange(of: dictation.isListening) { _, now in listening = now }
		.onChange(of: dictation.engineNote) { _, note in engineNote = note }
		.alert("Dictation", isPresented: failed, presenting: failure) { _ in
			Button("Open Settings") { openSettings() }
			Button("OK", role: .cancel) {}
		} message: { Text($0) }
		#else
		EmptyView()
		#endif
	}
}
