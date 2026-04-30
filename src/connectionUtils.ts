import type {
  BleConnectionAdapter,
  BleConnectionOptions,
  BleConnectionState,
  BleGattCharacteristicAddress,
  BleGattService,
  BleRetryPolicy,
} from './types'

const DEFAULT_TIMEOUT_MS = 10000
const DEFAULT_RETRY_POLICY: Required<BleRetryPolicy> = {
  maxAttempts: 3,
  initialDelayMs: 150,
  maxDelayMs: 2000,
  backoffFactor: 2,
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const keyOf = (address: BleGattCharacteristicAddress) =>
  `${address.deviceId}|${address.serviceUuid}|${address.characteristicUuid}`

export type BleGattOpName =
  | 'connect'
  | 'disconnect'
  | 'discoverServices'
  | 'readCharacteristic'
  | 'writeCharacteristic'
  | 'setNotification'

export type BleGattOpMetric = {
  opName: BleGattOpName
  deviceId: string
  startedAtMs: number
  elapsedMs: number
  success: boolean
  errorMessage?: string
}

export type BleFaultInjectionPolicy = Partial<
  Record<
    BleGattOpName,
    {
      failTimes?: number
      failWith?: string
      delayMs?: number
    }
  >
>

export const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  label = 'operation'
): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutHandle != null) clearTimeout(timeoutHandle)
  }
}

export const withRetry = async <T>(
  operation: () => Promise<T>,
  policy: BleRetryPolicy = {}
): Promise<T> => {
  const merged = {...DEFAULT_RETRY_POLICY, ...policy}
  let attempt = 0
  let delay = merged.initialDelayMs
  let lastError: unknown
  while (attempt < merged.maxAttempts) {
    attempt += 1
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt >= merged.maxAttempts) break
      await sleep(delay)
      delay = Math.min(merged.maxDelayMs, delay * merged.backoffFactor)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Retry operation failed')
}

export const createConnectionStateGuard = () => {
  const stateByDeviceId = new Map<string, BleConnectionState>()
  const get = (deviceId: string) => stateByDeviceId.get(deviceId) ?? 'idle'
  const set = (deviceId: string, state: BleConnectionState) =>
    stateByDeviceId.set(deviceId, state)
  return {get, set}
}

export const safeConnect = async (
  adapter: BleConnectionAdapter,
  deviceId: string,
  guard = createConnectionStateGuard(),
  options: BleConnectionOptions = {}
) => {
  const state = guard.get(deviceId)
  if (state === 'connecting' || state === 'connected') return false
  guard.set(deviceId, 'connecting')
  try {
    await withTimeout(adapter.connect(deviceId), options.timeoutMs, 'connect')
    guard.set(deviceId, 'connected')
    return true
  } catch (error) {
    guard.set(deviceId, 'disconnected')
    throw error
  }
}

export const safeDisconnect = async (
  adapter: BleConnectionAdapter,
  deviceId: string,
  guard = createConnectionStateGuard(),
  options: BleConnectionOptions = {}
) => {
  const state = guard.get(deviceId)
  if (state === 'disconnecting' || state === 'disconnected' || state === 'idle') {
    return false
  }
  guard.set(deviceId, 'disconnecting')
  try {
    await withTimeout(adapter.disconnect(deviceId), options.timeoutMs, 'disconnect')
    guard.set(deviceId, 'disconnected')
    return true
  } catch (error) {
    guard.set(deviceId, 'connected')
    throw error
  }
}

export const createDiscoveryCache = (ttlMs = 10000) => {
  const cache = new Map<string, {services: BleGattService[]; expiresAt: number}>()
  const get = (deviceId: string) => {
    const cached = cache.get(deviceId)
    if (cached == null) return null
    if (Date.now() > cached.expiresAt) {
      cache.delete(deviceId)
      return null
    }
    return cached.services
  }
  const set = (deviceId: string, services: BleGattService[]) =>
    cache.set(deviceId, {services, expiresAt: Date.now() + ttlMs})
  const clear = (deviceId?: string) => {
    if (deviceId == null) cache.clear()
    else cache.delete(deviceId)
  }
  return {get, set, clear}
}

export const discoverServicesWithCache = async (
  adapter: BleConnectionAdapter,
  deviceId: string,
  cache = createDiscoveryCache()
) => {
  const cached = cache.get(deviceId)
  if (cached != null) return cached
  const services = await adapter.discoverServices(deviceId)
  cache.set(deviceId, services)
  return services
}

export const readWithRetry = (
  adapter: BleConnectionAdapter,
  address: BleGattCharacteristicAddress,
  policy?: BleRetryPolicy
) => withRetry(() => adapter.readCharacteristic(address), policy)

