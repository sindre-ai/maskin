import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The paste form for a tool whose vendor lets only the customer's own admin create the sign-in
/// app (Salesforce): the callback address to give the app, its id, and its secret as a hidden
/// field. Same wording as the web form. The secret is stored encrypted and never shown again, so
/// changing the app asks for the whole pair. Saving a first app carries on to the sign-in.
struct OwnAppView: View {
	@State private var store: OwnAppStore
	@State private var copied = false
	@Environment(\.dismiss) private var dismiss
	/// Runs once the app is saved or removed, with whether to carry on to the sign-in.
	let onFinished: (_ connectNext: Bool) -> Void

	init(store: OwnAppStore, onFinished: @escaping (_ connectNext: Bool) -> Void) {
		_store = State(initialValue: store)
		self.onFinished = onFinished
	}

	var body: some View {
		WorkspacePage(title: store.title) {
			PageFootnote(text: store.explanation)
			if let callback = store.status?.callbackURL {
				PageGroupLabel(text: "Callback URL to give the app")
				PageCard(rows: [
					PageRowModel(
						id: "callback", title: "Callback URL", subtitle: callback, subtitleIsMono: true,
						accessory: .state(PageState(copied ? "Copied" : "Copy", .plain)),
						action: { if PlainPasteboard.copy(callback) { copied = true } })
				])
			}
			PageGroupLabel(text: "App ID")
			PageTextField(title: store.idPlaceholder, text: $store.clientId, mono: true, isURL: true)
			PageGroupLabel(text: "App secret")
			PageTextField(
				title: store.secretPlaceholder, text: $store.clientSecret, mono: true, isURL: true,
				secure: true)
			if let error = store.error { FormError(error) }
			Button(store.isSaving ? "Saving…" : store.saveTitle) {
				Task {
					await store.save()
					if store.didSave {
						onFinished(store.connectsAfterSave)
						dismiss()
					}
				}
			}
			.buttonStyle(.primaryAction)
			.disabled(!store.canSave)
			if store.replacing {
				Button("Remove app", role: .destructive) {
					Task {
						await store.remove()
						if store.didRemove {
							onFinished(false)
							dismiss()
						}
					}
				}
				.disabled(!store.canRemove)
			}
		}
		.overlay { if store.isLoading { ProgressView() } }
		.task { await store.load() }
	}
}
