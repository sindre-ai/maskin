import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

struct APIKeyView: View {
	@State private var store: APIKeyStore
	@State private var confirming = false
	@State private var copied = false
	@Environment(\.scenePhase) private var scenePhase

	init(store: APIKeyStore) { _store = State(initialValue: store) }

	var body: some View {
		Form {
			Section {
				Text(
					"Your API key lets other tools, such as MCP clients, act as you. Regenerating it signs out every other device and stops anything using the old key."
				)
				.foregroundStyle(MaskinColor.ink3)
			}
			if let text = store.displayText {
				Section {
					SecretKeyCard(
						text: text, isRevealed: store.isRevealed,
						onToggle: { store.setRevealed(!store.isRevealed) },
						onCopy: { copy() })
						.listRowInsets(EdgeInsets())
						.listRowBackground(Color.clear)
				} header: {
					Text("New key")
				} footer: {
					Text(
						copied
							? "Copied. It leaves the clipboard in a minute."
							: "Shown only now. Copy it somewhere safe; it can't be shown again.")
				}
			}
			if let error = store.error {
				Section { FormError(error) }
			}
			Section {
				Button("Regenerate API key", role: .destructive) { confirming = true }
					.disabled(!store.canRegenerate)
			} footer: {
				if store.canRegenerate == false && store.phase != .regenerating {
					Text("Regenerating isn't available in this build yet.")
				}
			}
		}
		.navigationTitle("API key")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
		.overlay { if store.phase == .regenerating { ProgressView() } }
		.onDisappear { store.clear() }
		.onChange(of: scenePhase) { _, phase in
			if phase != .active { store.concealForScene(isBackground: phase == .background) }
		}
		.confirmationDialog(
			"Regenerate your API key?", isPresented: $confirming, titleVisibility: .visible
		) {
			Button("Regenerate and sign out other devices", role: .destructive) {
				copied = false
				Task { await store.regenerate() }
			}
		} message: {
			Text(
				"The current key stops working immediately. Other devices and tools will be signed out and must use the new key.")
		}
	}

	private func copy() {
		guard let key = store.newKey else { return }
		copied = SecretPasteboard.copy(key.reveal())
	}
}
