import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

extension View {
	/// While Settings > Advanced > Preview forces a loading, empty or error state, shows that state
	/// in place of the tab. Without a preview it does nothing: the tab shows its real data.
	func tabStateOverride(_ tab: ShellTab) -> some View {
		modifier(TabStateOverride(tab: tab))
	}
}

private struct TabStateOverride: ViewModifier {
	let tab: ShellTab
	@AppStorage(StatePreview.screenKey) private var raw = ""

	func body(content: Content) -> some View {
		content.overlay {
			if let preview = StatePreview(rawValue: raw) {
				Group {
					switch preview {
					case .loading:
						ScrollView { LoadingSkeleton(rows: 4).padding(MaskinSpace.s9) }
					case .empty:
						let copy = TabStateCopy.empty(for: tab)
						EmptyState(symbol: copy.symbol, title: copy.title, message: copy.message, style: .circled) {
							EmptyView()
						}
					case .error:
						let copy = TabStateCopy.error(for: tab)
						EmptyState(symbol: copy.symbol, title: copy.title, message: copy.message, style: .circled) {
							Button("Try again") { raw = "" }.buttonStyle(.secondaryAction)
						}
					}
				}
				.frame(maxWidth: .infinity, maxHeight: .infinity)
				.ambientBackground()
				.accessibilityElement(children: .contain)
			}
		}
	}
}
