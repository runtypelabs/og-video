export interface Settling {
  targets: object[]
  group?: string
  settle?: number
}
export function settleTimes<T extends Settling>(timeline: any, items: T[]): T[]
export function bakedAt(items: Settling[], t: number): boolean[]
