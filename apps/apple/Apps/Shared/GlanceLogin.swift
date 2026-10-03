import MaskinCore
import MaskinDesign
import SwiftUI

/// Email + password sign-in. Watch and Apple TV have no shared Keychain with the phone, so each
/// signs in on its own (dictation / Scribble on the watch, the on-screen keyboard on TV).
struct GlanceLogin: View {
	let auth: AuthSession
	@State private var email = ""
	@State private var password = ""

	private var canSubmit: Bool {
		let e = email.trimmingCharacters(in: .whitespacesAndNewlines)
		return e.contains("@") && !password.isEmpty
	}

	var body: some View {
		NavigationStack {
			Form {
				Section {
					TextField("Email", text: $email)
						.textContentType(.username)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
					SecureField("Password", text: $password)
						.textContentType(.password)
				}
				if let error = auth.lastError {
					Text(Self.message(for: error))
						.font(.footnote)
						.foregroundStyle(MaskinColor.danger)
				}
				Section {
					Button {
						let e = email.trimmingCharacters(in: .whitespacesAndNewlines)
						Task { await auth.signIn(email: e, password: password) }
					} label: {
						if auth.isSigningIn {
							ProgressView().frame(maxWidth: .infinity)
						} else {
							Text("Sign in").frame(maxWidth: .infinity)
						}
					}
					.disabled(!canSubmit || auth.isSigningIn)
				}
			}
			.navigationTitle("Maskin")
		}
	}

	static func message(for error: AuthError) -> String {
		switch error {
		case .invalidCredentials: "Email or password is wrong."
		case .server(let status): "Maskin is having trouble (error \(status))."
		case .network: "Can't reach Maskin."
		}
	}
}
