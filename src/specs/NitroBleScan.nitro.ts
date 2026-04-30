import type { HybridObject } from 'react-native-nitro-modules'

export interface NitroBleScan
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  getAdapterState(): string
  ensurePermissions(): boolean
  startScan(configJson: string): boolean
  stopScan(): boolean
  getSnapshot(): string
  setEventListener(listener: (eventJson: string) => void): void
}
