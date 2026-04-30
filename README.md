# react-native-nitro-bluetooth-le-scan

High-performance, Nitro-powered Bluetooth runtime for React Native.

`react-native-nitro-bluetooth-le-scan` is built for teams shipping latency-sensitive Bluetooth workloads where throughput, determinism, and production operability matter. It combines native execution paths, typed runtime contracts, event-driven GATT orchestration, and observability primitives that turn field failures into actionable diagnostics.

## Value In 30 Seconds

If you need React Native Bluetooth that is:

- **high-throughput** under noisy RF environments,
- **predictable** across Android/iOS lifecycle differences,
- **observable** with operation-level metrics and traces,
- **extensible** for scanner, GATT, and domain-specific workflows,

this module is designed for that exact outcome.

Design priority: `Performance + Reliability > API clarity > DX`.

## Why This Is Different

Most BLE integrations degrade at scale because they optimize only happy-path demos. This library explicitly addresses:

- permission and adapter-state complexity,
- event storm/backpressure control,
- GATT sequencing and in-flight contention risks,
- production incident forensics with insufficient telemetry.

New in `1.0.0`: GATT `discover/read/write/notify` now run through a fully event-driven native pipeline (no blocking waits), while preserving Promise-based JS ergonomics.

## Feature Matrix By Phase

| Phase | Focus | What You Get |
| --- | --- | --- |
| 1 | Foundation scan | Lifecycle APIs, permissions/adapters, filter/coalescing, snapshot counters |
| 2 | Device intelligence | RSSI smoothing, distance estimate, ranking, manufacturer parser plugins |
| 3 | Connection-ready | Connect/disconnect, service discovery, read/write, notification toggles |
| 4 | Hardening | Non-blocking connect, op queue, instrumentation, QA fault injection, health report + trace |
| 5 | DX moat | React hooks, scaffold command, diagnostics command, cookbook recipes |

## Performance Architecture

This module is tuned for production Bluetooth workloads, not demo-path behavior.

- **Event-driven native GATT:** callback-driven completion removes blocking waits from the operation hot path.
- **Per-device serialization:** queued execution prevents race amplification and lowers retry churn.
- **Backpressure-aware scan flow:** dedupe + coalescing reduce JS bridge noise in dense RF environments.
- **Deterministic lifecycle cleanup:** explicit dispose semantics reduce long-tail memory retention.
- **Observable runtime pressure:** pending counters, health reports, and traces expose contention early.

Expected outcome: tighter latency distribution, reduced UI stall risk, and cleaner recovery behavior under load.

## Requirements

- React Native `>= 0.76`
- Node.js `>= 18`
- `react-native-nitro-modules` `>= 0.35.x`

## Installation

### 1) Install dependencies

```bash
npm install react-native-nitro-bluetooth-le-scan react-native-nitro-modules
```

### 2) iOS pods

```bash
cd ios && pod install
```

### 3) Configure native permission files (required)

#### Android: edit `android/app/src/main/AndroidManifest.xml`

Add these permissions inside `<manifest>`:

```xml
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" />
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
```

Notes:

- `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT` are required on Android 12+.
- `ACCESS_FINE_LOCATION` is required for Android <= 11 BLE scan behavior and classic discovery compatibility.

#### iOS: edit `ios/<YourApp>/Info.plist`

Add these keys:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>This app uses Bluetooth to discover and connect nearby devices.</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>This app may use location to improve Bluetooth device discovery on older iOS flows.</string>
```

At minimum, `NSBluetoothAlwaysUsageDescription` is required.

### 4) Request runtime permissions in app code

In your app screen (for example `App.tsx`), request runtime permissions before `startBleScan()` on Android:

```ts
import {PermissionsAndroid, Platform} from 'react-native'

async function requestBlePermissions() {
  if (Platform.OS !== 'android') return true
  if (Platform.Version >= 31) {
    const result = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ])
    return (
      result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED &&
      result[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED &&
      result[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED
    )
  }
  const location = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
  )
  return location === PermissionsAndroid.RESULTS.GRANTED
}
```

### 5) Rebuild native app

After adding a Nitro native module, always rebuild:

```bash
# Android
npx react-native run-android

