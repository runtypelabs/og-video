import type { Scenario } from './index.js'

export const titleCard: Scenario<{ title: string; kicker: string; badge: string; brand: string; accent: string; footer: string; url: string }>
export const diagram: Scenario<{
  title: string
  tagline: string
  brand: string
  accent: string
  stats: { value: number; label: string }[]
  lanes?: { label: string; nodes: { id?: string; label: string; sub: string; icon: string; accent?: string }[] }[]
  graph?: string
  edges?: [string, string][]
}>
export const kinetic: Scenario<{ text: string; by: string; accent: string; theme: 'dark' | 'light' }>
export const metric: Scenario<{ label: string; value: number; decimals: number; prefix: string; suffix: string; delta: string; data: number[]; accent: string; theme: 'dark' | 'light' }>
export const bars: Scenario<{ title: string; data: number[]; labels: string[]; unit: string; highlight: 'max' | 'min' | 'last' | 'none'; average: boolean; accent: string; theme: 'dark' | 'light' }>
export const dotMatrix: Scenario<{ title: string; brand: string; url: string; accent: string; items: { icon: 'search' | 'brand' | 'map' | 'monitor' | 'scrape' | 'code' | 'chart'; label: string }[] }>
export const fallingWords: Scenario<{ label: string; words: string[]; count: number; accent: string; seed: number }>
export const gallery: Scenario<{ title: string; description: string; site: string; accent: string; images: string[] }>
export const release: Scenario<{ title: string; version: string; kicker: string; items: string[]; icons: string[]; accent: string; theme: 'dark' | 'light' }>
export const terminal: Scenario<{ title: string; lines: string[]; steps?: { cmd: string; out: string[] }[]; prompt: string; accent: string; theme: 'dark' | 'light' }>
export const pr: Scenario<{
  repo: string
  number: number
  title: string
  author: string
  state: 'open' | 'merged' | 'closed' | 'draft'
  base: string
  head: string
  file: string
  lines: string[]
  additions: number
  deletions: number
  files: number
  accent: string
  theme: 'dark' | 'light'
}>
export const repo: Scenario<{
  owner: string
  name: string
  desc: string
  stars: number
  forks: number
  version: string
  downloads: string
  lang: string
  langColor?: string
  langs: string
  topics: string
  series: string
  accent: string
  theme: 'dark' | 'light'
}>
export const transcript: Scenario<{ title: string; model: string; chat: string; messages?: string[]; stats: string; accent: string; theme: 'dark' | 'light' }>
export const grid: Scenario<{
  title: string
  kicker: string
  rows: string[]
  rowLabels: string[]
  cols: string[]
  score: string
  tally: boolean
  glyphs: boolean
  accent: string
  fail?: string
  warn?: string
  theme: 'dark' | 'light'
}>
export const race: Scenario<{
  title: string
  labels: string[]
  periods: string[]
  values: number[][]
  prefix: string
  unit: string
  decimals?: number
  top: number
  highlight: string
  lowerIsBetter: boolean
  accent: string
  theme: 'dark' | 'light'
}>
