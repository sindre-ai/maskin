import MaskinCore
import MaskinDesign
import SwiftUI

/// The leading checkbox a row shows while a list is in selection mode. Ink, not a brand colour.
struct SelectionCheckbox: View {
	let isPicked: Bool

	var body: some View {
		Image(systemName: isPicked ? "checkmark.circle.fill" : "circle")
			.font(.title3)
			.foregroundStyle(isPicked ? MaskinColor.ink : MaskinColor.ink4)
			.accessibilityHidden(true)
	}
}

extension View {
	/// Marks the row as a selection-mode toggle for assistive tech.
	func selectionRowAccessibility(isActive: Bool, isPicked: Bool) -> some View {
		accessibilityAddTraits(isActive && isPicked ? .isSelected : [])
	}

	/// Selection mode's chrome: a text "Done" in the top bar (only while selecting, so it adds no
	/// standing icon), the bar below with the count and actions, and the tab bar out of the way.
	func selectionToolbar<Actions: View>(
		_ selection: SelectionModel, allIDs: [String], noun: String,
		@ViewBuilder actions: @escaping () -> Actions
	) -> some View {
		modifier(SelectionToolbar(selection: selection, allIDs: allIDs, noun: noun, actions: actions))
	}
}

#if os(iOS)
private struct HideTabBar: ViewModifier {
	let hidden: Bool

	func body(content: Content) -> some View {
		if #available(iOS 18.0, *) {
			content.toolbarVisibility(hidden ? .hidden : .automatic, for: .tabBar)
		} else {
			content
		}
	}
}
#endif

private struct SelectionToolbar<Actions: View>: ViewModifier {
	let selection: SelectionModel
	let allIDs: [String]
	let noun: String
	@ViewBuilder let actions: () -> Actions

	func body(content: Content) -> some View {
		#if os(iOS)
		content
			.toolbar {
				if selection.isActive {
					ToolbarItem(placement: .topBarTrailing) {
						Button("Done") { selection.exit() }
							.fontWeight(.semibold)
							.tint(MaskinColor.ink)
					}
					ToolbarItemGroup(placement: .bottomBar) {
						Button(selection.isAllSelected(of: allIDs) ? "Select none" : "Select all") {
							if selection.isAllSelected(of: allIDs) {
								selection.clear()
							} else {
								selection.selectAll(allIDs)
							}
						}
						Spacer()
						Text(Self.count(selection.count, noun: noun))
							.font(.footnote)
							.foregroundStyle(MaskinColor.ink3)
						Spacer()
						actions()
					}
				}
			}
			.tint(MaskinColor.ink)
			.modifier(HideTabBar(hidden: selection.isActive))
		#else
		content
		#endif
	}

	static func count(_ n: Int, noun: String) -> String {
		n == 0 ? "Select \(noun)s" : "\(n) selected"
	}
}