# iOS
npx react-native run-ios
```

### 6) Local tarball install (for module development)

If you are iterating on this module locally and consuming it from another app:

```bash
# In module repo
npm run typescript
npm pack

# In host app
npm install ../react-native-nitro-bluetooth-le-scan/react-native-nitro-bluetooth-le-scan-<version>.tgz
```

### 7) Verify installation quickly

- Module imports successfully in JS.
- Android build can compile `:react-native-nitro-bluetooth-le-scan`.
- iOS build links pod without missing symbols.
- `getBleAdapterState()` returns a valid state string at runtime.

## Platform Permissions

This section is a quick reference. For exact setup, follow the Installation steps above where file paths and snippets are provided.

### Android

- Android 12+ runtime:
  - `BLUETOOTH_SCAN`
  - `BLUETOOTH_CONNECT`
- Android <= 11 runtime:
  - `ACCESS_FINE_LOCATION`

### iOS

- Add to `Info.plist`:
  - `NSBluetoothAlwaysUsageDescription`

The host app owns permission prompt timing and UX.

### Recommended host manifest/plist setup

Android (`AndroidManifest.xml`, app-level):

- `BLUETOOTH`
- `BLUETOOTH_ADMIN`
- `BLUETOOTH_SCAN`
- `BLUETOOTH_CONNECT`
- `ACCESS_FINE_LOCATION` (for Android <= 11 flows and classic discovery compatibility)

iOS (`Info.plist`):

- `NSBluetoothAlwaysUsageDescription`
- optional (if your app also requires location for product behavior): `NSLocationWhenInUseUsageDescription`

## Quick Start Paths

### Path A: First Scan In 5 Minutes

Step flow:

1. Ensure runtime permission.
2. Verify adapter is `poweredOn`.
3. Subscribe to events.
4. Start scan.
5. Stop scan and unsubscribe during cleanup.

```ts
import {
  ensureBleScanPermissions,
  getBleAdapterState,
  startBleScan,
  stopBleScan,
  subscribeBleScan,
} from 'react-native-nitro-bluetooth-le-scan'

async function runBasicScan() {
  const granted = await ensureBleScanPermissions()
  if (!granted) return
  if (getBleAdapterState() !== 'poweredOn') return

  const unsubscribe = subscribeBleScan((event) => {
    if (event.type === 'deviceFound') {
      console.log('found', event.payload.id, event.payload.rssi)
    }
  })

  await startBleScan({mode: 'balanced', allowDuplicates: false})

  setTimeout(async () => {
    await stopBleScan()
    unsubscribe()
  }, 5000)
}
```

### Path B: Connection-Ready Flow

Step flow:

1. Connect with timeout.
2. Discover services.
3. Read/write characteristics.
4. Enable notifications where needed.
5. Disconnect cleanly.

```ts
import {
  connectBleDevice,
  discoverBleServices,
  readBleCharacteristic,
} from 'react-native-nitro-bluetooth-le-scan'

const connected = await connectBleDevice(deviceId, {timeoutMs: 12000})
if (!connected) throw new Error('connect failed')

const services = await discoverBleServices(deviceId)
console.log('services', services.length)

const value = await readBleCharacteristic({
  deviceId,
  serviceUuid,
  characteristicUuid,
})
```

### Path B.1: Event-Driven Operation Result (advanced)

All GATT operations are internally request-scoped (`requestId`) and resolved from native `gattOperationResult` events.
You can observe these events for deep diagnostics:

```ts
const unsubscribe = subscribeBleScan((event) => {
  if (event.type === 'gattOperationResult') {
    console.log(
      event.payload.requestId,
      event.payload.opName,
      event.payload.success
    )
  }
})
```

### Path C: Production-Safe Flow

Use this in production apps where throughput, race safety, and telemetry matter.

Step flow:

1. Serialize per-device GATT operations with queue.
2. Instrument operation latency and outcome metrics.
3. Feed metrics/events into health monitor.
4. Persist report/trace in QA incident logs.

```ts
import {
  createGattOperationQueue,
  createInstrumentedConnectionAdapter,
  createRuntimeHealthMonitor,
} from 'react-native-nitro-bluetooth-le-scan'

