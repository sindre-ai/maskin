import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// "Updated 3 min ago" under a list. Only appears when what is on screen is not confirmed
/// current (it came from disk, or the last refresh failed) so a healthy screen stays quiet.
struct FreshnessLine: View {
	let freshness: Freshness
	let isOnline: Bool

	var body: some View {
		if freshness.isStale, freshness.updatedAt != nil {
			// Re-evaluates every 30 s so "just now" becomes "1 min ago" without a refetch.
			TimelineView(.periodic(from: .now, by: 30)) { context in
				if let label = freshness.label(now: context.date) {
					HStack(spacing: MaskinSpace.s3) {
						if !isOnline { Image(systemName: "wifi.slash").accessibilityHidden(true) }
						Text(isOnline ? label : "\(label) · Offline")
					}
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink3)
					.frame(maxWidth: .infinity)
					.padding(.vertical, MaskinSpace.s3)
					.accessibilityElement(children: .combine)
				}
			}
		}
	}
}

extension View {
	/// Shows the store's freshness unobtrusively at the bottom of a list screen, and nothing when
	/// the data is confirmed current:
	///
	///     List { … }.freshnessFooter(store.freshness, isOnline: sync.isOnline)
	public func freshnessFooter(_ freshness: Freshness, isOnline: Bool = true) -> some View {
		safeAreaInset(edge: .bottom, spacing: 0) {
			FreshnessLine(freshness: freshness, isOnline: isOnline)
		}
	}

	/// The app-wide offline notice, driven by `SyncCoordinator.isOnline`. Apply ONCE, at the shell
	/// (not per screen, which would stack banners):
	///
	///     MainShell(…).syncOfflineBanner(isOnline: sync.isOnline)
	public func syncOfflineBanner(isOnline: Bool) -> some View {
		safeAreaInset(edge: .top, spacing: 0) {
			OfflineBanner(isVisible: !isOnline)
				.padding(.horizontal, MaskinSpace.s8)
				.animation(MaskinMotion.standard, value: isOnline)
		}
	}
}
