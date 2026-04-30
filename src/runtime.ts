import EventEmitter from 'eventemitter3'
import { getNitroBleScan } from './nitroInstance'
import type {
  BleScanAdapterState,
  BleScanConfig,
  BleScanEvent,
  BleScanManager,
  BleScanSnapshot,
} from './types'

const native = getNitroBleScan()
const emitter = new EventEmitter()

const FALLBACK_SNAPSHOT: BleScanSnapshot = {
  isScanning: false,
  adapterState: 'unknown',
  seenDeviceCount: 0,
  eventsEmitted: 0,
  eventsDropped: 0,
  coalescedCount: 0,
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

let listenerAttached = false
function ensureListenerAttached() {
  if (listenerAttached) return
  listenerAttached = true
  native.setEventListener((eventJson) => {
    const event = parseJson<BleScanEvent | null>(eventJson, null)
    if (event == null || typeof event.type !== 'string') return
    emitter.emit('event', event)
  })
}

export const bleScanManager: BleScanManager = {
  getAdapterState() {
    const state = native.getAdapterState()
    if (typeof state !== 'string') return 'unknown'
    return state as BleScanAdapterState
  },
  async ensurePermissions() {
    return native.ensurePermissions()
  },
  async startScan(config = {}) {
    ensureListenerAttached()
    return native.startScan(JSON.stringify(config))
  },
  async stopScan() {
    return native.stopScan()
  },
  getSnapshot() {
    return parseJson(native.getSnapshot(), FALLBACK_SNAPSHOT)
  },
  subscribe(listener) {
    ensureListenerAttached()
    emitter.on('event', listener)
    return () => emitter.off('event', listener)
  },
}

export const getBleAdapterState = () => bleScanManager.getAdapterState()
export const ensureBleScanPermissions = () => bleScanManager.ensurePermissions()
export const startBleScan = (config?: BleScanConfig) => bleScanManager.startScan(config)
export const stopBleScan = () => bleScanManager.stopScan()
export const getBleScanSnapshot = () => bleScanManager.getSnapshot()
export const subscribeBleScan = (listener: (event: BleScanEvent) => void) =>
  bleScanManager.subscribe(listener)
