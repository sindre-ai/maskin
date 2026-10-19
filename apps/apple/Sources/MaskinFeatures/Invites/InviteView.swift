import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The screen a workspace invitation link opens: who invited you, to what, as what, and until when,
/// then Accept or Decline. Works signed out (the preview needs no account): the primary action is
/// then "Sign in to accept". Only names are shown, never ids.
public struct InviteView: View {
	let store: InviteStore
	/// Closes the screen and forgets the invite (Decline, or done).
	let onFinish: () -> Void
	/// Closes the screen but keeps the invite for after sign-in.
	let onSignIn: () -> Void
	let onClose: () -> Void

	public init(
		store: InviteStore, onFinish: @escaping () -> Void, onSignIn: @escaping () -> Void,
		onClose: @escaping () -> Void
	) {
		self.store = store
		self.onFinish = onFinish
		self.onSignIn = onSignIn
		self.onClose = onClose
	}

	public var body: some View {
		NavigationStack {
			Group {
				switch store.phase {
				case .loading:
					ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
				case .failed(let failure) where store.preview == nil:
					EmptyState(symbol: "envelope.badge", title: "Can't open this invitation", message: failure.message) {
						if failure.isRetryable {
							Button("Try again") { Task { await store.retry() } }
								.buttonStyle(.secondaryAction)
						}
					}
				default:
					if let preview = store.preview { details(preview) }
				}
			}
			.ambientBackground()
			.navigationTitle("Invitation")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Close", action: onClose) }
			}
		}
		.task { await store.load() }
		.onChange(of: store.phase) { _, phase in
			if case .accepted = phase { MaskinHaptics.play(.success) }
		}
		.presentationDetents([.large])
	}

	private func details(_ preview: InvitePreview) -> some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s11) {
				VStack(alignment: .leading, spacing: MaskinSpace.s5) {
					Text("\(preview.inviterName) invited you to join")
						.maskinText(.body)
						.foregroundStyle(MaskinColor.ink4)
					Text(preview.workspaceName)
						.maskinText(.largeTitle)
						.foregroundStyle(MaskinColor.ink)
						.accessibilityAddTraits(.isHeader)
				}
				card(preview)
				actions(preview)
			}
			.padding(.horizontal, MaskinSpace.s12)
			.padding(.vertical, MaskinSpace.s11)
			.frame(maxWidth: 520)
			.frame(maxWidth: .infinity)
		}
	}

	private func card(_ preview: InvitePreview) -> some View {
		VStack(alignment: .leading, spacing: 0) {
			row("Role", preview.roleLabel)
			Divider()
			row("Invited as", preview.inviteEmail)
			Divider()
			row("Expires", preview.expiresAt.formatted(date: .abbreviated, time: .shortened))
		}
		.background(MaskinColor.surfaceAlt, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		.accessibilityElement(children: .contain)
	}

	private func row(_ title: String, _ value: String) -> some View {
		HStack(alignment: .firstTextBaseline) {
			Text(title).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			Spacer(minLength: MaskinSpace.s8)
			Text(value).maskinText(.subhead).foregroundStyle(MaskinColor.ink)
				.multilineTextAlignment(.trailing)
		}
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.vertical, MaskinSpace.s8)
		.accessibilityElement(children: .combine)
	}

	@ViewBuilder
	private func actions(_ preview: InvitePreview) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			if case .failed(let failure) = store.phase { FormError(failure.message) }
			if store.requiresSignIn {
				signedOutActions(preview)
			} else if store.phase == .confirmingMismatch {
				mismatchActions(preview)
			} else {
				Button {
					Task { await store.accept() }
				} label: {
					ZStack {
						Text("Accept and join").opacity(store.phase == .accepting ? 0 : 1)
						if store.phase == .accepting { ProgressView() }
					}
				}
				.buttonStyle(PrimaryActionButtonStyle())
				.disabled(store.phase == .accepting || !canAccept)
				Button("Decline", action: onFinish)
					.buttonStyle(.secondaryAction)
					.disabled(store.phase == .accepting)
				if case .failed(let failure) = store.phase, failure.isRetryable {
					Text("Your invitation is still valid. You can try again.")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
		.onChange(of: store.phase) { _, phase in
			if case .accepted = phase { onFinish() }
		}
	}

	/// A failure that ends the invitation (seat cap, expired) leaves nothing to accept until the
	/// cause is fixed; a retryable one or a fresh screen can accept.
	private var canAccept: Bool {
		if case .failed(let failure) = store.phase { return failure.isRetryable || failure == .seatCap }
		return true
	}

	private func signedOutActions(_ preview: InvitePreview) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			Button("Sign in to accept", action: onSignIn).buttonStyle(PrimaryActionButtonStyle())
			// FE-2 HOOK POINT: `store.createAccount` is set once native sign-up exists.
			if let createAccount = store.createAccount {
				Button("Create an account") { createAccount(preview) }.buttonStyle(.secondaryAction)
			} else {
				Text("Don't have an account yet? Create one on maskin.io with \(preview.inviteEmail), then open this invitation link again.")
					.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
		}
	}

	private func mismatchActions(_ preview: InvitePreview) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			Text("This invitation was sent to \(preview.inviteEmail), but you're signed in as \(store.signedInEmail ?? "another account"). Join \(preview.workspaceName) with this account anyway?")
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink)
				.padding(MaskinSpace.s8)
				.frame(maxWidth: .infinity, alignment: .leading)
				.background(MaskinColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
			Button("Join with this account") { Task { await store.accept(confirmedMismatch: true) } }
				.buttonStyle(PrimaryActionButtonStyle())
			Button("Go back") { store.cancelMismatch() }.buttonStyle(.secondaryAction)
		}
	}
}
