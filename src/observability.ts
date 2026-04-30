import type {BleScanEvent} from './types'
import type {BleGattOpMetric} from './connectionUtils'

export type BleConnectionHealthSummary = {
  attempts: number
  successes: number
  failures: number
  timeouts: number
  inFlight: number
  avgConnectLatencyMs: number
  avgGattOpLatencyMs: number
  gattOpSuccessRate: number
}

export type BleScanHealthSummary = {
  isActive: boolean
  sessionCount: number
  currentSessionDurationMs: number
  currentSessionFoundDevices: number
  foundDevicesTotal: number
  warningCount: number
  errorCount: number
  topErrorCodes: Array<{code: string; count: number}>
}

export type BleRuntimeHealthReport = {
  generatedAtMs: number
  scan: BleScanHealthSummary
  connection: BleConnectionHealthSummary
}

export type BleRuntimeHealthMonitor = {
  onScanEvent: (event: BleScanEvent) => void
  onGattMetric: (metric: BleGattOpMetric) => void
  getReport: () => BleRuntimeHealthReport
  getTrace: (limit?: number) => BleRuntimeTraceEntry[]
  reset: () => void
}

export type BleRuntimeTraceEntry = {
  ts: number
  category: 'scanEvent' | 'gattMetric'
  name: string
  success?: boolean
  details?: string
}

const average = (sum: number, count: number) => (count <= 0 ? 0 : Math.round(sum / count))

export const createRuntimeHealthMonitor = (): BleRuntimeHealthMonitor => {
  let isActive = false
  let sessionCount = 0
  let currentSessionStartedAtMs: number | null = null
  let currentSessionFoundDevices = 0
  let foundDevicesTotal = 0
  let warningCount = 0
  let errorCount = 0
  const errorCodeCount = new Map<string, number>()

  let connectAttempts = 0
  let connectSuccesses = 0
  let connectFailures = 0
  let connectTimeouts = 0
  let connectLatencySumMs = 0
  const connectingStartedAtByDeviceId = new Map<string, number>()

  let gattOpCount = 0
  let gattOpSuccessCount = 0
  let gattOpLatencySumMs = 0
  let trace: BleRuntimeTraceEntry[] = []
  const maxTraceEntries = 400

  const pushTrace = (entry: BleRuntimeTraceEntry) => {
    trace.push(entry)
    if (trace.length > maxTraceEntries) {
      trace = trace.slice(trace.length - maxTraceEntries)
    }
  }

  const onScanEvent = (event: BleScanEvent) => {
    pushTrace({
      ts: event.ts,
      category: 'scanEvent',
      name: event.type,
      details:
        event.type === 'warning' || event.type === 'error'
          ? event.payload.code
          : undefined,
    })
    if (event.type === 'scanStarted') {
      isActive = true
      sessionCount += 1
      currentSessionStartedAtMs = event.ts
      currentSessionFoundDevices = 0
      return
    }
    if (event.type === 'scanStopped') {
      isActive = false
      currentSessionStartedAtMs = null
      return
    }
    if (event.type === 'deviceFound') {
      currentSessionFoundDevices += 1
      foundDevicesTotal += 1
      return
    }
    if (event.type === 'warning' || event.type === 'error') {
      if (event.type === 'warning') warningCount += 1
      if (event.type === 'error') errorCount += 1
      const code = event.payload.code
      errorCodeCount.set(code, (errorCodeCount.get(code) ?? 0) + 1)
      if (code.includes('TIMEOUT')) connectTimeouts += 1
      return
    }
    if (event.type === 'connectionStateChanged') {
      const deviceId = event.payload.deviceId
      const nextState = event.payload.state
      if (nextState === 'connecting') {
        connectAttempts += 1
        connectingStartedAtByDeviceId.set(deviceId, event.ts)
        return
      }
      if (nextState === 'connected') {
        connectSuccesses += 1
        const startedAt = connectingStartedAtByDeviceId.get(deviceId)
        if (startedAt != null) {
          connectLatencySumMs += Math.max(0, event.ts - startedAt)
          connectingStartedAtByDeviceId.delete(deviceId)
        }
        return
      }
      if (nextState === 'disconnected') {
        if (connectingStartedAtByDeviceId.has(deviceId)) {
          connectFailures += 1
          connectingStartedAtByDeviceId.delete(deviceId)
        }
      }
    }
  }

  const onGattMetric = (metric: BleGattOpMetric) => {
    pushTrace({
      ts: metric.startedAtMs + metric.elapsedMs,
      category: 'gattMetric',
      name: metric.opName,
      success: metric.success,
      details: metric.errorMessage,
    })
    gattOpCount += 1
    gattOpLatencySumMs += Math.max(0, metric.elapsedMs)
    if (metric.success) gattOpSuccessCount += 1
  }

  const getReport = (): BleRuntimeHealthReport => {
    const generatedAtMs = Date.now()
    const topErrorCodes = [...errorCodeCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([code, count]) => ({code, count}))
    const inFlight = connectingStartedAtByDeviceId.size
    return {
      generatedAtMs,
      scan: {
        isActive,
        sessionCount,
        currentSessionDurationMs:
          isActive && currentSessionStartedAtMs != null
            ? Math.max(0, generatedAtMs - currentSessionStartedAtMs)
            : 0,
        currentSessionFoundDevices,
        foundDevicesTotal,
        warningCount,
        errorCount,
        topErrorCodes,
      },
      connection: {
        attempts: connectAttempts,
        successes: connectSuccesses,
        failures: connectFailures,
        timeouts: connectTimeouts,
        inFlight,
        avgConnectLatencyMs: average(connectLatencySumMs, connectSuccesses),
        avgGattOpLatencyMs: average(gattOpLatencySumMs, gattOpCount),
        gattOpSuccessRate:
          gattOpCount <= 0 ? 1 : Number((gattOpSuccessCount / gattOpCount).toFixed(3)),
      },
    }
  }

  const getTrace = (limit = 100): BleRuntimeTraceEntry[] => {
    if (limit <= 0) return []
    return trace.slice(Math.max(0, trace.length - limit))
  }

  const reset = () => {
    isActive = false
    sessionCount = 0
    currentSessionStartedAtMs = null
    currentSessionFoundDevices = 0
    foundDevicesTotal = 0
    warningCount = 0
    errorCount = 0
    errorCodeCount.clear()
    connectAttempts = 0
    connectSuccesses = 0
    connectFailures = 0
    connectTimeouts = 0
    connectLatencySumMs = 0
    connectingStartedAtByDeviceId.clear()
    gattOpCount = 0
    gattOpSuccessCount = 0
    gattOpLatencySumMs = 0
    trace = []
  }

  return {onScanEvent, onGattMetric, getReport, getTrace, reset}
}
