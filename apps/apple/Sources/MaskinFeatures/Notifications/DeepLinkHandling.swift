import MaskinCore
import SwiftUI

extension View {
	/// Feeds incoming URLs (custom scheme and universal links) to `router` and calls `perform`
	/// whenever a link is ready to navigate to (workspace already switched). Apply once, to the
	/// signed-in shell:
	///
	///     MainShell(...)
	///         .environment(router)
	///         .handlesDeepLinks(router) { link in /* select tab, push id */ }
	public func handlesDeepLinks(
		_ router: DeepLinkRouter, perform: @escaping (DeepLink) -> Void
	) -> some View {
		modifier(DeepLinkHandling(router: router, perform: perform))
	}
}

private struct DeepLinkHandling: ViewModifier {
	let router: DeepLinkRouter
	let perform: (DeepLink) -> Void

	func body(content: Content) -> some View {
		content
			.onOpenURL { router.open($0) }
			.onChange(of: router.pending, initial: true) {
				if let link = router.consume() { perform(link) }
			}
	}
}
