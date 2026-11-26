import MaskinCore
import SwiftUI

extension View {
	/// Shows the own-app paste form while `store.ownAppPrompt` is set. Once the app is saved the
	/// sign-in starts after the sheet has gone, so the sign-in sheet has a screen to rise from.
	/// `providerID` limits the sheet to one tool, for a screen with several cards sharing a store.
	func ownAppSheet(
		store: IntegrationsStore?, providerID: String? = nil,
		makeStore: @escaping (OwnAppPrompt) -> OwnAppStore?
	) -> some View {
		modifier(OwnAppSheet(store: store, providerID: providerID, makeStore: makeStore))
	}
}

private struct OwnAppSheet: ViewModifier {
	let store: IntegrationsStore?
	let providerID: String?
	let makeStore: (OwnAppPrompt) -> OwnAppStore?
	/// The tool to sign in to once the sheet has dismissed, set when a first app was saved.
	@State private var connectAfterDismiss: String?

	func body(content: Content) -> some View {
		content.sheet(
			item: Binding<OwnAppPrompt?>(
				get: {
					guard let prompt = store?.ownAppPrompt else { return nil }
					return providerID == nil || prompt.providerID == providerID ? prompt : nil
				},
				set: { if $0 == nil { store?.dismissOwnApp() } }),
			onDismiss: finish
		) { prompt in
			if let form = makeStore(prompt) {
				NavigationStack {
					OwnAppView(store: form) { connectNext in
						if connectNext { connectAfterDismiss = prompt.providerID }
					}
				}
			}
		}
	}

	private func finish() {
		guard let store else { return }
		let providerID = connectAfterDismiss
		connectAfterDismiss = nil
		Task {
			await store.load()
			if let providerID { await store.connect(providerID: providerID, appChecked: true) }
		}
	}
}
