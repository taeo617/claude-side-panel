import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snapshot } from '../types'

const PANE = 'side-panel'
const notes = atom({ plugin: 'side-panel', key: 'notes' } as const, [])
const snap = atom({ plugin: 'side-panel', key: 'snap' } as const, null)
const base = atom({ plugin: 'side-panel', key: 'base' } as const, {} as Record<string, number>)
const permMode = atom({ plugin: 'side-panel', key: 'permMode' } as const, null as string | null)

// Context categories, largest first.
const CAT_COLOR = ['#4c8dff', '#ee6a35', '#22a77d', '#9a9a94', '#b08cff', '#e6b422']

const MODE_ROW = /mode|model|effort/i

const MODE_TONE: Record<string, string> = {
  plan: 'cyan',
  acceptEdits: 'green',
  auto: 'yellow',
  bypassPermissions: 'red',
  dontAsk: 'magenta',
  default: 'gray',
}

const MODE_LABEL: Record<string, string> = {
  default: '기본',
  acceptEdits: '편집 자동 승인',
  plan: '계획 모드',
  auto: '자동 판단',
  dontAsk: '묻지 않음',
  bypassPermissions: '모든 권한 허용',
}

const LIMIT_LABEL: Record<string, string> = {
  five_hour: '5시간 한도',
  seven_day: '7일 한도',
}

