import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Plan and usage, read-only. No purchase or link-out: App Review 3.1.1 forbids pointing to
/// external purchasing, so plan changes and credits are handled on the web, outside the app.
struct BillingView: View {
	@State private var store: BillingStore
	init(store: BillingStore) {
		_store = State(initialValue: store)
	}

	var body: some View {
		List {
			if let usage = store.usage {
				Section {
					VStack(alignment: .leading, spacing: MaskinSpace.s4) {
						Text(usage.planLabel).maskinText(.title).foregroundStyle(MaskinColor.ink)
						Text(usage.statusLabel).maskinText(.subhead)
							.foregroundStyle(usage.status == .active ? MaskinColor.ink4 : MaskinColor.warning)
					}
					.padding(.vertical, MaskinSpace.s4)
					.accessibilityElement(children: .combine)
				}
				Section {
					VStack(alignment: .leading, spacing: MaskinSpace.s7) {
						HStack(alignment: .firstTextBaseline) {
							Text(BillingUsage.dollars(usage.usedCents)).maskinText(.title)
								.foregroundStyle(MaskinColor.ink)
							if let cap = usage.capCents {
								Text("of \(BillingUsage.dollars(cap))").maskinText(.subhead)
									.foregroundStyle(MaskinColor.ink4)
							}
						}
						if let fraction = usage.usedFraction {
							ProgressView(value: fraction)
								.tint(fraction >= 0.9 ? MaskinColor.warning : MaskinColor.ink)
								.accessibilityLabel("Usage")
								.accessibilityValue("\(Int(fraction * 100)) percent")
						}
						if let resets = usage.resetsText {
							Text(resets).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
						}
					}
					.padding(.vertical, MaskinSpace.s4)
					.accessibilityElement(children: .combine)
				} header: {
					Text("Usage this period")
				}
				if usage.creditBalanceCents > 0 {
					Section("Credits") {
						LabeledContent("Balance", value: BillingUsage.dollars(usage.creditBalanceCents))
							.frame(minHeight: MaskinSpace.touchMin)
					}
				}
			}
		}
		.settingsListStyle()
		.overlay {
			switch store.phase {
			case .loading: ProgressView()
			case .failed(let message) where store.usage == nil:
				ContentUnavailableView(
					"Couldn't load your plan", systemImage: "wifi.exclamationmark",
					description: Text(message))
			default: EmptyView()
			}
		}
		.navigationTitle("Plan and usage")
		#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
		#endif
		.task { await store.load() }
		.refreshable { await store.load() }
	}
}
