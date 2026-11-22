import MaskinDesign
import MaskinUI
import SwiftUI

/// How the iPad Chats screen lays out its two columns, from the window's shape alone.
///
/// Landscape shows the list (430 pt) beside the thread. Portrait has room for only about 300 pt of
/// thread next to a 360 pt list, so once a chat is open the list steps aside and the panel button in
/// the thread's header brings it back. With no chat open the list shows.
enum ChatsPadLayout {
	static let landscapeListWidth: CGFloat = 430
	static let portraitListWidth: CGFloat = 360

	/// Portrait is a window taller than it is wide (this also covers a narrow split-screen window).
	static func isPortrait(_ size: CGSize) -> Bool { size.width < size.height }

	/// The list column's width: the most it takes, and what it asks for.
	static func listWidth(portrait: Bool) -> CGFloat {
		portrait ? portraitListWidth : landscapeListWidth
	}

	/// Which columns show when the window turns or a chat is opened or closed.
	static func visibility(portrait: Bool, hasSelection: Bool) -> NavigationSplitViewVisibility {
		portrait && hasSelection ? .detailOnly : .all
	}

	/// What the panel button does: hide the list when it shows, show it when it is hidden.
	static func toggled(_ current: NavigationSplitViewVisibility) -> NavigationSplitViewVisibility {
		current == .detailOnly ? .all : .detailOnly
	}
}

/// The one row at the top of the iPad Chats list: a search field with Display inside it, and the
/// "+" that starts a conversation, with the account avatar between them in portrait. There is no title
/// (the left bar already names the screen) and no second row of controls.
struct ChatsListHeader: View {
	@Binding var search: String
	/// The Display options differ from the defaults: the button tints, as the toolbar's did.
	let displayActive: Bool
	let onDisplay: () -> Void
	let onNew: () -> Void
	/// The account avatar left of "+", in portrait where no sidebar holds it. Nil hides it.
	var onAccount: (() -> Void)? = nil
	var accountName = ""
	var accountActorID: String? = nil

	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			HStack(spacing: MaskinSpace.s5) {
				Image(systemName: "magnifyingglass")
					.foregroundStyle(MaskinColor.ink4)
					.accessibilityHidden(true)
				TextField("Search chats", text: $search)
					.font(MaskinTypeface.sans(MaskinFontSize.t17, relativeTo: .body))
					.submitLabel(.search)
					.autocorrectionDisabled()
					#if os(iOS)
						.textInputAutocapitalization(.never)
					#endif
				if !search.isEmpty {
					Button {
						search = ""
					} label: {
						Image(systemName: "xmark.circle.fill").foregroundStyle(MaskinColor.ink5)
					}
					.buttonStyle(.plain)
					.accessibilityLabel("Clear")
				}
				Button(action: onDisplay) {
					Image(systemName: ShellActions.slidersSymbol)
						.maskinSymbol(MaskinFontSize.t16, weight: .semibold)
						.foregroundStyle(displayActive ? MaskinColor.sigInk : MaskinColor.ink)
						.frame(width: MaskinSpace.s14 + MaskinSpace.s2, height: MaskinSpace.s14 + MaskinSpace.s2)
						.background(Circle().fill(displayActive ? MaskinColor.sigTint : Color.clear))
						.contentShape(Circle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel(displayActive ? "Display, options changed" : "Display")
			}
			.padding(.horizontal, MaskinSpace.s9)
			.frame(height: MaskinSpace.touchMin)
			.maskinGlassCapsule(interactive: true)
			if let onAccount {
				ShellAccountButton(name: accountName, actorID: accountActorID, open: onAccount)
			}
			Button(action: onNew) {
				ShellInkCircle(symbol: "plus", label: "New conversation", filled: true)
			}
			.buttonStyle(.plain)
		}
		.padding(.horizontal, MaskinSpace.s9)
		// 44 pt of field plus 8 above and below: the 60 pt row.
		.padding(.vertical, MaskinSpace.s4)
	}
}
