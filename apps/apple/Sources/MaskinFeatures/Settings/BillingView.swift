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
				if let banner = Self.trialBanner(usage) {
					TrialBanner(title: banner.title, detail: banner.detail, actionTitle: manageURL == nil ? nil : "Choose") {
						if let manageURL { openURL(manageURL) }
					}
				}
				PageGroupLabel(text: "Plan")
				PageCard(rows: rows(usage))
				if let cap = usage.capCents, let fraction = usage.usedFraction {
					UsageMeter(
						title: "Credits this month", used: BillingUsage.dollars(usage.usedCents),
						of: BillingUsage.dollars(cap), fraction: fraction)
					if let manageURL {
						Button("Buy credits") { openURL(manageURL) }.buttonStyle(.secondaryAction)
					}
				}
				PageFootnote(
					text: "Usage by model, agent and flow is not in the app yet. This is a summary of your plan and this period's usage.")
				if let manageURL, usage.usedFraction == nil {
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
				id: "plan", title: "Plan",
				subtitle: [usage.statusLabel, usage.resetsText].compactMap { $0 }.joined(separator: " · "),
				accessory: .state(PageState(usage.planLabel, healthy ? .active : .muted)))
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
		// Invoices, auto top-up and the credit balance have no usable API field yet (the balance has
		// no currency), so those rows stay hidden.
		return rows
	}
}

extension BillingView {
	/// "Trial ends in 5 days" while on a trial; nil on any paid plan.
	static func trialBanner(_ usage: BillingUsage) -> (title: String, detail: String)? {
		guard usage.plan == "trial", usage.status == .active else { return nil }
		let detail = "Choose a plan to keep agents running."
		guard let ms = usage.resetsInMs, ms > 0 else { return ("Your trial has ended", detail) }
		let days = Int((Double(ms) / 86_400_000).rounded(.up))
		return ("Trial ends in \(days) \(days == 1 ? "day" : "days")", detail)
	}
}

/// The trial notice at the top of Billing (the same words the app-wide banner uses).
private struct TrialBanner: View {
	let title: String
	let detail: String
	let actionTitle: String?
	let action: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s8) {
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(title)
					.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: MaskinFontWeight.semibold))
					.foregroundStyle(MaskinColor.ink)
				Text(detail)
					.font(MaskinTypeface.sans(MaskinFontSize.t13))
					.foregroundStyle(MaskinColor.ink3)
			}
			Spacer(minLength: MaskinSpace.s4)
			if let actionTitle {
				Button(actionTitle, action: action).buttonStyle(.secondaryAction)
			}
		}
		.padding(MaskinSpace.s9)
		.background(MaskinColor.noticeBg, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.accessibilityElement(children: .combine)
	}
}

/// A used-of-total line with a bar underneath.
private struct UsageMeter: View {
	let title: String
	let used: String
	let of: String
	let fraction: Double

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			Text(title).maskinText(.microLabelLarge).textCase(.uppercase).foregroundStyle(MaskinColor.ink4)
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
				Text(used)
					.font(MaskinTypeface.sans(MaskinFontSize.t20, weight: MaskinFontWeight.semibold))
					.foregroundStyle(MaskinColor.ink)
				Text("of \(of)")
					.font(MaskinTypeface.sans(MaskinFontSize.t14))
					.foregroundStyle(MaskinColor.ink4)
			}
			ProgressView(value: fraction)
				.tint(fraction >= 0.9 ? MaskinColor.noticeFg3 : MaskinColor.sig)
		}
		.padding(MaskinSpace.s9)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.accessibilityElement(children: .combine)
		.accessibilityValue("\(Int(fraction * 100)) percent used")
	}
}
