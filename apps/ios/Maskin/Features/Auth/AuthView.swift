import SwiftUI

/// Mirrors `apps/web/src/routes/login.tsx` / `signup.tsx`: the submit button is only
/// disabled while a request is in flight — validation happens on submit and shows an
/// inline error, rather than silently graying out the button while the user types
/// (that pre-validation was the earlier bug here: a password under 8 characters left
/// the button permanently disabled with no explanation).
///
/// `organization`/`role` feed a knowledge-capture write on signup (see
/// `SignupCapture.objectBody`), mirroring `buildSignupCaptureKnowledge` on web — a
/// "Strategist research-on-signup" trigger reads this object back, so the fields exist
/// on both clients rather than being web-only.
struct AuthView: View {
	@Environment(AuthManager.self) private var auth
	@State private var mode: Mode = .login
	@State private var name = ""
	@State private var organization = ""
	@State private var role = ""
	@State private var email = ""
	@State private var password = ""
	@State private var confirmPassword = ""
	@State private var isSubmitting = false
	@State private var errorMessage: String?

	enum Mode { case login, signup }

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpacing.s6) {
					VStack(alignment: .leading, spacing: MaskinSpacing.s2) {
						Text("Maskin")
							.font(MaskinFont.display(34, weight: .bold))
							.foregroundStyle(MaskinColor.ink)
						Text(mode == .login ? "Sign in with your email and password" : "Set up your workspace")
							.font(MaskinFont.base)
							.foregroundStyle(MaskinColor.ink2)
					}
					.padding(.top, MaskinSpacing.s6)

					VStack(spacing: MaskinSpacing.s3) {
						if mode == .signup {
							field("Name", text: $name, placeholder: "Your name", textContentType: .name)
							field("Organization", text: $organization, placeholder: "Company name", textContentType: .organizationName)
							field("Role", text: $role, placeholder: "What you do", textContentType: .jobTitle)
						}
						field("Email", text: $email, placeholder: "you@example.com", textContentType: .emailAddress, keyboard: .emailAddress)
						field(
							"Password", text: $password, isSecure: true,
							placeholder: mode == .signup ? "At least 8 characters" : "Your password",
							textContentType: .password
						)
						if mode == .signup {
							field("Confirm password", text: $confirmPassword, isSecure: true, placeholder: "Repeat your password", textContentType: .password)
						}
					}

					if let errorMessage {
						Text(errorMessage)
							.font(MaskinFont.xs)
							.foregroundStyle(MaskinColor.danger)
					}

					Button(action: submit) {
						HStack {
							Spacer()
							if isSubmitting {
								ProgressView().tint(MaskinColor.surface)
							} else {
								Text(mode == .login ? "Sign in" : "Create account")
									.font(MaskinFont.md.weight(.semibold))
							}
							Spacer()
						}
						.padding(.vertical, MaskinSpacing.s3)
					}
					.background(MaskinColor.ink)
					.foregroundStyle(MaskinColor.surface)
					.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.md))
					.disabled(isSubmitting)
					.opacity(isSubmitting ? 0.5 : 1)

					Button(mode == .login ? "Don't have an account? Sign up" : "Already have an account? Sign in") {
						mode = mode == .login ? .signup : .login
						errorMessage = nil
					}
					.font(MaskinFont.sm)
					.foregroundStyle(MaskinColor.ink2)
					.frame(maxWidth: .infinity)
				}
				.padding(MaskinSpacing.s6)
			}
			.background(MaskinColor.surface)
			.scrollDismissesKeyboard(.interactively)
		}
	}

	private func field(
		_ title: String, text: Binding<String>, isSecure: Bool = false, placeholder: String = "",
		textContentType: UITextContentType? = nil, keyboard: UIKeyboardType = .default
	) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpacing.s1) {
			Text(title.uppercased())
				.font(MaskinFont.label)
				.tracking(MaskinFont.trackingLabel)
				.foregroundStyle(MaskinColor.ink3)
			Group {
				if isSecure {
					SecureField(placeholder, text: text)
				} else {
					TextField(placeholder, text: text)
						.keyboardType(keyboard)
						.autocapitalization(.none)
				}
			}
			.textContentType(textContentType)
			.font(MaskinFont.md)
			.padding(MaskinSpacing.s3)
			.background(MaskinColor.linen)
			.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.md))
		}
	}

	private func submit() {
		errorMessage = nil

		let trimmedEmail = email.trimmingCharacters(in: .whitespaces)
		let trimmedName = name.trimmingCharacters(in: .whitespaces)
		let trimmedOrg = organization.trimmingCharacters(in: .whitespaces)
		let trimmedRole = role.trimmingCharacters(in: .whitespaces)
		if mode == .signup {
			guard !trimmedName.isEmpty else { return errorMessage = "Name is required" }
			guard !trimmedOrg.isEmpty else { return errorMessage = "Organization is required" }
			guard !trimmedRole.isEmpty else { return errorMessage = "Role is required" }
			guard !trimmedEmail.isEmpty else { return errorMessage = "Email is required" }
			guard password.count >= 8 else { return errorMessage = "Password must be at least 8 characters" }
			guard password == confirmPassword else { return errorMessage = "Passwords do not match" }
		} else {
			guard !trimmedEmail.isEmpty else { return errorMessage = "Email is required" }
			guard !password.isEmpty else { return errorMessage = "Password is required" }
		}

		isSubmitting = true
		Task {
			defer { isSubmitting = false }
			do {
				if mode == .login {
					try await auth.login(email: trimmedEmail, password: password)
				} else {
					try await auth.signup(name: trimmedName, email: trimmedEmail, password: password)
					// Mirrors signup.tsx: best-effort — a failure here shouldn't block
					// the user from landing in their new workspace.
					if let workspaceId = auth.workspaceId {
						let body = SignupCapture.objectBody(name: trimmedName, organization: trimmedOrg, role: trimmedRole)
						try? await ObjectsAPI.create(body, workspaceId: workspaceId)
					}
				}
			} catch {
				errorMessage = (error as? APIError)?.message ?? error.localizedDescription
			}
		}
	}
}