export const writeWithRetry = (
  adapter: BleConnectionAdapter,
  address: BleGattCharacteristicAddress,
  value: number[],
  policy?: BleRetryPolicy
) => withRetry(() => adapter.writeCharacteristic(address, value), policy)

export const createNotificationManager = () => {
  const active = new Map<string, () => void>()
  const subscribe = async (
    adapter: BleConnectionAdapter,
    address: BleGattCharacteristicAddress,
    onValue: (value: number[]) => void
  ) => {
    const key = keyOf(address)
    if (active.has(key)) return false
    const unsubscribe = await adapter.subscribeNotification(address, onValue)
    active.set(key, () => {
      unsubscribe()
      active.delete(key)
    })
    return true
  }
  const unsubscribe = (address: BleGattCharacteristicAddress) => {
    const key = keyOf(address)
    const handler = active.get(key)
    if (handler == null) return false
    handler()
    return true
  }
  const clear = () => {
    active.forEach((handler) => handler())
    active.clear()
  }
  return {subscribe, unsubscribe, clear}
}

export const createGattOperationQueue = () => {
  const tailByDeviceId = new Map<string, Promise<unknown>>()

  const enqueue = <T>(deviceId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tailByDeviceId.get(deviceId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(operation)
    tailByDeviceId.set(
      deviceId,
      run.finally(() => {
        if (tailByDeviceId.get(deviceId) === run) {
          tailByDeviceId.delete(deviceId)
        }
      })
    )
    return run
  }

  const clear = (deviceId?: string) => {
    if (deviceId == null) tailByDeviceId.clear()
    else tailByDeviceId.delete(deviceId)
  }

  return {enqueue, clear}
}

export const createInstrumentedConnectionAdapter = (
  adapter: BleConnectionAdapter,
  onMetric: (metric: BleGattOpMetric) => void
): BleConnectionAdapter => {
  const track = async <T>(
    opName: BleGattOpName,
    deviceId: string,
    operation: () => Promise<T>
  ): Promise<T> => {
    const startedAtMs = Date.now()
    try {
      const result = await operation()
      onMetric({
        opName,
        deviceId,
        startedAtMs,
        elapsedMs: Date.now() - startedAtMs,
        success: true,
      })
      return result
    } catch (error) {
      onMetric({
        opName,
        deviceId,
        startedAtMs,
        elapsedMs: Date.now() - startedAtMs,
        success: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  return {
    connect: (deviceId) => track('connect', deviceId, () => adapter.connect(deviceId)),
    disconnect: (deviceId) =>
      track('disconnect', deviceId, () => adapter.disconnect(deviceId)),
    discoverServices: (deviceId) =>
      track('discoverServices', deviceId, () => adapter.discoverServices(deviceId)),
    readCharacteristic: (address) =>
      track('readCharacteristic', address.deviceId, () =>
        adapter.readCharacteristic(address)
      ),
    writeCharacteristic: (address, value) =>
      track('writeCharacteristic', address.deviceId, () =>
        adapter.writeCharacteristic(address, value)
      ),
    subscribeNotification: (address, onValue) =>
      track('setNotification', address.deviceId, () =>
        adapter.subscribeNotification(address, onValue)
      ),
  }
}

export const createFaultInjectionAdapter = (
  adapter: BleConnectionAdapter,
  policy: BleFaultInjectionPolicy
): BleConnectionAdapter => {
  const remainingFailures = new Map<BleGattOpName, number>()

  const runWithFault = async <T>(
    opName: BleGattOpName,
    operation: () => Promise<T>
  ): Promise<T> => {
    const rule = policy[opName]
    if (rule?.delayMs != null && rule.delayMs > 0) {
      await sleep(rule.delayMs)
    }

    const configuredFailures = rule?.failTimes ?? 0
    const left = remainingFailures.get(opName) ?? configuredFailures
    if (left > 0) {
      remainingFailures.set(opName, left - 1)
      throw new Error(rule?.failWith ?? `Injected ${opName} failure`)
    }
    return operation()
  }

  return {
    connect: (deviceId) => runWithFault('connect', () => adapter.connect(deviceId)),
    disconnect: (deviceId) => runWithFault('disconnect', () => adapter.disconnect(deviceId)),
    discoverServices: (deviceId) =>
      runWithFault('discoverServices', () => adapter.discoverServices(deviceId)),
    readCharacteristic: (address) =>
      runWithFault('readCharacteristic', () => adapter.readCharacteristic(address)),
    writeCharacteristic: (address, value) =>
      runWithFault('writeCharacteristic', () =>
        adapter.writeCharacteristic(address, value)
      ),
    subscribeNotification: (address, onValue) =>
      runWithFault('setNotification', () =>
        adapter.subscribeNotification(address, onValue)
      ),
  }
}