const queue = createGattOperationQueue()
const monitor = createRuntimeHealthMonitor()

const instrumented = createInstrumentedConnectionAdapter(adapter, (metric) => {
  monitor.onGattMetric(metric)
})

await queue.enqueue(deviceId, () => instrumented.connect(deviceId))
```

### Optional path: Hooks-first integration

If your app architecture is React hook-centric, start with:

```ts
import {
  useBleAdapterState,
  useBlePermissions,
  useBleScan,
} from 'react-native-nitro-bluetooth-le-scan'

function BleScreen() {
  const {adapterState, refresh} = useBleAdapterState()
  const {granted, ensure} = useBlePermissions()
  const {isScanning, devices, start, stop} = useBleScan()

  return null
}
```

## API By Intent

### Discover Devices

- `getBleAdapterState()`
- `ensureBleScanPermissions()`
- `setBleAdapterEnabled(enable)`
- `enableBleAdapter()`
- `disableBleAdapter()`
- `startBleScan(config?)`
- `stopBleScan()`
- `subscribeBleScan(listener)`
- `getBleScanSnapshot()`

### Prioritize and Enrich

- `estimateDistance(rssi, model?)`
- `rankDevices(devices, weights?)`
- `registerManufacturerParser(parser)`
- `unregisterManufacturerParser(parserId)`

### Connect and Exchange Data

- `connectBleDevice(deviceId, options?)`
- `disconnectBleDevice(deviceId)`
- `discoverBleServices(deviceId, options?)`
- `readBleCharacteristic(address, options?)`
- `writeBleCharacteristic(address, value, options?)`
- `setBleCharacteristicNotification(address, enable, options?)`
- `disposeBleRuntime()`

### Harden Runtime Behavior

- `createGattOperationQueue()`
- `createInstrumentedConnectionAdapter(adapter, onMetric)`
- `createFaultInjectionAdapter(adapter, policy)`
- `createRuntimeHealthMonitor()`

### Build Faster (DX)

- `useBleScan()`
- `useBleAdapterState()`
- `useBlePermissions()`
- `npm run dx:scaffold`
- `npm run dx:diagnostics`

## Event and Error Contract

Main events:

- `scanStarted`
- `scanStopped`
- `deviceFound`
- `adapterStateChanged`
- `connectionStateChanged`
- `servicesDiscovered`
- `characteristicValueChanged`
- `gattOperationResult`
- `warning`
- `error`

`gattOperationResult` payload shape:

- `requestId`
- `opName` (`discoverServices`, `readCharacteristic`, `writeCharacteristic`, `setCharacteristicNotification`)
- `deviceId`
- `success`
- optional success payload:
  - `services` (for `discoverServices`)
  - `value` (for `readCharacteristic`)
- optional failure payload:
  - `errorCode`
  - `errorMessage`

Error payload shape:

- `code`
- `message`
- `recoveryHint?`
- `platformDetails?`

## Observability Playbook

Aggregate runtime quality signals:

```ts
const monitor = createRuntimeHealthMonitor()
const unsubscribe = subscribeBleScan((event) => monitor.onScanEvent(event))

const report = monitor.getReport()
const trace = monitor.getTrace(50)
```

Use `report` for runtime KPIs (attempts, failures, latency, warnings/errors) and `trace` for sequence-level incident evidence.

Lifecycle hardening rules:

- always keep and call unsubscribe function from `subscribeBleScan(...)` on screen unmount
- always disconnect active devices before leaving a screen with GATT actions
- always turn off notifications when no longer needed
- call `disposeBleRuntime()` when tearing down the module runtime in integration tests or app shutdown flows
- collect `report + trace` in QA bug reports for connection/perf incidents

Native lifecycle note:

- This module now uses proactive native cleanup via `dispose()` (called by `disposeBleRuntime()`), instead of relying on `finalize` timing.

Runtime lifecycle contract:

- `disposeBleRuntime()` rejects all in-flight JS GATT requests and clears queue/listener state.
- after `disposeBleRuntime()`, next API call lazily recreates the native singleton and re-attaches event listener.
- pending counters reset to zero immediately after dispose.

## DX Commands

### Scaffold a BLE screen

```bash
npm run dx:scaffold -- --name BleOperationsScreen --output ../react-native-codebase/src/screens
```

### Summarize diagnostics from JSON dumps

```bash
npm run dx:diagnostics -- --report ./tmp/ble-report.json --trace ./tmp/ble-trace.json
```

### Typical command workflow for app teams

```bash
# 1) Create starter screen
npm run dx:scaffold -- --name BleDiagnosticsScreen --output ./src/screens

