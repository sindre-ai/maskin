import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Choose a new password after tapping the link in the reset email: two fields and a save button.
/// Closing the sheet (or finishing) leaves the person on the sign-in screen.
struct ResetPasswordView: View {
	private enum Field { case password, confirmation }

	@State private var model: ResetPasswordModel
	@FocusState private var focus: Field?
	@Environment(\.dismiss) private var dismiss
	private let onDone: () -> Void

	init(model: ResetPasswordModel, onDone: @escaping () -> Void) {
		_model = State(initialValue: model)
		self.onDone = onDone
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s13) {
					VStack(alignment: .leading, spacing: MaskinSpace.s9) {
						Text("Choose a new password")
							.maskinText(.largeTitle)
							.foregroundStyle(MaskinColor.ink)
							.accessibilityAddTraits(.isHeader)
						Text("You'll sign in with it next.")
							.maskinText(.body)
							.foregroundStyle(MaskinColor.ink4)
					}
					form
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
					Button("Back to sign in") { dismiss() }
				}
			}
			.onAppear { focus = .password }
			.onChange(of: model.phase) { _, phase in
				if phase == .done { onDone() }
			}
		}
	}

	private var form: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			AuthField(label: "New password", isFocused: focus == .password) {
				SecureField("At least \(ResetPasswordModel.minPasswordLength) characters", text: $model.password)
					.focused($focus, equals: .password)
					.submitLabel(.next)
					.onSubmit { focus = .confirmation }
					#if os(iOS)
						.textContentType(.newPassword)
					#endif
					.disabled(model.isSaving)
			}

			AuthField(label: "Confirm password", problem: model.problem, isFocused: focus == .confirmation) {
				SecureField("Type it again", text: $model.confirmation)
					.focused($focus, equals: .confirmation)
					.submitLabel(.done)
					.onSubmit { submit() }
					#if os(iOS)
						.textContentType(.newPassword)
					#endif
					.disabled(model.isSaving)
			}

			Button(action: submit) {
				ZStack {
					Text("Set new password").opacity(model.isSaving ? 0 : 1)
					if model.isSaving { ProgressView() }
				}
			}
			.buttonStyle(PrimaryActionButtonStyle())
			.disabled(!model.canSubmit)
			.keyboardShortcut(.defaultAction)
			.accessibilityLabel(model.isSaving ? "Set new password, working" : "Set new password")
		}
	}

	private func submit() {
		Task { await model.submit() }
	}
}
