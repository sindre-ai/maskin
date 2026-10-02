import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

struct ProfileView: View {
	@State private var store: ProfileStore
	@State private var name: String

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
			if let error = store.error {
				Section { FormError(error) }
			}
		}
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
