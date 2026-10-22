import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snapshot } from '../types'

const PANE = 'side-panel'
const notes = atom({ plugin: 'side-panel', key: 'notes' } as const, [])
const snap = atom({ plugin: 'side-panel', key: 'snap' } as const, null)
const permMode = atom({ plugin: 'side-panel', key: 'permMode' } as const, null as string | null)

const MODE_ROW = /mode|model|effort/i

const MODE_TONE: Record<string, string> = {
  plan: 'cyan',
  acceptEdits: 'green',
  auto: 'yellow',
  bypassPermissions: 'red',
  dontAsk: 'magenta',
  default: 'gray',
}

async function refresh($: any) {
  const u = await $.session.usage()
  const rows = (await $.config.list())
    .filter((r: any) => r.kind === 'choice' && !r.isLocked && MODE_ROW.test(r.key))
    .map((r: any) => ({
      key: r.key,
      label: r.label,
      value: String(r.value),
      options: [...(r.options ?? [])],
    }))
  const next: Snapshot = {
    tokens: u.context.tokens ?? null,
    window: u.context.window,
    percent: u.context.percent ?? null,
    usd: u.cost?.usd ?? null,
    limits: u.rateLimits.map((l: any) => ({ kind: l.kind, percentUsed: l.percentUsed })),
    rows,
  }
  await update($, snap, () => next)
}

async function pick($: any, key: string, value: string) {
  const r = await $.config.set({ key, value })
  if ('deny' in r && r.deny) $.ui.toast(`Cannot change: ${r.deny}`)
  await refresh($)
}
async function addNote($: any, text: string) {
  const t = text.trim()
  if (!t) return
  const all = (await read($, notes)).concat(t).slice(-100)
  await update($, notes, () => all)
  await $.store.set('notes', all)
}
async function removeNote($: any, i: number) {
  const all = (await read($, notes)).filter((_, n) => n !== i)
  await update($, notes, () => all)
  await $.store.set('notes', all)
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('notes')
    if (Array.isArray(saved)) await update($, notes, () => saved as string[])
    await $.command.register({ name: 'side-panel', description: 'Open the notes / usage / mode pane' })
    void $.ui.open({ id: PANE, title: 'Panel' })
    await refresh($)
    $.clock.every(5000, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'side-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Panel' })

    return { text: 'Panel opened.' }
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  // The permission mode is not a /config row; each classic event carries it on e.
  on('classic.UserPromptSubmit', async ($, e: any, next) => {
    await update($, permMode, () => (typeof e.permission_mode === 'string' ? e.permission_mode : null))

    return next(e)
  })
  on('classic.PostToolUse', async ($, e: any, next) => {
    await update($, permMode, () => (typeof e.permission_mode === 'string' ? e.permission_mode : null))

    return next(e)
  })
  on('classic.Stop', async ($, e: any, next) => {
    await update($, permMode, () => (typeof e.permission_mode === 'string' ? e.permission_mode : null))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const list = await read($, notes)
    const s = await read($, snap)
    const mode = await read($, permMode)

    const bar = (pct: number, width: number) => {
      const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
      return '█'.repeat(full) + '░'.repeat(width - full)
    }
    const tone = (pct: number) => (pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : 'green')
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
    const width = Math.max(10, Math.min(30, (e.props.bodyColumns ?? 30) - 6))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold color="cyan">USAGE</Text>
          {s === null ? (
            <Text dimColor>loading…</Text>
          ) : (
            <Box flexDirection="column">
              <Text>
                <Text color={tone(s.percent ?? 0)}>{bar(s.percent ?? 0, width)}</Text> {s.percent ?? '?'}%
              </Text>
              <Text dimColor>
                {fmt(s.tokens ?? 0)} / {fmt(s.window)} tokens
              </Text>
              {s.usd !== null && <Text>cost <Text bold>${s.usd.toFixed(2)}</Text></Text>}
              {s.limits.map(l => (
                <Box flexDirection="column">
                  <Text dimColor>{l.kind}</Text>
                  <Text>
                    <Text color={tone(l.percentUsed)}>{bar(l.percentUsed, width)}</Text> {l.percentUsed}%
                  </Text>
                </Box>
              ))}
            </Box>
          )}
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text bold color="magenta">MODE <Text dimColor>click to switch</Text></Text>
          <Text>
            PERMISSION{' '}
            <Text bold color={mode ? MODE_TONE[mode] ?? 'white' : 'gray'}>
              {mode ?? 'unknown yet'}
            </Text>{' '}
            <Text dimColor>Shift+Tab to change</Text>
          </Text>
          {s !== null && s.rows.length === 0 && <Text dimColor>no mode rows found</Text>}
          {s?.rows.map(r => (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>{r.label}</Text>
              <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
                {r.options.map(o => (
                  <Button
                    key={`${r.key}:${o}`}
                    variant={o === r.value ? 'primary' : undefined}
                    onPress={() => void pick($, r.key, o)}
                  >
                    {o === r.value ? `● ${o}` : o}
                  </Button>
                ))}
              </Box>
            </Box>
          ))}
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">NOTES <Text dimColor>({list.length})</Text></Text>
          {list.length === 0 && <Text dimColor>no notes yet</Text>}
          {list.map((n, i) => (
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text>• {n}</Text>
              <Button key={`del${i}`} plain onPress={() => void removeNote($, i)}>✕</Button>
            </Box>
          ))}
          <Input key="note" placeholder="type a note, Enter to add" submitLabel="add" onSubmit={t => void addNote($, t)} />
        </Box>
      </Box>
    )
  })
}
