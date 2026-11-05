import MaskinDesign
import SwiftUI

#if canImport(UIKit) && !os(watchOS) && !os(tvOS)
import UIKit

/// Blue tab-bar badges (the brand accent, `badgeSolid`, with `badgeFg` text, light and dark). A
/// system badge can't take a gradient or the prototype's white ring, so this is the closest native
/// match.
///
/// iOS 26's glass bar did not honour `UITabBarItem.appearance().badgeColor` alone (the badges stayed
/// system red), so three things are set and each is harmless where another already works:
/// - the item proxy, for bars created after this runs;
/// - `badgeColor` and the text attributes on every live `UITabBarItem` of the shell's
///   `UITabBarController`, re-applied whenever SwiftUI updates (badge counts change item state);
/// - the bar's own appearance, as a COPY of the current one with only the badge fields changed, so
///   the glass background is kept (assigning a fresh `UITabBarAppearance` would replace it).
@MainActor
enum TabBarBadgeStyle {
	private static var applied = false
	private static var color: UIColor { UIColor(MaskinGradient.badgeSolid) }
	private static var textAttributes: [NSAttributedString.Key: Any] { [.foregroundColor: UIColor(MaskinColor.badgeFg)] }

	static func applyOnce() {
		guard !applied else { return }
		applied = true
		let item = UITabBarItem.appearance()
		item.badgeColor = color
		item.setBadgeTextAttributes(textAttributes, for: .normal)
	}

	/// Styles a live tab bar controller's badges.
	static func apply(to controller: UITabBarController) {
		let color = color
		let text = textAttributes
		for item in controller.tabBar.items ?? [] {
			item.badgeColor = color
			item.setBadgeTextAttributes(text, for: .normal)
		}
		let bar = controller.tabBar
		for appearance in [bar.standardAppearance, bar.scrollEdgeAppearance].compactMap({ $0 }) {
			for layout in [appearance.stackedLayoutAppearance, appearance.inlineLayoutAppearance, appearance.compactInlineLayoutAppearance] {
				for state in [layout.normal, layout.selected] {
					state.badgeBackgroundColor = color
					state.badgeTextAttributes = text
				}
			}
		}
		bar.standardAppearance = bar.standardAppearance
		if let edge = bar.scrollEdgeAppearance { bar.scrollEdgeAppearance = edge }
	}
}

/// Finds the shell's `UITabBarController` and styles its badges. Put it in the tab view's
/// `.background`; it draws nothing.
struct TabBarBadgeStyler: UIViewControllerRepresentable {
	func makeUIViewController(context: Context) -> StylingController { StylingController() }
	func updateUIViewController(_ controller: StylingController, context: Context) { controller.style() }

	final class StylingController: UIViewController {
		override func viewDidAppear(_ animated: Bool) {
			super.viewDidAppear(animated)
			style()
		}

		func style() {
			var parent: UIViewController? = self
			while let current = parent {
				if let tabs = current as? UITabBarController {
					TabBarBadgeStyle.apply(to: tabs)
					return
				}
				parent = current.parent
			}
			// A hosting controller can sit beside the tab controller rather than under it.
			if let tabs = view.window?.rootViewController?.firstTabBarController {
				TabBarBadgeStyle.apply(to: tabs)
			}
		}
	}
}

extension UIViewController {
	fileprivate var firstTabBarController: UITabBarController? {
		if let tabs = self as? UITabBarController { return tabs }
		for child in children { if let found = child.firstTabBarController { return found } }
		return presentedViewController?.firstTabBarController
	}
}
#else
enum TabBarBadgeStyle {
	@MainActor static func applyOnce() {}
}
#endif
