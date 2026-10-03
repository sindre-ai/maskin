// swift-tools-version: 6.0
import PackageDescription

// One local package, thin app targets (see Apps/). All business logic and shared UI live
// here so iOS, iPadOS, macOS, watchOS and tvOS reuse the same code.
let package = Package(
	name: "MaskinKit",
	platforms: [.iOS(.v17), .macOS(.v14), .watchOS(.v10), .tvOS(.v17)],
	products: [
		.library(name: "MaskinDesign", targets: ["MaskinDesign"]),
		.library(name: "MaskinAPI", targets: ["MaskinAPI"]),
		.library(name: "MaskinCore", targets: ["MaskinCore"]),
		.library(name: "MaskinUI", targets: ["MaskinUI"]),
		.library(name: "MaskinFeatures", targets: ["MaskinFeatures"]),
	],
	dependencies: [
		// Only the generator CLI (scripts/gen-api.sh runs it); no target uses its build plugin.
		.package(url: "https://github.com/apple/swift-openapi-generator", from: "1.6.0"),
		.package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.8.0"),
		.package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.1.0"),
	],
	targets: [
		// Tokens are generated from the design-system CSS: scripts/gen-tokens.mjs.
		.target(name: "MaskinDesign"),
		.testTarget(name: "MaskinDesignTests", dependencies: ["MaskinDesign"]),

		// Client generated from openapi.json (a snapshot of GET /api/openapi.json,
		// see apps/dev/scripts/dump-openapi.ts) filtered to the paths in
		// openapi-generator-config.yaml. The output is CHECKED IN under Generated/ — regenerate with
		// scripts/gen-api.sh — rather than built by the SwiftPM plugin: a build-tool plugin shared by
		// the iOS app and its embedded watch app collides in Xcode's intermediates.
		.target(
			name: "MaskinAPI",
			dependencies: [
				.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
				.product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
			],
			exclude: ["openapi.json", "openapi-generator-config.yaml"]
		),
		.testTarget(name: "MaskinAPITests", dependencies: ["MaskinAPI"]),

		// Stores and session state. No UI imports, so watchOS / tvOS / macOS targets share it.
		.target(name: "MaskinCore", dependencies: ["MaskinAPI"]),
		.testTarget(name: "MaskinCoreTests", dependencies: ["MaskinCore"]),

		// Shared SwiftUI components (badges, avatars, markdown, empty states...). Pure view code,
		// no networking: everything arrives as plain values so it previews and snapshots easily.
		.target(name: "MaskinUI", dependencies: ["MaskinDesign"]),
		.testTarget(name: "MaskinUITests", dependencies: ["MaskinUI"]),

		// Screens. One folder per feature; stores come from MaskinCore.
		.target(
			name: "MaskinFeatures",
			dependencies: ["MaskinCore", "MaskinUI", "MaskinDesign", "MaskinAPI"]),
		.testTarget(name: "MaskinFeaturesTests", dependencies: ["MaskinFeatures"]),
	]
)
