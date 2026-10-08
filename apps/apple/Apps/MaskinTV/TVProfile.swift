import MaskinCore
import MaskinDesign
import SwiftUI

/// The account on the big screen: who is signed in, the workspace (switching resets the app to For
/// you), and Log out. Everything else about the account is handled on the phone.
struct TVProfile: View {
	let environment: AppEnvironment
	@State private var confirmingLogOut = false

	var body: some View {
		let workspaces = environment.workspaces
		ScrollView {
			VStack(alignment: .leading, spacing: 36) {
				Text("Profile").font(.system(size: 64, weight: .bold))
				if let session = environment.auth.session {
					VStack(alignment: .leading, spacing: 8) {
						Text(session.name).font(.system(size: 40, weight: .bold))
						if let email = session.email {
							Text(email).font(.system(size: 28)).foregroundStyle(MaskinColor.ink4)
						}
					}
				}
				Text("WORKSPACE")
					.font(.system(size: 24, weight: .semibold, design: .monospaced)).foregroundStyle(MaskinColor.ink4)
				VStack(spacing: 20) {
					ForEach(workspaces.workspaces) { workspace in
						Button { workspaces.select(workspace.id) } label: {
							HStack {
								Text(workspace.name).font(.system(size: 32, weight: .semibold))
								Spacer(minLength: 0)
								if workspace.id == workspaces.selectedID {
									Image(systemName: "checkmark").font(.system(size: 30, weight: .bold))
								}
							}
							.padding(.horizontal, 36).frame(maxWidth: .infinity, minHeight: 96)
							.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
						}
						.buttonStyle(TVFocusStyle(scale: 1.03, cornerRadius: 28))
					}
				}
				Button { confirmingLogOut = true } label: {
					TVCapsuleLabel(title: "Log out", symbol: "rectangle.portrait.and.arrow.right")
				}
				.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
				.frame(maxWidth: 560)
				.padding(.top, 16)
			}
			.padding(.horizontal, 96)
			.padding(.top, 56)
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.confirmationDialog("Log out of Maskin?", isPresented: $confirmingLogOut, titleVisibility: .visible) {
			Button("Log out", role: .destructive) { environment.signOut() }
			Button("Cancel", role: .cancel) {}
		}
	}
}
