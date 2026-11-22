import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The signed-out half of an invitation for someone with no account yet: the invited email (fixed,
/// the invitation is tied to it), an optional name and a password. Submitting creates the account
/// and joins in one step, as the web invite page does (`apps/web/src/routes/invite.tsx`).
struct InviteSignUpForm: View {
	let preview: InvitePreview
	let isBusy: Bool
	let onSubmit: (_ name: String, _ password: String) -> Void

	@State private var name = ""
	@State private var password = ""
	@State private var showPassword = false
	@FocusState private var focus: Field?

	private enum Field: Hashable { case name, password }

	private var canSubmit: Bool {
		password.utf16.count >= SignUpForm.minPasswordLength && !isBusy
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			AuthField(
				label: "Email", help: "The invitation is tied to this address.", isFocused: false
			) {
				Text(preview.inviteEmail)
					.frame(maxWidth: .infinity, alignment: .leading)
					.foregroundStyle(MaskinColor.ink4)
			}

			AuthField(label: "Your name", isFocused: focus == .name) {
				TextField("Ada Lovelace", text: $name)
					.focused($focus, equals: .name)
					.submitLabel(.next)
					.onSubmit { focus = .password }
					.autocorrectionDisabled()
					#if os(iOS)
						.textContentType(.name)
						.textInputAutocapitalization(.words)
					#endif
					.disabled(isBusy)
			}

			AuthField(
				label: "Password", help: "At least \(SignUpForm.minPasswordLength) characters.",
				isFocused: focus == .password
			) {
				passwordInput
			} trailing: {
				Button {
					showPassword.toggle()
					focus = .password
				} label: {
					Image(systemName: showPassword ? "eye.slash" : "eye")
						.foregroundStyle(MaskinColor.ink4)
						.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
						.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
				.accessibilityLabel(showPassword ? "Hide password" : "Show password")
			}

			Button(action: submit) {
				ZStack {
					Text("Create account and join").opacity(isBusy ? 0 : 1)
					if isBusy { ProgressView() }
				}
			}
			.buttonStyle(PrimaryActionButtonStyle())
			.disabled(!canSubmit)
			.accessibilityLabel(isBusy ? "Create account and join, working" : "Create account and join")
		}
	}

	private var passwordInput: some View {
		Group {
			if showPassword {
				TextField("Password", text: $password)
					.autocorrectionDisabled()
					#if os(iOS)
						.textInputAutocapitalization(.never)
					#endif
			} else {
				SecureField("Password", text: $password)
			}
		}
		.focused($focus, equals: .password)
		.submitLabel(.go)
		.onSubmit(submit)
		#if os(iOS)
			.textContentType(.newPassword)
		#endif
		.disabled(isBusy)
	}

	private func submit() {
		guard canSubmit else { return }
		onSubmit(name, password)
	}
}