# 2) During QA, export report/trace JSON from your app logic, then summarize
npm run dx:diagnostics -- --report ./tmp/ble-report.json --trace ./tmp/ble-trace.json
```

## Cookbook

Production recipes:

- [BLE Cookbook](./docs/cookbook.md)

Includes:

- retail beacon discovery
- IoT provisioning flow
- wearable/medical monitoring
- indoor proximity ranking

## Troubleshooting By Symptom

### Symptom: `BLE_PERMISSION_DENIED`

Likely cause:

- runtime permission not granted yet

Fix now:

- request permission before scan/connect
- re-check after returning from OS settings

### Symptom: `BLE_ADAPTER_OFF`

Likely cause:

- Bluetooth disabled or transitioning state

Fix now:

- prompt enable Bluetooth
- refresh adapter state and retry
- optionally try `enableBleAdapter()` on Android (best effort)

### Symptom: `BLE_CONNECT_TIMEOUT`

Likely cause:

- weak signal/distance or peripheral not ready

Fix now:

- retry with backoff policy
- inspect `monitor.getTrace()` timeline

### Symptom: duplicate callbacks after navigating away

Likely cause:

- listener was not unsubscribed on unmount

Fix now:

- store unsubscribe callback returned by `subscribeBleScan`
- invoke it in your component cleanup path

### Symptom: stale connection state in UI

Likely cause:

- UI keeps local state but does not reconcile with `connectionStateChanged` events

Fix now:

- derive connection badges from emitted lifecycle events
- clear local service/device cache when `disconnected` is emitted

### Symptom: growing operation latency over long sessions

Likely cause:

- queue pressure growth per device, or missing per-device serialization

Fix now:

- run GATT operations through `createGattOperationQueue()`
- inspect `pendingOperationCount` and `pendingOperationDeviceCount` in snapshot
- capture `report + trace` during high-load sessions to isolate contention patterns

### Symptom: GATT Promise never resolves after app teardown/navigation reset

Likely cause:

- runtime disposed while requests are still in-flight

Fix now:

- call `disposeBleRuntime()` only during intentional teardown
- re-create subscriptions and restart flow after app/screen re-init

### Symptom: iOS build integration issues

Fix now:

- run `cd ios && pod install`
- open `.xcworkspace` instead of `.xcodeproj`

### Symptom: adapter toggle API returns false

Likely cause:

- iOS does not allow third-party apps to toggle Bluetooth programmatically.
- Android may reject toggle on some OS/device policies.

Fix now:

- treat toggle API as best-effort helper
- provide fallback UX to open system Bluetooth settings

## Operational Readiness Checklist

- [ ] typecheck, lint, tests all pass
- [ ] generated specs are up to date
- [ ] permission UX tested on Android 12+ and <=11 paths
- [ ] physical-device scan/connect smoke tests passed
- [ ] health report + trace capture validated during QA
- [ ] Android/iOS demo integration build passed

## Development

Scripts:

- `npm run typecheck`
- `npm run lint`
- `npm run specs`
- `npm test`
- `npm run dx:scaffold`
- `npm run dx:diagnostics`

## Acknowledgements

Special thanks to the following projects that inspired this library:

- [mrousavy/nitro](https://github.com/mrousavy/nitro) – Nitro Modules architecture

## License

MIT

<a href="https://www.buymeacoffee.com/tconns94" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="200"/>
</a>