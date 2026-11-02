import MaskinDesign
import SwiftUI

#if canImport(UIKit) && !os(watchOS) && !os(tvOS)
import UIKit

/// Patina tab-bar badges: the mid colour of `MaskinGradient.badge` as a flat fill with `badgeFg`
/// text, in light and dark. A system badge can't take a gradient or the prototype's white ring, so
/// this is the closest native match.
///
/// It sets the `UITabBarItem` appearance proxy rather than a whole `UITabBarAppearance`: assigning a
/// bar appearance replaces the bar's background and would drop the system (glass) bar look, while
/// the item proxy only touches the badge. Whether iOS 26's glass bar honours the proxy is not
/// verified on a device; if it ignores it the badge stays system red, which is still legible.
@MainActor
enum TabBarBadgeStyle {
	private static var applied = false

	static func applyOnce() {
		guard !applied else { return }
		applied = true
		let item = UITabBarItem.appearance()
		item.badgeColor = UIColor(MaskinGradient.badgeSolid)
		item.setBadgeTextAttributes(
			[.foregroundColor: UIColor(MaskinColor.badgeFg)], for: .normal)
	}
}
#else
enum TabBarBadgeStyle {
	@MainActor static func applyOnce() {}
}
#endif
