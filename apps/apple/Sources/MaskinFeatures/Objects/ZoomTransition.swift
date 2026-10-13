import SwiftUI

extension View {
	/// Marks a list row as the origin of a zoom into its detail (iOS 18+). Older systems and the
	/// Mac keep the plain push.
	@ViewBuilder
	func zoomSource(id: some Hashable, in namespace: Namespace.ID?) -> some View {
		#if os(iOS)
			if #available(iOS 18, *), let namespace {
				matchedTransitionSource(id: id, in: namespace)
			} else {
				self
			}
		#else
			self
		#endif
	}

	/// The pushed detail grows out of its row.
	@ViewBuilder
	func zoomDestination(id: some Hashable, in namespace: Namespace.ID?) -> some View {
		#if os(iOS)
			if #available(iOS 18, *), let namespace {
				navigationTransition(.zoom(sourceID: id, in: namespace))
			} else {
				self
			}
		#else
			self
		#endif
	}
}
