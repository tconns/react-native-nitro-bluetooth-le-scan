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
