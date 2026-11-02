import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Invite people (v3): an email link that expires after 7 days. The person joins by accepting it.
struct InviteByEmailSheet: View {
	@Environment(\.dismiss) private var dismiss
	let store: InvitationsStore
	@State private var email = ""

	private var canSend: Bool { InvitationsStore.isValidEmail(email) && !store.isInviting }

	var body: some View {
		NavigationStack {
			Form {
				Section {
					TextField("name@company.com", text: $email)
						#if os(iOS)
							.textInputAutocapitalization(.never)
							.keyboardType(.emailAddress)
							.textContentType(.emailAddress)
						#endif
						.autocorrectionDisabled()
						.submitLabel(.send)
						.onSubmit { send() }
						.frame(minHeight: MaskinSpace.touchMin)
				} header: {
					Text("Email")
				} footer: {
					Text("They get an email link that expires after 7 days.")
				}
				if let error = store.actionError { Section { FormError(error) } }
			}
			.settingsListStyle()
			.navigationTitle("Invite people")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Invite") { send() }.disabled(!canSend)
				}
			}
			.overlay { if store.isInviting { ProgressView() } }
			.onAppear { store.dismissMessages() }
			.onDisappear { store.clearError() }
		}
		.presentationDetents([.medium, .large])
	}

	private func send() {
		guard canSend else { return }
		Task { if await store.invite(email: email) { dismiss() } }
	}
}
