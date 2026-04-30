# BLE Cookbook

Production-oriented recipes for `react-native-nitro-bluetooth-le-scan`.

## 1) Retail Beacon Discovery

Use-case: detect nearby beacons for in-store context.

- Recommended config:
  - `mode: 'balanced'`
  - `allowDuplicates: false`
  - `dedupeMode: 'fingerprint'`
  - `rssiSmoothingWindow: 5`
- Narrow scan by `serviceUuids` and/or `namePrefix`.
- Enable parser plugins to classify iBeacon/Eddystone payloads.

```ts
await startBleScan({
  mode: 'balanced',
  allowDuplicates: false,
  dedupeMode: 'fingerprint',
  rssiSmoothingWindow: 5,
  manufacturerParsers: ['ibeacon', 'eddystone'],
  filters: [{namePrefix: 'Beacon-'}],
})
```

Operational notes:
- Rank by `score` and `distanceEstimateMeters` to prioritize nearest beacons.
- Keep UI updates coalesced; avoid rendering every raw advertisement.

## 2) IoT Provisioning (Nearby-first)

Use-case: find unprovisioned device and connect quickly for setup.

- Recommended config:
  - `mode: 'lowLatency'`
  - `allowDuplicates: true` (for quick first sighting and signal trend)
  - `coalescingWindowMs: 100`
- Connect flow:
  1. scan
  2. pick top-ranked connectable device
  3. `connectBleDevice()`
  4. `discoverBleServices()`
  5. write provisioning characteristic

```ts
const ok = await connectBleDevice(deviceId, {timeoutMs: 12000})
if (!ok) throw new Error('connect failed')
const services = await discoverBleServices(deviceId)
// pick provisioning characteristic and write
```

Operational notes:
- Wrap GATT ops with queue + retry utilities to avoid race conditions.
- Use fault injection adapter in QA to validate timeout/error UX.

## 3) Medical/Wearable Monitoring

Use-case: stable periodic reads/notifications with predictable behavior.

- Recommended config:
  - `mode: 'balanced'` or `'lowPower'` (battery-sensitive)
  - `allowDuplicates: false`
  - `rssiSmoothingWindow: 7`
- Keep one active connection policy per target device.
- Prefer notification stream over aggressive polling.

```ts
const notificationManager = createNotificationManager()
await notificationManager.subscribe(adapter, address, (value) => {
  // parse measurement
})
```

Operational notes:
- Capture health report snapshots and trace entries for support incidents.
- Surface adapter/permission state clearly in the UI before connect attempts.

## 4) Indoor Proximity Ranking

Use-case: choose closest device among many candidates in noisy RF environments.

- Recommended ranking profile:
  - `rssi: 0.7`
  - `recency: 0.2`
  - `connectable: 0.05`
  - `transport: 0.05`
- Combine smoothing + ranking to reduce oscillation.

```ts
const sorted = rankDevices(devices, {
  rssi: 0.7,
  recency: 0.2,
  connectable: 0.05,
  transport: 0.05,
})
```

Operational notes:
- Re-evaluate ranking every scan batch rather than every single event.
- For hybrid environments (BLE + classic), keep transport bias explicit.

## Troubleshooting Quick Map

- `BLE_PERMISSION_DENIED`: request runtime permission again, then refresh adapter state.
- `BLE_ADAPTER_OFF`: prompt user to enable Bluetooth, then retry.
- `BLE_CONNECT_TIMEOUT`: verify distance/power, retry with backoff policy.
- Frequent scan noise: increase `coalescingWindowMs`, keep `dedupeMode: 'fingerprint'`.
