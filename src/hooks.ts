import {useCallback, useEffect, useMemo, useState} from 'react'
import {
  ensureBleScanPermissions,
  getBleAdapterState,
  getBleScanSnapshot,
  startBleScan,
  stopBleScan,
  subscribeBleScan,
} from './runtime'
import type {BleScanAdapterState, BleScanConfig, BleScanEvent, BleScanResult} from './types'

export type UseBlePermissionsResult = {
  granted: boolean
  loading: boolean
  ensure: () => Promise<boolean>
}

export type UseBleAdapterStateResult = {
  adapterState: BleScanAdapterState
  refresh: () => BleScanAdapterState
}

export type UseBleScanResult = {
  isScanning: boolean
  status: string
  devices: BleScanResult[]
  events: BleScanEvent[]
  start: (config?: BleScanConfig) => Promise<boolean>
  stop: () => Promise<boolean>
  clear: () => void
}

export const useBlePermissions = (): UseBlePermissionsResult => {
  const [granted, setGranted] = useState(false)
  const [loading, setLoading] = useState(false)

  const ensure = useCallback(async () => {
    setLoading(true)
    try {
      const ok = await ensureBleScanPermissions()
      setGranted(ok)
      return ok
    } finally {
      setLoading(false)
    }
  }, [])

  return {granted, loading, ensure}
}

export const useBleAdapterState = (): UseBleAdapterStateResult => {
  const [adapterState, setAdapterState] = useState<BleScanAdapterState>(
    getBleAdapterState()
  )

  useEffect(() => {
    const unsubscribe = subscribeBleScan((event) => {
      if (event.type === 'adapterStateChanged') {
        setAdapterState(event.payload)
      }
    })
    return unsubscribe
  }, [])

  const refresh = useCallback(() => {
    const next = getBleAdapterState()
    setAdapterState(next)
    return next
  }, [])

  return {adapterState, refresh}
}

export const useBleScan = (): UseBleScanResult => {
  const [isScanning, setIsScanning] = useState(false)
  const [status, setStatus] = useState('idle')
  const [devicesById, setDevicesById] = useState<Record<string, BleScanResult>>({})
  const [events, setEvents] = useState<BleScanEvent[]>([])

  useEffect(() => {
    const unsubscribe = subscribeBleScan((event) => {
      setEvents((prev) => [event, ...prev].slice(0, 100))
      if (event.type === 'scanStarted') {
        setIsScanning(true)
        setStatus('scanStarted')
      } else if (event.type === 'scanStopped') {
        setIsScanning(false)
        setStatus(`scanStopped:${event.reason ?? 'unknown'}`)
      } else if (event.type === 'deviceFound') {
        setDevicesById((prev) => ({...prev, [event.payload.id]: event.payload}))
      } else if (event.type === 'warning' || event.type === 'error') {
        setStatus(`${event.type}:${event.payload.code}`)
      }
    })
    return unsubscribe
  }, [])

  const start = useCallback(async (config: BleScanConfig = {}) => {
    const ok = await startBleScan(config)
    if (!ok) setStatus('startFailed')
    return ok
  }, [])

  const stop = useCallback(async () => {
    const ok = await stopBleScan()
    if (!ok) setStatus('stopFailed')
    return ok
  }, [])

  const clear = useCallback(() => {
    setDevicesById({})
    setEvents([])
    const snapshot = getBleScanSnapshot()
    setStatus(`cleared:${snapshot.adapterState}`)
  }, [])

  const devices = useMemo(() => Object.values(devicesById), [devicesById])

  return {isScanning, status, devices, events, start, stop, clear}
}
