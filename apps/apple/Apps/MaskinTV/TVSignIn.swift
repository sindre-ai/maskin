import MaskinCore
import MaskinDesign
import SwiftUI

/// Apple TV sign-in without typing: the TV shows a short code, the reader types it at the address
/// below on a phone or computer and approves it there. The email-and-password form stays one
/// press away for a server that does not issue codes.
struct TVSignIn: View {
	let auth: AuthSession
	@State private var store: TVDeviceCodeStore
	@State private var usePassword = false

	init(auth: AuthSession) {
		self.auth = auth
		_store = State(
			initialValue: TVDeviceCodeStore(
				source: APITVDeviceCodeSource(baseURL: GlanceConfig.apiBaseURL),
				onApproved: { login in
					try? auth.adopt(
						StoredSession(
							apiKey: login.apiKey, actorId: login.actorId, name: login.name, email: login.email,
							workspaceId: login.workspaceId))
				}))
	}

	var body: some View {
		if usePassword {
			GlanceLogin(auth: auth)
		} else {
			ZStack {
				TVBackdrop()
				VStack(spacing: 40) {
					Spacer(minLength: 0)
					content
					Spacer(minLength: 0)
					Button("Use email and password instead") { usePassword = true }
						.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 40))
						.font(.system(size: 28, weight: .medium))
						.foregroundStyle(MaskinColor.ink4)
						.padding(.bottom, 64)
				}
				.padding(.horizontal, 96)
			}
			.task { store.start() }
			.onDisappear { store.stop() }
		}
	}

	@ViewBuilder private var content: some View {
		switch store.phase {
		case .starting:
			ProgressView().scaleEffect(2)
		case .showing(let prompt):
			VStack(spacing: 28) {
				Text("Sign in on your phone or computer")
					.font(.system(size: 56, weight: .bold))
					.multilineTextAlignment(.center)
				Text("Go to \(prompt.verificationLabel) and type this code. Approve it only if it matches.")
					.font(.system(size: 32))
					.foregroundStyle(MaskinColor.ink3)
					.multilineTextAlignment(.center)
				Text(prompt.userCode)
					.font(.system(size: 120, weight: .bold, design: .monospaced))
					.foregroundStyle(MaskinColor.ink)
					.padding(.horizontal, 64).padding(.vertical, 24)
					.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 40, style: .continuous))
					.accessibilityLabel("Code \(prompt.userCode.map(String.init).joined(separator: " "))")
			}
		case .denied:
			VStack(spacing: 28) {
				Text("That sign-in was refused").font(.system(size: 56, weight: .bold))
				Text("Nobody is signed in on this TV.").font(.system(size: 32)).foregroundStyle(MaskinColor.ink3)
				Button { store.start() } label: { TVCapsuleLabel(title: "Get a new code", prominent: true) }
					.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
			}
		case .failed(let message):
			VStack(spacing: 28) {
				Text("Can't get a code").font(.system(size: 56, weight: .bold))
				Text(message).font(.system(size: 32)).foregroundStyle(MaskinColor.ink3).multilineTextAlignment(.center)
				Button { store.start() } label: { TVCapsuleLabel(title: "Try again", prominent: true) }
					.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
			}
		}
	}
}
