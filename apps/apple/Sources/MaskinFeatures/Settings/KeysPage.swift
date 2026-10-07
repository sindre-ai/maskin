import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Keys (2D), for owners and admins. The API has one key per person and no listing, revoking or
/// naming of keys, so this shows the signed-in person's own key and can replace it. A replaced key
/// is shown once.
struct KeysPage: View {
	@State private var store: APIKeyStore
	@State private var confirming = false
	@State private var copied = false
	@Environment(\.scenePhase) private var scenePhase

	init(store: APIKeyStore) { _store = State(initialValue: store) }

	var body: some View {
		WorkspacePage(title: "Keys") {
			PageCard(rows: [
				PageRowModel(
					id: "own", title: "Your API key",
					subtitle: "Lets outside tools, such as MCP clients, act as you",
					accessory: .state(WorkspacePageState.activeKey))
			])
			if let text = store.displayText {
				SecretKeyCard(
					text: text, isRevealed: store.isRevealed,
					onToggle: { store.setRevealed(!store.isRevealed) },
					onCopy: { copy() })
				PageFootnote(
					text: copied
						? "Copied. It leaves the clipboard in a minute."
						: "Copy it now. It won't be shown again.")
			}
			if let error = store.error { FormError(error) }
			PageFootnote(
				text: store.canRegenerate || store.phase == .regenerating
					? "A new key replaces this one. Anything using the old key stops working."
					: "Making a new key isn't available in this build yet.")
			Button(store.phase == .regenerating ? "Making a key" : "New key") { confirming = true }
				.buttonStyle(.primaryAction)
				.disabled(!store.canRegenerate)
		}
		.onDisappear { store.clear() }
		.onChange(of: scenePhase) { _, phase in
			if phase != .active { store.concealForScene(isBackground: phase == .background) }
		}
		.confirmationDialog("Make a new key?", isPresented: $confirming, titleVisibility: .visible) {
			Button("Make a new key and sign out other devices", role: .destructive) {
				copied = false
				Task { await store.regenerate() }
			}
		} message: {
			Text(
				"Your current key stops working immediately. Other devices and tools are signed out and must use the new key.")
		}
	}

	private func copy() {
		guard let key = store.newKey else { return }
		copied = SecretPasteboard.copy(key.reveal())
	}
}
