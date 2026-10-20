import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Billing (2C): the plan, its state and this period's usage, read-only. Owners get the mockup's
/// "Manage on web" button; there is no in-app purchase. Whether App Review 3.1.1 accepts that link
/// is the open question from the D2 report: pass `manageURL: nil` to drop it.
struct BillingView: View {
	@State private var store: BillingStore
	@Environment(\.openURL) private var openURL
	/// The web billing page, set only for owners (2C: non-owners see the summary without the button).
	private let manageURL: URL?

	init(store: BillingStore, manageURL: URL? = nil) {
		_store = State(initialValue: store)
		self.manageURL = manageURL
	}

	var body: some View {
		WorkspacePage(title: "Billing") {
			if let usage = store.usage {
				PageGroupLabel(text: "Plan")
				PageCard(rows: rows(usage))
				if usage.creditBalanceCents > 0 {
					PageCard(rows: [
						PageRowModel(
							id: "credits", title: "Credits",
							subtitle: "Left to use after your allowance",
							accessory: .state(PageState(BillingUsage.dollars(usage.creditBalanceCents), .plain)))
					])
				}
				PageFootnote(text: "This is a summary of your plan and this period's usage.")
				if let manageURL {
					Button("Manage on web") { openURL(manageURL) }.buttonStyle(.primaryAction)
				}
			} else {
				switch store.phase {
				case .failed(let message): PageStatus(text: message)
				default: PageStatus(text: "Loading your plan")
				}
			}
		}
		.task { await store.load() }
		.refreshable { await store.load() }
	}

	private func rows(_ usage: BillingUsage) -> [PageRowModel] {
		let healthy = usage.status == .active
		var rows = [
			PageRowModel(
				id: "plan", title: usage.planLabel,
				subtitle: usage.resetsText ?? "Your current plan",
				accessory: .state(PageState(usage.statusLabel, healthy ? .active : .muted)))
		]
		let spent = BillingUsage.dollars(usage.usedCents)
		if let fraction = usage.usedFraction, let cap = usage.capCents {
			rows.append(
				PageRowModel(
					id: "usage", title: "Agent usage",
					subtitle: "\(spent) of \(BillingUsage.dollars(cap)) this period",
					accessory: .state(PageState("\(Int(fraction * 100))%", .plain))))
		} else {
			rows.append(
				PageRowModel(
					id: "usage", title: "Agent usage", subtitle: "This period",
					accessory: .state(PageState(spent, .plain))))
		}
		return rows
	}
}
