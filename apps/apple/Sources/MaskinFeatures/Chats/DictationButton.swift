import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
#if os(iOS)
import UIKit
#endif

/// The composer's mic. Dictates into `text`, appending to whatever was already typed, and shows
/// the reason (permission refused, language unsupported) under the bar instead of failing silently.
struct DictationButton: View {
	@Binding var text: String
	/// True while the mic is open, so the composer keeps it in place of Send.
	@Binding var listening: Bool
	#if os(iOS)
	@State private var dictation = Dictation()
	@State private var base = ""
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
				dictation.stop()
			} else {
				base = text
				Task {
					await dictation.start { transcript in
						text = DictationText.merge(base: base, transcript: transcript)
					}
				}
			}
		} label: {
			ComposerMicLabel(listening: dictation.isListening)
		}
		.buttonStyle(.plain)
		.accessibilityLabel(dictation.isListening ? "Stop dictation" : "Start dictation")
		.onDisappear { dictation.stop() }
		.onChange(of: dictation.isListening) { _, now in listening = now }
		.alert("Dictation", isPresented: failed, presenting: failure) { _ in
			Button("Open Settings") { openSettings() }
			Button("OK", role: .cancel) {}
		} message: { Text($0) }
		#else
		EmptyView()
		#endif
	}
}
