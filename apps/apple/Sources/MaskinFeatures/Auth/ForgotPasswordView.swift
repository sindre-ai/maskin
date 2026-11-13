import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Reset your password: one email field and a send button. After a send it shows the same line for
/// every email. The emailed link opens the web page where the new password is chosen.
struct ForgotPasswordView: View {
	@State private var model: ForgotPasswordModel
	@FocusState private var emailFocused: Bool
	@Environment(\.dismiss) private var dismiss

	init(model: ForgotPasswordModel) {
		_model = State(initialValue: model)
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s13) {
					VStack(alignment: .leading, spacing: MaskinSpace.s9) {
						Text("Reset your password")
							.maskinText(.largeTitle)
							.foregroundStyle(MaskinColor.ink)
							.accessibilityAddTraits(.isHeader)
						Text("Enter your email and we'll send you a link.")
							.maskinText(.body)
							.foregroundStyle(MaskinColor.ink4)
					}

					if model.phase == .sent {
						Text(ForgotPasswordModel.sentMessage)
							.maskinText(.body)
							.foregroundStyle(MaskinColor.ink)
							.accessibilityIdentifier("forgot-password-sent")
					} else {
						form
					}
				}
				.padding(.horizontal, MaskinSpace.s12)
				.padding(.vertical, MaskinSpace.s14)
				.frame(maxWidth: 440, alignment: .leading)
				.frame(maxWidth: .infinity)
			}
			.scrollDismissesKeyboard(.interactively)
			.ambientBackground()
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button(model.phase == .sent ? "Done" : "Cancel") { dismiss() }
				}
			}
			.onAppear { emailFocused = true }
		}
	}

	private var form: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			AuthField(label: "Email", problem: problem, isFocused: emailFocused) {
				TextField("you@company.com", text: $model.email)
					.focused($emailFocused)
					.submitLabel(.send)
					.onSubmit { submit() }
					.textContentType(.username)
					.autocorrectionDisabled()
					#if os(iOS)
						.keyboardType(.emailAddress)
						.textInputAutocapitalization(.never)
					#endif
					.disabled(model.isSending)
			}

			Button(action: submit) {
				ZStack {
					Text("Send reset link").opacity(model.isSending ? 0 : 1)
					if model.isSending { ProgressView() }
				}
			}
			.buttonStyle(PrimaryActionButtonStyle())
			.disabled(!model.canSubmit || model.isSending)
			.keyboardShortcut(.defaultAction)
			.accessibilityLabel(model.isSending ? "Send reset link, working" : "Send reset link")
		}
	}

	private var problem: String? {
		if case .failed(let message) = model.phase { return message }
		return nil
	}

	private func submit() {
		Task { await model.submit() }
	}
}
