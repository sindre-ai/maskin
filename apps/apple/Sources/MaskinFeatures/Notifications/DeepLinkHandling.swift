import MaskinCore
import SwiftUI

extension View {
	/// Feeds incoming URLs (custom scheme and universal links) to `router` and calls `perform`
	/// whenever a link is ready to navigate to (workspace already switched). `intercept` sees each URL
	/// first and returns true for one it handled itself (an invitation), keeping it from the router. Apply once, to the
	/// signed-in shell:
	///
	///     MainShell(...)
	///         .environment(router)
	///         .handlesDeepLinks(router) { link in /* select tab, push id */ }
	public func handlesDeepLinks(
		_ router: DeepLinkRouter, intercept: @escaping (URL) -> Bool = { _ in false },
		perform: @escaping (DeepLink) -> Void
	) -> some View {
		modifier(DeepLinkHandling(router: router, intercept: intercept, perform: perform))
	}
}

private struct DeepLinkHandling: ViewModifier {
	let router: DeepLinkRouter
	let intercept: (URL) -> Bool
	let perform: (DeepLink) -> Void

	func body(content: Content) -> some View {
		content
			.onOpenURL { url in if !intercept(url) { router.open(url) } }
			.onChange(of: router.pending, initial: true) {
				if let link = router.consume() { perform(link) }
			}
	}
}
