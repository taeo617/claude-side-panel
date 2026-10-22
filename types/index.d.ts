export type Snapshot = {
  tokens: number | null
  window: number
  percent: number | null
  usd: number | null
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  rows: { key: string; label: string; value: string; options: string[] }[]
}

declare module 'claude-code' {
  interface PluginState {
    'side-panel': { notes: string[]; snap: Snapshot | null; permMode: string | null; base: Record<string, number> }
  }
}
