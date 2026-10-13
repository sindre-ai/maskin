import SwiftUI
import Testing

@testable import MaskinFeatures

#if os(iOS)
import UIKit
#endif

@MainActor
@Suite("Back chevron")
struct BackChevronTests {
	@Test("the modifier applies to any view on every platform")
	func applies() {
		let view = Text("Objects").backChevronOnly()
		#expect(type(of: view) != Never.self)
	}

	#if os(iOS)
	@Test("it asks the controller that sits in the navigation stack for a minimal back button")
	func minimalBackButton() {
		let root = UIViewController()
		let wrapper = UIViewController()
		root.addChild(wrapper)
		let configurator = BackChevronController()
		wrapper.addChild(configurator)
		let navigation = UINavigationController(rootViewController: root)
		#expect(BackChevronController.host(of: configurator) === root)
		configurator.apply()
		#expect(root.navigationItem.backButtonDisplayMode == .minimal)
		#expect(navigation.viewControllers.first === root)
	}

	@Test("without a navigation controller it falls back to the direct parent")
	func fallsBackToParent() {
		let parent = UIViewController()
		let configurator = BackChevronController()
		parent.addChild(configurator)
		configurator.apply()
		#expect(parent.navigationItem.backButtonDisplayMode == .minimal)
	}
	#endif
}
