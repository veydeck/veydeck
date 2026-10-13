import http from '@/api'
import type { VeydeckNetworkConfig, VeydeckNetworkUpdateResult } from '../interface/veydeck'

export const veydeckApi = {
  fetchNetwork: () => {
    return http.get<VeydeckNetworkConfig>('/veydeck/network')
  },
  updateNetwork: (payload: VeydeckNetworkConfig) => {
    return http.put<VeydeckNetworkUpdateResult>('/veydeck/network', payload)
  },
  fetchInterfaces: () => {
    return http.get<{ name: string; ip: string; label: string }[]>('/veydeck/network-interfaces')
  },
}
