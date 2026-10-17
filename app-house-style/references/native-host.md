# The native host: SwiftUI over the TypeScript core in headless Hermes

The pattern a reference app's `apps/ios` follows (read its README before building one). Swift holds no rule: a view renders a snapshot and
sends actions; a store decodes a snapshot; the host carries strings.

```
apps/ios/
  js/                       the bundle: the client library on the native platform
    index.ts                  entry: creates the client, connects the bridge, starts it
    nativePlatform.ts         client/src/platform.ts implemented over the native module
    specs/Native<App>Client.ts the native module, as React Native's codegen reads it
    probes/smoke.ts           the library in plain Hermes with a stand-in module
  scripts/
    bundle.mjs                Metro, then Hermes bytecode (main.jsbundle), and any data packs
    smoke.mjs                 runs probes/smoke.ts in a Hermes VM (runs on Linux)
    fixtures.ts               the library's real snapshots, for the Swift tests
    testflight.sh             on a Mac: build, sign, upload
  apple/
    <App>Kit/                 Swift package, no React Native in it: snapshots and actions
                              (Codable), the bridge endpoint, one observable store per client
                              store, and the screens
    Host/                     the runtime, the native module (Objective-C++), storage, platform
                              services (location, keychain, wake lock)
    iOS/                      the app: project.yml (XcodeGen), Podfile, icon
```

```
SwiftUI views ── read ──> SnapshotStore<...>            (<App>Kit)
      │ ClientAction            ▲ changed(store, snapshot JSON)
      ▼                         │
ClientStores ── BridgeEndpoint ── ClientHost             (<App>Kit, Host)
                                  │  numbered calls out, answers and changes in
                          native module (Objective-C++)
                                  │
                    headless React Native runtime, Hermes (no RN views)
                                  │
        js/index.ts: createClient(nativePlatform) + connectBridge (client/src/bridge.ts)
```

- The `Platform` interface in `client/src/platform.ts` is the only seam: storage (a JSON file
  in Application Support), clock, compute, keystore (Keychain, `ThisDeviceOnly`), location,
  wake lock, passkeys (`ASAuthorizationPlatformPublicKeyCredentialProvider`, PRF on iOS 18+).
- Keep the core's dependencies runnable in Hermes: no `TextEncoder`/`TextDecoder` reliance
  without a fallback, no `URLSearchParams` in portable code, pure-JS crypto (`@noble/*`).
- Checks without a Mac: `node scripts/smoke.mjs --hermes=<hermes>` and `swift test` in the Kit
  package on Linux (screens compile only where SwiftUI is). On a Mac, a UI-test screen tour
  screenshots every screen in light, dark and the largest text size before TestFlight.
- A whole wall screen shown inside the app is a `WKWebView` of the web page, not a re-drawn
  SwiftUI copy.
