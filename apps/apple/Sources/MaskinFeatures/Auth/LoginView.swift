import MaskinCore
import MaskinDesign
import SwiftUI

/// Email + password sign-in. Autofill content types (`.username` / `.password`) let iCloud
/// Keychain offer saved credentials and offer to save new ones after a successful sign-in.
public struct LoginView: View {
	private enum Field { case email, password }

	private let auth: AuthSession
	@State private var form = LoginForm()
	@FocusState private var focus: Field?

	public init(environment: AppEnvironment) { auth = environment.auth }

	public var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s12) {
				VStack(alignment: .leading, spacing: MaskinSpace.s3) {
					Text("Maskin")
						.font(.largeTitle.weight(.semibold))
					Text("Sign in to your workspace.")
						.font(.body)
						.foregroundStyle(MaskinColor.ink4)
				}

				VStack(spacing: MaskinSpace.s7) {
					TextField("Email", text: $form.email)
						.textContentType(.username)
						.focused($focus, equals: .email)
						.submitLabel(.next)
						.onSubmit { focus = .password }
						.disableAutocorrection(true)
						#if os(iOS)
							.keyboardType(.emailAddress)
							.textInputAutocapitalization(.never)
						#endif
						.fieldStyle()

					SecureField("Password", text: $form.password)
						.textContentType(.password)
						.focused($focus, equals: .password)
						.submitLabel(.go)
						.onSubmit(submit)
						.fieldStyle()
				}

				if let error = auth.lastError {
					Text(error.message)
						.font(.footnote)
						.foregroundStyle(MaskinColor.danger)
						.accessibilityLabel("Sign in failed. \(error.message)")
				}

				Button(action: submit) {
					ZStack {
						Text("Sign in").opacity(auth.isSigningIn ? 0 : 1)
						if auth.isSigningIn { ProgressView() }
					}
					.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
				}
				.buttonStyle(.borderedProminent)
				.disabled(!form.canSubmit || auth.isSigningIn)
				.keyboardShortcut(.defaultAction)
			}
			.padding(MaskinSpace.s12)
			.frame(maxWidth: 420)
			.frame(maxWidth: .infinity)
		}
		.scrollDismissesKeyboard(.interactively)
		.background(MaskinColor.surface)
		.onAppear { focus = .email }
	}

	private func submit() {
		guard form.canSubmit, !auth.isSigningIn else { return }
		focus = nil
		let form = form
		Task { await auth.signIn(email: form.trimmedEmail, password: form.password) }
	}
}

extension View {
	fileprivate func fieldStyle() -> some View {
		padding(MaskinSpace.s8)
			.frame(minHeight: MaskinSpace.touchMin)
			.background(MaskinColor.surfaceMuted, in: RoundedRectangle(cornerRadius: MaskinRadius.inputLg))
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.inputLg).stroke(MaskinColor.ruleInput))
	}
}

#Preview("Login") {
	LoginView(environment: .preview(signedIn: false))
}
