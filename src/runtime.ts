import EventEmitter from 'eventemitter3'
import { getNitroBleScan } from './nitroInstance'
import { eddystoneParser, iBeaconParser } from './parsers'
import type {
  BleScanAdapterState,
  BleScanConfig,
  BleDistanceModel,
  BleScanEvent,
  BleScanManager,
  BleScanResult,
  BleScanSnapshot,
  BleRankingWeights,
  ManufacturerParser,
} from './types'

const native = getNitroBleScan()
const emitter = new EventEmitter()

const FALLBACK_SNAPSHOT: BleScanSnapshot = {
  isScanning: false,
  adapterState: 'unknown',
  supportsClassicDiscovery: true,
  seenDeviceCount: 0,
  eventsEmitted: 0,
  eventsDropped: 0,
  coalescedCount: 0,
}

const DEFAULT_DISTANCE_MODEL: Required<BleDistanceModel> = {
  txPowerAt1m: -59,
  pathLossExponent: 2,
}
const DEFAULT_RANKING_WEIGHTS: Required<BleRankingWeights> = {
  rssi: 0.6,
  recency: 0.25,
  connectable: 0.1,
  transport: 0.05,
}

const parserRegistry = new Map<string, ManufacturerParser>([
  [iBeaconParser.id, iBeaconParser],
  [eddystoneParser.id, eddystoneParser],
])

let lastConfig: BleScanConfig = {}

const clamp = (value: number, min = 0, max = 1) =>
  Math.max(min, Math.min(max, value))

export const estimateDistance = (
  rssi: number,
  model: BleDistanceModel = {}
): number => {
  const merged = {
    ...DEFAULT_DISTANCE_MODEL,
    ...model,
  }
  const ratio = (merged.txPowerAt1m - rssi) / (10 * merged.pathLossExponent)
  return Number(Math.pow(10, ratio).toFixed(2))
}

export const rankDevices = (
  devices: ReadonlyArray<BleScanResult>,
  weights: BleRankingWeights = {}
): BleScanResult[] => {
  const merged = {
    ...DEFAULT_RANKING_WEIGHTS,
    ...weights,
  }
  const now = Date.now()
  return [...devices]
    .map((device) => {
      const rssiScore = clamp((device.smoothedRssi ?? device.rssi + 100) / 70)
      const ageMs = now - device.timestampMs
      const recencyScore = clamp(1 - ageMs / 15000)
      const connectableScore = device.isConnectable ? 1 : 0
      const transportScore = device.transport === 'ble' ? 1 : 0.7
      const score =
        merged.rssi * rssiScore +
        merged.recency * recencyScore +
        merged.connectable * connectableScore +
        merged.transport * transportScore
      return {
        ...device,
        score: Number(score.toFixed(3)),
      }
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}

const applyParsers = (result: BleScanResult): BleScanResult => {
  const parserIds = lastConfig.manufacturerParsers
  const enabled =
    parserIds == null || parserIds.length === 0
      ? [...parserRegistry.values()]
      : parserIds
          .map((id) => parserRegistry.get(id))
          .filter((parser): parser is ManufacturerParser => parser != null)
  const parsed = enabled
    .filter((parser) => parser.canParse(result))
    .map((parser) => ({
      parserId: parser.id,
      data: parser.parse(result),
    }))
  if (parsed.length === 0) return result
  return {
    ...result,
    parsedManufacturerData: parsed,
  }
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
    if (event.type === 'deviceFound') {
      const enriched = applyParsers({
        ...event.payload,
        distanceEstimateMeters:
          event.payload.distanceEstimateMeters ??
          estimateDistance(
            event.payload.smoothedRssi ?? event.payload.rssi,
            lastConfig.distanceModel
          ),
      })
      emitter.emit('event', {...event, payload: enriched})
      return
    }
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
    lastConfig = config
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

export const registerManufacturerParser = (parser: ManufacturerParser) => {
  parserRegistry.set(parser.id, parser)
}

export const unregisterManufacturerParser = (parserId: string) => {
  parserRegistry.delete(parserId)
}
