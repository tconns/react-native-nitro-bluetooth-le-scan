export type BleScanFilter = {
  serviceUuids?: string[]
  namePrefix?: string
  manufacturerDataPrefix?: number[]
}

export type BleDedupeMode = 'deviceId' | 'fingerprint'

export type BleDistanceModel = {
  txPowerAt1m?: number
  pathLossExponent?: number
}

export type BleRankingWeights = {
  rssi?: number
  recency?: number
  connectable?: number
  transport?: number
}

export type BleScanConfig = {
  mode?: 'balanced' | 'lowLatency' | 'lowPower'
  allowDuplicates?: boolean
  reportDelayMs?: number
  legacy?: boolean
  coalescingWindowMs?: number
  enableClassicDiscovery?: boolean
  dedupeMode?: BleDedupeMode
  rssiSmoothingWindow?: number
  distanceModel?: BleDistanceModel
  rankingWeights?: BleRankingWeights
  manufacturerParsers?: string[]
  filters?: BleScanFilter[]
}

export type BleParsedManufacturerData = {
  parserId: string
  data: unknown
}

export type BleScanResult = {
  id: string
  transport?: 'ble' | 'classic'
  name?: string
  rssi: number
  smoothedRssi?: number
  distanceEstimateMeters?: number
  score?: number
  fingerprint?: string
  txPower?: number
  serviceUuids?: string[]
  manufacturerData?: number[]
  parsedManufacturerData?: BleParsedManufacturerData[]
  serviceData?: Record<string, number[]>
  isConnectable?: boolean
  timestampMs: number
}

export type BleScanAdapterState =
  | 'unknown'
  | 'resetting'
  | 'unsupported'
  | 'unauthorized'
  | 'poweredOff'
  | 'poweredOn'

export type BleScanError = {
  code: string
  message: string
  recoveryHint?: string
  platformDetails?: string
}

export type BleScanEvent =
  | { type: 'scanStarted'; ts: number }
  | { type: 'scanStopped'; ts: number; reason?: string }
  | { type: 'deviceFound'; ts: number; payload: BleScanResult }
  | { type: 'adapterStateChanged'; ts: number; payload: BleScanAdapterState }
  | {
      type: 'connectionStateChanged'
      ts: number
      payload: { deviceId: string; state: BleConnectionState }
    }
  | { type: 'servicesDiscovered'; ts: number; payload: { deviceId: string; services: BleGattService[] } }
  | {
      type: 'characteristicValueChanged'
      ts: number
      payload: BleGattCharacteristicAddress & { value: number[] }
    }
  | { type: 'warning' | 'error'; ts: number; payload: BleScanError }

export type BleScanSnapshot = {
  isScanning: boolean
  adapterState: BleScanAdapterState
  supportsClassicDiscovery?: boolean
  lastStartTs?: number
  lastStopTs?: number
  seenDeviceCount: number
  eventsEmitted: number
  eventsDropped: number
  coalescedCount: number
  lastErrorCode?: string
  pendingOperationCount?: number
  pendingOperationDeviceCount?: number
}

export type BleScanManager = {
  getAdapterState: () => BleScanAdapterState
  ensurePermissions: () => Promise<boolean>
  setBluetoothEnabled: (enable: boolean) => Promise<boolean>
  enableBluetooth: () => Promise<boolean>
  disableBluetooth: () => Promise<boolean>
  startScan: (config?: BleScanConfig) => Promise<boolean>
  stopScan: () => Promise<boolean>
  connect: (deviceId: string, options?: BleConnectionOptions) => Promise<boolean>
  disconnect: (deviceId: string) => Promise<boolean>
  discoverServices: (deviceId: string) => Promise<BleGattService[]>
  readCharacteristic: (address: BleGattCharacteristicAddress) => Promise<number[]>
  writeCharacteristic: (
    address: BleGattCharacteristicAddress,
    value: number[]
  ) => Promise<boolean>
  setCharacteristicNotification: (
    address: BleGattCharacteristicAddress,
    enable: boolean
  ) => Promise<boolean>
  getSnapshot: () => BleScanSnapshot
  subscribe: (listener: (event: BleScanEvent) => void) => () => void
}

export type ManufacturerParser = {
  id: string
  canParse: (result: BleScanResult) => boolean
  parse: (result: BleScanResult) => unknown
}

export type BleConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'

export type BleConnectionOptions = {
  timeoutMs?: number
}

export type BleRetryPolicy = {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffFactor?: number
}

export type BleGattCharacteristicAddress = {
  deviceId: string
  serviceUuid: string
  characteristicUuid: string
}

export type BleGattService = {
  uuid: string
  characteristicUuids: string[]
}

export type BleConnectionAdapter = {
  connect: (deviceId: string) => Promise<void>
  disconnect: (deviceId: string) => Promise<void>
  discoverServices: (deviceId: string) => Promise<BleGattService[]>
  readCharacteristic: (address: BleGattCharacteristicAddress) => Promise<number[]>
  writeCharacteristic: (
    address: BleGattCharacteristicAddress,
    value: number[]
  ) => Promise<void>
  subscribeNotification: (
    address: BleGattCharacteristicAddress,
    onValue: (value: number[]) => void
  ) => Promise<() => void>
}
