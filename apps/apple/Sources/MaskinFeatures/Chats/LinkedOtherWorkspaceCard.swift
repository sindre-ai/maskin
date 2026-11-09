import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The card for a link into another workspace: dashed, with a globe and one line, "{Kind} in
/// {workspace name}" when the reader belongs to that workspace and "{Kind} in another workspace"
/// when not. Nothing was fetched for it, so it says only what the address says. Tapping goes where
/// a push notification would (see `LinkedOpener`).
struct LinkedOtherWorkspaceCard: View {
	let link: LinkedOtherWorkspace
	@Environment(\.linkedItems) private var store
	private let open = LinkedOpener()

	private var workspaceName: String? { store?.workspaceName(for: link.workspaceID) }
	private var title: String { link.title(workspaceName: workspaceName) }

	var body: some View {
		Button { open(link.target) } label: {
			HStack(spacing: MaskinSpace.s5) {
				Image(systemName: "globe")
					.maskinSymbol(MaskinFontSize.t14, weight: .semibold)
					.foregroundStyle(MaskinColor.ink3)
					.accessibilityHidden(true)
				Text(title)
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
					.multilineTextAlignment(.leading)
				Spacer(minLength: 0)
			}
			.padding(.horizontal, MaskinSpace.s7)
			.padding(.vertical, MaskinSpace.s7)
			.frame(maxWidth: .infinity, alignment: .leading)
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
					.strokeBorder(MaskinSurface.line, style: StrokeStyle(lineWidth: 1, dash: [MaskinSpace.s2, MaskinSpace.s2]))
			)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel(title)
		.accessibilityHint(workspaceName == nil ? "" : "Opens in Maskin")
		.accessibilityAddTraits(.isLink)
	}
}
