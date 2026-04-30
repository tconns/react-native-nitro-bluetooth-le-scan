export type BleScanFilter = {
  serviceUuids?: string[]
  namePrefix?: string
  manufacturerDataPrefix?: number[]
}

export type BleScanConfig = {
  mode?: 'balanced' | 'lowLatency' | 'lowPower'
  allowDuplicates?: boolean
  reportDelayMs?: number
  legacy?: boolean
  coalescingWindowMs?: number
  enableClassicDiscovery?: boolean
  filters?: BleScanFilter[]
}

export type BleScanResult = {
  id: string
  transport?: 'ble' | 'classic'
  name?: string
  rssi: number
  txPower?: number
  serviceUuids?: string[]
  manufacturerData?: number[]
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
  | { type: 'warning' | 'error'; ts: number; payload: BleScanError }

export type BleScanSnapshot = {
  isScanning: boolean
  adapterState: BleScanAdapterState
  lastStartTs?: number
  lastStopTs?: number
  seenDeviceCount: number
  eventsEmitted: number
  eventsDropped: number
  coalescedCount: number
  lastErrorCode?: string
}

export type BleScanManager = {
  getAdapterState: () => BleScanAdapterState
  ensurePermissions: () => Promise<boolean>
  startScan: (config?: BleScanConfig) => Promise<boolean>
  stopScan: () => Promise<boolean>
  getSnapshot: () => BleScanSnapshot
  subscribe: (listener: (event: BleScanEvent) => void) => () => void
}
