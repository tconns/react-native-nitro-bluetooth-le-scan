import type { ManufacturerParser } from './types'

const APPLE_COMPANY_ID = [0x4c, 0x00]
const startsWith = (source: number[], prefix: number[]) =>
  prefix.every((value, index) => source[index] === value)

export const iBeaconParser: ManufacturerParser = {
  id: 'ibeacon',
  canParse(result) {
    const data = result.manufacturerData ?? []
    return data.length >= 4 && startsWith(data, APPLE_COMPANY_ID)
  },
  parse(result) {
    const data = result.manufacturerData ?? []
    return {
      companyId: 'apple',
      rawPrefix: data.slice(0, 8),
    }
  },
}

export const eddystoneParser: ManufacturerParser = {
  id: 'eddystone',
  canParse(result) {
    const data = result.serviceData?.['0000feaa-0000-1000-8000-00805f9b34fb'] ?? []
    return (
      data.length >= 2 ||
      (result.serviceUuids ?? []).includes('0000feaa-0000-1000-8000-00805f9b34fb')
    )
  },
  parse(result) {
    const serviceData =
      result.serviceData?.['0000feaa-0000-1000-8000-00805f9b34fb'] ?? []
    return {
      service: 'eddystone',
      frameType: serviceData[0],
      txPower: serviceData[1],
    }
  },
}
