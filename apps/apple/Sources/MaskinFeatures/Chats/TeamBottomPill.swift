import MaskinCore
import MaskinDesign
import MaskinUI
import Observation
import SwiftUI
#if canImport(UIKit)
	import UIKit
#endif

/// Where the Team filter chips sit. Chips only exist when Quick filters is on.
///
/// - `top`: the row at the top of the list (iPad, Mac, landscape, and every case below the
///   bottom pill's reach). Unchanged.
/// - `floating`: iPhone portrait before iOS 26.1. A glass pill floating above the normal tab bar;
///   the bar never folds.
/// - `accessory`: iPhone portrait on iOS 26.1 and later. The pill is the tab view's bottom
///   accessory, so the system puts it above the open bar and inline beside the folded one. The bar
///   folds on scroll down and opens on scroll up, on Team only.
enum TeamPillPlacement: Equatable {
	case top, floating, accessory

	@MainActor
	static func resolve(compactWidth: Bool, regularHeight: Bool) -> TeamPillPlacement {
		#if os(iOS)
			guard compactWidth, regularHeight, UIDevice.current.userInterfaceIdiom == .phone else { return .top }
			if #available(iOS 26.1, *) { return .accessory }
			return .floating
		#else
			return .top
		#endif
	}
}

/// What the shell's bottom accessory shows: the Team list's store, handed over by the Team screen
/// while it is on screen. The accessory lives on the tab view, the store on the Team screen.
@MainActor
@Observable
final class TeamPillModel {
	private(set) var store: ConversationsStore?
	@ObservationIgnored private(set) var onThreads: (() -> Void)?
	/// Unread conversations for the Unread chip, as the list counts them.
	var unreadCount = 0
	/// Row selection is on: the selection bar takes the bottom, so the pill steps aside.
	var isSelecting = false

	/// Whether the pill should be on screen: Quick filters is on and no selection is running.
	var isShown: Bool { store?.displayOptions.showsFilterChips == true && !isSelecting }

	func attach(store: ConversationsStore, onThreads: @escaping () -> Void) {
		self.store = store
		self.onThreads = onThreads
	}

	func detach(_ store: ConversationsStore) {
		guard self.store === store else { return }
		self.store = nil
		onThreads = nil
		isSelecting = false
	}
}

/// The pill's content as the tab view's bottom accessory. The system draws the glass capsule.
struct TeamBottomAccessory: View {
	let model: TeamPillModel

	var body: some View {
		if let store = model.store {
			TeamFilterChips(
				chip: Bindable(store).chip, unreadCount: model.unreadCount,
				threadsUnread: store.threadSections.unreadCount, onThreads: model.onThreads, onGlass: true)
		}
	}
}

/// The pill before iOS 26.1: the same chips on a glass capsule floating above the tab bar.
struct TeamFloatingPill: View {
	@Binding var chip: TeamFilterChip
	let unreadCount: Int
	var threadsUnread = 0
	var onThreads: (() -> Void)?

	var body: some View {
		TeamFilterChips(
			chip: $chip, unreadCount: unreadCount, threadsUnread: threadsUnread, onThreads: onThreads,
			onGlass: true
		)
		.padding(.vertical, MaskinSpace.s1)
		.maskinGlassCapsule()
		.padding(.horizontal, MaskinSpace.s7)
	}
}

/// The shell's tab bar rules. On iOS 26.1 and later, in iPhone portrait with Quick filters on, the
/// Team tab shows the filter pill as the bottom accessory and lets the bar fold on scroll down.
/// Every other tab, and Team with the pill off, keeps the bar open however far the content
/// scrolls. Before iOS 26.1 the bar is always open.
struct TeamFoldingTabBar: ViewModifier {
	let runtime: AppRuntime
	@Environment(\.horizontalSizeClass) private var horizontal
	@Environment(\.verticalSizeClass) private var vertical

	@ViewBuilder
	func body(content: Content) -> some View {
		#if os(iOS)
			if #available(iOS 26.1, *) {
				let placement = TeamPillPlacement.resolve(
					compactWidth: horizontal == .compact, regularHeight: vertical == .regular)
				let pill = placement == .accessory && runtime.selectedTab == .chats && runtime.teamPill.isShown
				content
					.tabBarMinimizeBehavior(pill ? .onScrollDown : .never)
					.tabViewBottomAccessory(isEnabled: pill) { TeamBottomAccessory(model: runtime.teamPill) }
			} else if #available(iOS 26, *) {
				content.tabBarMinimizeBehavior(.never)
			} else {
				content
			}
		#else
			content
		#endif
	}
}
