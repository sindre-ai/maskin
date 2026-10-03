import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

struct ProfileView: View {
	@State private var store: ProfileStore
	@State private var name: String
	@State private var copiedId = false

	init(store: ProfileStore) {
		_store = State(initialValue: store)
		_name = State(initialValue: store.profile.name)
	}

	var body: some View {
		Form {
			Section("Name") {
				TextField("Your name", text: $name)
					#if os(iOS)
						.textInputAutocapitalization(.words)
					#endif
					.autocorrectionDisabled()
					.submitLabel(.done)
					.onSubmit { save() }
			}
			if let email = store.profile.email, !email.isEmpty {
				Section("Email") {
					Text(email).foregroundStyle(MaskinColor.ink3)
				}
			}
			Section {
				Button {
					SecretPasteboard.copy(store.profile.actorId)
					copiedId = true
				} label: {
					SettingsRow(
						symbol: "doc.on.doc", title: copiedId ? "Copied" : "Copy my ID")
				}
			} header: {
				Text("Share")
			} footer: {
				Text("Send this ID to a workspace admin so they can add you as a member.")
			}
			if let error = store.error {
				Section { FormError(error) }
			}
		}
		.settingsListStyle()
		.navigationTitle("Profile")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
		.toolbar {
			ToolbarItem(placement: .confirmationAction) {
				Button("Save") { save() }.disabled(!store.canSave(name: name))
			}
		}
	}

	private func save() {
		Task { if await store.saveName(name) { name = store.profile.name } }
	}
}
