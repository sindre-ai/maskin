import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A secret caught in the message box, before it is sent. The server refuses a message that holds
/// one, so this is the way out: save it to the Keychain (shared with this chat's agents, and
/// replaced in the message by a marker), cut it out of the message, or go back and edit.
struct CaughtSecret: Identifiable {
	let id = UUID()
	let text: String
	let match: SecretScanner.Match
}

struct SecretCaughtSheet: View {
	@Environment(\.dismiss) private var dismiss
	let caught: CaughtSecret
	let store: KeychainStore
	/// The agents in this chat, ticked by default when saving.
	let chatAgentIDs: Set<String>
	/// The message with the secret cut out.
	let onRemove: (String) -> Void
	/// The message with the secret replaced by its marker, once it is in the Keychain.
	let onVaulted: (String) -> Void

	var body: some View {
		NavigationStack {
			VStack(alignment: .leading, spacing: MaskinSpace.s8) {
				VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					Text("That looks like \(caught.match.description)")
						.maskinText(.title).foregroundStyle(MaskinColor.ink)
						.fixedSize(horizontal: false, vertical: true)
					Text(SecretScanner.masked(caught.match.value))
						.maskinText(.subhead).foregroundStyle(MaskinColor.ink3).monospaced()
					Text(
						"It wasn't sent. Whatever you send stays in the chat. Save it to your Keychain instead: your agents can use it without it ever appearing here."
					)
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
					.fixedSize(horizontal: false, vertical: true)
				}
				VStack(spacing: MaskinSpace.s4) {
					NavigationLink {
						AddCredentialView(
							store: store,
							prefill: .init(
								name: caught.match.suggestedName, secret: caught.match.value,
								masked: SecretScanner.masked(caught.match.value)),
							shareWith: chatAgentIDs,
							onSaved: { name in
								onVaulted(SecretScanner.redacted(caught.text, [caught.match], name: name))
								dismiss()
							})
					} label: {
						Text("Save to Keychain")
							.maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinSurface.onInverse)
							.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
							.background(MaskinSurface.inverse, in: Capsule())
					}
					RequestCardButton(title: "Cut it out of my message") {
						onRemove(SecretScanner.withoutSecrets(caught.text, [caught.match]))
						dismiss()
					}
					RequestCardButton(title: "Edit my message") { dismiss() }
				}
				Spacer(minLength: 0)
			}
			.padding(MaskinSpace.s9)
			.navigationTitle("Keep it out of the chat")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
		}
		.presentationDetents([.medium, .large])
		.task { await store.load() }
	}
}
