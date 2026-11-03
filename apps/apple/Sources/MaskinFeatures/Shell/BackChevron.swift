import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

extension View {
	/// Pushed screens show an arrow-only back button: no "Back", no previous title. Apply it to
	/// every screen in a `NavigationStack` (the root and each pushed screen), because UIKit reads
	/// the back button's style from the screen *below* the one being shown. `shellToolbar` applies
	/// it to every root for you; pushed screens that push further add it themselves.
	///
	/// Native: it sets `UINavigationItem.backButtonDisplayMode = .minimal` on the hosting
	/// controller, so the system chevron, its 44pt hit target, the long-press history menu and
	/// the interactive swipe-back all keep working. No-op off iOS.
	public func backChevronOnly() -> some View {
		#if os(iOS)
			return background(BackChevronConfigurator().frame(width: 0, height: 0).accessibilityHidden(true))
		#else
			return self
		#endif
	}
}

#if os(iOS)
/// Finds the UIKit controller that stands in the navigation stack for this SwiftUI screen and
/// asks for a minimal back button. Re-applied on every appearance, since SwiftUI can swap the
/// hosting controller's parents around.
private struct BackChevronConfigurator: UIViewControllerRepresentable {
	func makeUIViewController(context: Context) -> BackChevronController { BackChevronController() }
	func updateUIViewController(_ controller: BackChevronController, context: Context) { controller.apply() }
}

final class BackChevronController: UIViewController {
	override func viewDidLoad() {
		super.viewDidLoad()
		view.isUserInteractionEnabled = false
		view.backgroundColor = .clear
	}

	override func didMove(toParent parent: UIViewController?) {
		super.didMove(toParent: parent)
		apply()
	}

	override func viewWillAppear(_ animated: Bool) {
		super.viewWillAppear(animated)
		apply()
	}

	/// The controller whose `navigationItem` the navigation bar reads: the nearest ancestor that
	/// sits directly in the navigation controller, else the direct parent.
	func apply() {
		Self.configure(hostOf: self)
	}

	static func configure(hostOf controller: UIViewController) {
		guard let host = host(of: controller) else { return }
		host.navigationItem.backButtonDisplayMode = .minimal
	}

	static func host(of controller: UIViewController) -> UIViewController? {
		var current = controller.parent
		while let candidate = current {
			if let stack = candidate.navigationController?.viewControllers, stack.contains(candidate) {
				return candidate
			}
			current = candidate.parent
		}
		return controller.parent
	}
}
#endif
