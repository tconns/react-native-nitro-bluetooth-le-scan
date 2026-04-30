# react-native-nitro-bluetooth-le-scan

Nitro-powered BLE scanner for React Native.

`react-native-nitro-bluetooth-le-scan` provides a scan-first API with native Android/iOS execution, event streaming, and lightweight observability snapshots.

## Highlights

- Nitro-first architecture (Android native + iOS native + JS facade)
- Scan lifecycle API: start, stop, adapter state, permission check
- Event stream with coalescing support
- Device intelligence metadata: `smoothedRssi`, `score`, `fingerprint`
- Distance/ranking helpers and manufacturer parser plugin hooks
- Snapshot counters (`eventsEmitted`, `eventsDropped`, `coalescedCount`)
- Unified error model with `code`, `message`, `recoveryHint`

## Requirements

- React Native `>= 0.76`
- Node.js `>= 18`
- `react-native-nitro-modules` `>= 0.35.x`

## Installation

```bash
npm install react-native-nitro-bluetooth-le-scan react-native-nitro-modules
```

```bash
cd ios && pod install
```

## Platform permissions

### Android

- Runtime (Android 12+):
  - `BLUETOOTH_SCAN`
  - `BLUETOOTH_CONNECT`
- Runtime (Android <= 11):
  - `ACCESS_FINE_LOCATION`

Library manifest already declares BLE-related permissions, but the host app is still responsible for runtime requests.

### iOS

- Required Info.plist key:
  - `NSBluetoothAlwaysUsageDescription`
- Runtime authorization is managed by CoreBluetooth.

## Quickstart (5 minutes)

```ts
import {
  estimateDistance,
  ensureBleScanPermissions,
  getBleAdapterState,
  getBleScanSnapshot,
  rankDevices,
  registerManufacturerParser,
  startBleScan,
  stopBleScan,
  subscribeBleScan,
} from 'react-native-nitro-bluetooth-le-scan'

async function demo() {
  const granted = await ensureBleScanPermissions()
  if (!granted) return

  const adapter = getBleAdapterState()
  if (adapter !== 'poweredOn') return

  const unsubscribe = subscribeBleScan((event) => {
    if (event.type === 'deviceFound') {
      const distance = estimateDistance(event.payload.smoothedRssi ?? event.payload.rssi)
      console.log('device', event.payload.id, event.payload.score, distance)
    }
  })

  registerManufacturerParser({
    id: 'custom-parser',
    canParse: (result) => (result.manufacturerData?.length ?? 0) > 0,
    parse: (result) => ({preview: result.manufacturerData?.slice(0, 4)}),
  })

  await startBleScan({
    mode: 'balanced',
    allowDuplicates: false,
    coalescingWindowMs: 150,
    dedupeMode: 'fingerprint',
    rssiSmoothingWindow: 5,
    rankingWeights: {rssi: 0.6, recency: 0.25, connectable: 0.1, transport: 0.05},
  })

  setTimeout(async () => {
    await stopBleScan()
    console.log(getBleScanSnapshot())
    unsubscribe()
  }, 5000)
}
```

## API

- `getBleAdapterState(): BleScanAdapterState`
- `ensureBleScanPermissions(): Promise<boolean>`
- `startBleScan(config?: BleScanConfig): Promise<boolean>`
- `stopBleScan(): Promise<boolean>`
- `getBleScanSnapshot(): BleScanSnapshot`
- `subscribeBleScan(listener): unsubscribe`
- `estimateDistance(rssi, model?): number`
- `rankDevices(devices, weights?): BleScanResult[]`
- `registerManufacturerParser(parser): void`
- `unregisterManufacturerParser(parserId): void`

### Event types

- `scanStarted`
- `scanStopped`
- `deviceFound`
- `adapterStateChanged`
- `warning`
- `error`

## Troubleshooting

### `BLE_PERMISSION_DENIED`

- Ensure runtime permissions are requested before `startBleScan()`.
- Re-check permissions after app resumes from Settings.

### `BLE_ADAPTER_OFF`

- Turn on Bluetooth and retry.
- Verify device/emulator has BLE support.

### iOS build issues

- Run `cd ios && pod install`.
- Open `.xcworkspace` instead of `.xcodeproj`.

## Development scripts

- `npm run typecheck`
- `npm run lint`
- `npm run specs`
- `npm test`

## Release checklist (v0.1.0 baseline)

- `npm run typecheck` passes
- `npm run lint` passes
- `npm run specs` regenerates cleanly
- `npm test` passes
- Android/iOS integration build passes in demo app

## License

MIT