// "14:30" when the reset is today, else "10/25 14:30".
const resetAt = (iso?: string) => {
  if (!iso) return '알 수 없음'
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  const now = new Date()
  const isToday =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()

  return isToday ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

async function refresh($: any) {
  const u = await $.session.usage({ breakdown: 'summary' })
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
    limits: u.rateLimits.map((l: any) => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    rows,
    cats: (u.context.breakdown?.categories ?? [])
      .filter((c: any) => c.kind === 'used' && c.tokens > 0)
      .map((c: any) => ({ name: c.name, tokens: c.tokens }))
      .sort((a: any, b: any) => b.tokens - a.tokens),
    max: u.context.breakdown?.rawMaxTokens ?? u.context.window,
  }
  await update($, snap, () => next)
  // First reading of each rate-limit window is this session's starting point.
  const known = await read($, base)
  const fresh = next.limits.filter(l => !(l.kind in known))
  if (fresh.length) await update($, base, b => ({ ...b, ...Object.fromEntries(fresh.map(l => [l.kind, l.percentUsed])) }))
}

async function pick($: any, key: string, value: string) {
  const r = await $.config.set({ key, value })
  if ('deny' in r && r.deny) $.ui.toast(`변경할 수 없어요: ${r.deny}`)
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
    await $.command.register({ name: 'side-panel', description: '메모, 사용량, 모드 패널 열기' })
    void $.ui.open({ id: PANE, title: '패널' })
    await refresh($)
    $.clock.every(5000, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'side-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: '패널' })

    return { text: '패널을 열었어요.' }
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
    const start = await read($, base)

    // Card interior: pane body less the card's border and padding.
    const width = Math.max(12, (e.props.bodyColumns ?? 34) - 6)
    const tone = (pct: number) => (pct >= 85 ? 'error' : pct >= 60 ? 'warning' : 'success')
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
    const cells = (pct: number) => Math.max(0, Math.min(width, Math.round((pct / 100) * width)))

    // Plan-limit track: earlier use, this session's share in an accent colour, then what is left.
    const bar = (total: number, sessionPart: number) => {
      const used = cells(total)
      const mine = sessionPart > 0 ? Math.min(used, Math.max(1, cells(sessionPart))) : 0

      return (
        <Text>
          <Text color={tone(total)}>{'█'.repeat(used - mine)}</Text>
          <Text color="cyan">{'█'.repeat(mine)}</Text>
          <Text dimColor>{'░'.repeat(width - used)}</Text>
        </Text>
      )
    }

    // Context track: one segment per category, free space dim.
    const segBar = (cats: { name: string; tokens: number }[], max: number) => {
      let left = width
      const segs = cats.slice(0, CAT_COLOR.length).map((c, i) => {
        const n = Math.min(left, Math.max(1, Math.round((c.tokens / max) * width)))
        left -= n

        return <Text key={c.name} color={CAT_COLOR[i]}>{'█'.repeat(n)}</Text>
      })

      return (
        <Text>
          {segs}
          <Text dimColor>{'░'.repeat(left)}</Text>
        </Text>
      )
    }

    const card = (title: string, hint: string | undefined, body: any) => (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} gap={1}>
        <Box justifyContent="space-between">
          <Text bold>{title}</Text>
          {hint ? <Text dimColor>{hint}</Text> : null}
        </Box>
        {body}
      </Box>
    )

    const ctxBody =
      s === null ? (
        <Text dimColor>불러오는 중…</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Box justifyContent="space-between" alignItems="flex-end">
            <Text bold color={tone(s.percent ?? 0)}>{s.percent ?? '?'}% 사용됨</Text>
            <Text dimColor>{fmt(s.tokens ?? 0)} / {fmt(s.window)}</Text>
          </Box>
          {s.cats.length > 0 ? segBar(s.cats, s.max) : bar(s.percent ?? 0, 0)}
          <Box flexDirection="column">
            {s.cats.slice(0, CAT_COLOR.length).map((c, i) => (
              <Box key={c.name} justifyContent="space-between" gap={1}>
                <Text wrap="truncate-end"><Text color={CAT_COLOR[i]}>■</Text> {c.name}</Text>
                <Text>
                  <Text dimColor>{fmt(c.tokens)}</Text>{'  '}
                  <Text bold>{((c.tokens / s.max) * 100).toFixed(1)}%</Text>
                </Text>
              </Box>
            ))}
          </Box>
          {s.usd !== null && (
            <Box justifyContent="space-between">
              <Text dimColor>이 세션 비용</Text>
              <Text bold>${s.usd.toFixed(2)}</Text>
            </Box>
          )}
        </Box>
      )

    const limitBody =
      s === null ? (
        <Text dimColor>불러오는 중…</Text>
      ) : s.limits.length === 0 ? (
        <Text dimColor>아직 값이 없어요</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {s.limits.map(l => {
            const mine = Math.max(0, +(l.percentUsed - (start[l.kind] ?? l.percentUsed)).toFixed(1))

            return (
              <Box key={l.kind} flexDirection="column">
                <Box justifyContent="space-between">
                  <Text>{LIMIT_LABEL[l.kind] ?? l.kind}</Text>
                  <Text bold color={tone(l.percentUsed)}>{l.percentUsed}%</Text>
                </Box>
                {bar(l.percentUsed, mine)}
                <Box justifyContent="space-between">
                  <Text dimColor>리셋 {resetAt(l.resetsAt)}</Text>
                  <Text color="cyan">이 세션 +{mine}%p</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      )

    const modeBody = (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between">
          <Text dimColor>권한</Text>
          <Text bold inverse color={mode ? MODE_TONE[mode] ?? 'white' : 'gray'}>
            {` ${mode ? MODE_LABEL[mode] ?? mode : '아직 없음'} `}
          </Text>
        </Box>
        {s !== null && s.rows.length === 0 && <Text dimColor>바꿀 수 있는 항목이 없어요</Text>}
        {s?.rows.map(r => (
          <Box key={r.key} flexDirection="column">
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
    )

    const noteBody = (
      <Box flexDirection="column" gap={1}>
        {list.length === 0 && <Text dimColor>아직 메모가 없어요</Text>}
        {list.map((n, i) => (
          <Box key={`n${i}`} justifyContent="space-between" gap={1}>
            <Text wrap="wrap">› {n}</Text>
            <Button key={`del${i}`} plain onPress={() => void removeNote($, i)}>✕</Button>
          </Box>
        ))}
        <Input key="note" placeholder="메모를 입력하고 Enter" submitLabel="추가" onSubmit={t => void addNote($, t)} />
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {card('컨텍스트', undefined, ctxBody)}
        {card('플랜 한도', '청록 = 이 세션', limitBody)}
        {card('모드', 'Shift+Tab', modeBody)}
        {card('메모', `${list.length}개`, noteBody)}
      </Box>
    )
  })
}
