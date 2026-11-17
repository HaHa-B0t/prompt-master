// Prompt Master: reads the person's prompt before Claude does, asks what is
// missing, then rewrites it so it says the same thing clearly (it clarifies,
// never extends). One button above the prompt box (and /prompt-master) turns
// it on or off.

import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, PluginOptions, Register, SessionMessage } from 'claude-code'

import type { Phase } from '../types'
import {
  FIND_IT,
  SKIP_IT,
  SKIP_PREFIX,
  analyzeRequest,
  clip,
  extractPrompt,
  isCutOff,
  isMachineFramed,
  isQuickReply,
  isShortReply,
  maskPastes,
  parsePlan,
  restorePastes,
  reviseRequest,
  rewriteRequest,
} from './prompts'
import type { Answer, Request, Situation } from './prompts'

const isOn = atom({ plugin: 'prompt-master', key: 'isOn' } as const, true)
const phase = atom({ plugin: 'prompt-master', key: 'phase' } as const, 'idle' as Phase)

// On/off is kept across sessions here.
const STORE_KEY = 'isOn'

// Where a prompt the person typed comes from: the terminal, the desktop app
// (an SDK host), or Remote Control. Everything else goes through untouched.
const PERSON_ORIGINS: ReadonlySet<string> = new Set(['composer', 'sdk', 'bridge'])

const PHASE_TEXT: Record<Phase, string> = {
  idle: '',
  reading: 'reading your prompt…',
  asking: 'has a question for you…',
  writing: 'polishing your prompt…',
  review: 'waiting for your review…',
}

// How much of the chat the helper model sees, so it doesn't ask what was settled.
const HISTORY_TURNS = 4
const OLD_ROW_HEAD = 300
const OLD_ROW_TAIL = 400
const NEWEST_REPLY_CHARS = 2000
const HISTORY_CHARS = 6000
// The person waits for the helper, so it is kept quick: a fixed low effort
// (measured on Sonnet: as quick and as good as its default, while high
// effort took twice as long; it also keeps a slower-thinking model from
// making the person wait) and a bound on a call that hangs.
const MODEL_EFFORT = 'low'
const MODEL_TIMEOUT_MS = 45_000
const MAX_REVISIONS = 2
// How many polished prompts of this chat keep their original beside them.
const ORIGINALS_KEPT = 30

// The review dialog's choices. Its own "Skip" button can't be renamed or hidden.
const SEND_IT = 'Send it'
const ANOTHER_VERSION = 'Try another version'
const SEND_ORIGINAL = 'Send my original'
const FRESH_VERSION =
  'Write another version: keep every fact, ask, limit and specific, with the same force and scope, and change only the wording, sentence order and layout.'
const ORIGINAL_NOTE_CHARS = 20_000

type Settings = { model: string; maxQuestions: number; review: boolean }

function settingsFrom(options: PluginOptions): Settings {
  const model = typeof options.model === 'string' && options.model.trim() ? options.model.trim() : 'sonnet'
  const n = Number(options.maxQuestions)
  const maxQuestions = Number.isFinite(n) ? Math.max(0, Math.min(4, Math.round(n))) : 3

  // On unless switched off, as the manifest's default says.
  return { model, maxQuestions, review: options.review !== false }
}

// A rewrite that only changes case, punctuation or a "please" says nothing
// new: not worth a review dialog. Erring toward "same" is safe: then the
// person's own words are sent, never a rewrite they did not see.
function bare(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bplease\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

// What happened to each prompt, counted across sessions for
// "/prompt-master status": numbers only, never any text.
const STATS_KEY = 'stats'
type Outcome = 'quick' | 'clear' | 'polished' | 'original' | 'skipped'
type Stats = Partial<Record<Outcome, number>>

async function readStats($: Engine): Promise<Stats> {
  try {
    const saved = await $.store.get(STATS_KEY)

    return typeof saved === 'object' && saved !== null ? { ...(saved as Stats) } : {}
  } catch {
    return {}
  }
}

async function tally($: Engine, outcome: Outcome) {
  try {
    const stats = await readStats($)
    stats[outcome] = (Number(stats[outcome]) || 0) + 1
    await $.store.set(STATS_KEY, stats)
  } catch {
    // Counting is a nicety.
  }
}

async function statsLine($: Engine): Promise<string> {
  const stats = await readStats($)
  const n = (k: Outcome) => Number(stats[k]) || 0
  if (n('polished') + n('original') + n('clear') + n('quick') + n('skipped') === 0) return ''

  return ` So far: ${n('polished')} polished, ${n('original')} sent as your original after review, ${n('clear')} already clear, ${n('quick')} quick replies, ${n('skipped')} skipped.`
}

// Keeps the start and the end of a long row: questions sit at the end.
function headTail(text: string, head: number, tail: number): string {
  return text.length > head + tail + 1 ? `${text.slice(0, head)} … ${text.slice(-tail)}` : text
}

async function setPhase($: Engine, next: Phase) {
  await update($, phase, () => next)
  $.ui.status(next === 'idle' ? undefined : `✨ Prompt Master ${PHASE_TEXT[next]}`)
}

// Stops the prompt being polished right now, when the person turns it off.
let stop: AbortController | undefined

async function setOn($: Engine, value: boolean, isToast: boolean) {
  await update($, isOn, () => value)
  if (!value) stop?.abort()
  try {
    await $.store.set(STORE_KEY, value)
  } catch {
    // Kept for this session only.
  }
  if (isToast) {
    $.ui.toast(
      value
        ? 'Prompt Master on: prompts get polished before Claude reads them. Start one with :: to skip it.'
        : 'Prompt Master off: prompts go to Claude as typed.',
    )
  }
}

async function toggle($: Engine) {
  let value = true
  await update($, isOn, was => (value = !was))
  await setOn($, value, true)
}

// The name the engine gives this mod's band row, learned when it is drawn.
let ownRow = 'prompt-master'

type BandDrawing = Parameters<Engine['ui']['resolve']>[0]

// The star alone (bright when on, dim when off), and what Prompt Master is doing.
async function starRow($: Engine, e: BandDrawing) {
  const active = await read($, isOn)
  const now = await read($, phase)
  const { Box, Button, Text } = $.ui.resolve(e)

  return (
    <Box key="prompt-master" flexDirection="row" gap={1} flexShrink={0}>
      <Button
        key="prompt-master-toggle"
        label="✨"
        plain
        {...(active ? {} : { dimColor: true })}
        onPress={() => void toggle($)}
      />
      {now !== 'idle' ? <Text dimColor>{PHASE_TEXT[now]}</Text> : null}
    </Box>
  )
}

// ---------------------------------------------------------------- chat context

// What Claude asked at the end of a turn: the desktop next-step box
// (a tool ending in wrap_up) or the AskUserQuestion dialog.
function askedIn(row: SessionMessage): { lines: string[]; labels: string[] } {
  const lines: string[] = []
  const labels: string[] = []
  for (const use of row.toolUses ?? []) {
    const input = use.input ?? {}
    if (use.tool.endsWith('wrap_up') && typeof input.ask === 'string') {
      const buttons = Array.isArray(input.actions)
        ? input.actions
            .map(a => (typeof a === 'object' && a !== null ? (a as { label?: unknown }).label : undefined))
            .filter((l): l is string => typeof l === 'string' && l.trim() !== '')
        : []
      labels.push(...buttons)
      lines.push(`Claude asked: ${input.ask}${buttons.length ? ` [buttons: ${buttons.join(' / ')}]` : ''}`)
    }
    if (use.tool === 'AskUserQuestion' && Array.isArray(input.questions)) {
      for (const q of input.questions) {
        const text = typeof q === 'object' && q !== null ? (q as { question?: unknown }).question : undefined
        if (typeof text === 'string') lines.push(`Claude asked: ${text}`)
      }
    }
  }

  return { lines, labels }
}

type Chat = { text: string; buttonLabels: string[] }

// The last few turns: each of the person's prompts and the reply that ended
// that turn (Claude's narration in between is left out), newest last. A
// prompt this mod polished is shown as the person typed it (`originals`), so
// the helper reads their voice and not its own earlier rewrite.
async function recentChat($: Engine, originals: ReadonlyMap<string, string>): Promise<Chat> {
  let rows: SessionMessage[]
  try {
    rows = await $.session.messages()
  } catch {
    return { text: '', buttonLabels: [] }
  }

  type Turn = { prompt: string; reply: string; asked: string[]; labels: string[] }
  const turns: Turn[] = []
  for (const row of rows) {
    const text = row.text.trim()
    if (row.role === 'user') {
      if (text && !isMachineFramed(text)) {
        turns.push({ prompt: originals.get(text) ?? text, reply: '', asked: [], labels: [] })
      }
      continue
    }
    const turn = turns[turns.length - 1]
    if (!turn) continue
    if (text) turn.reply = text
    const { lines, labels } = askedIn(row)
    if (lines.length) {
      turn.asked = lines
      turn.labels = labels
    }
  }

  const recent = turns.slice(-HISTORY_TURNS)
  const blocks = recent.map((t, i) => {
    const isNewest = i === recent.length - 1
    const reply = isNewest
      ? t.reply.length > NEWEST_REPLY_CHARS
        ? `…${t.reply.slice(-(NEWEST_REPLY_CHARS - 1))}`
        : t.reply
      : headTail(t.reply, OLD_ROW_HEAD, OLD_ROW_TAIL)

    return [
      `Person: ${headTail(t.prompt, OLD_ROW_HEAD, OLD_ROW_TAIL)}`,
      reply ? `Claude: ${reply}` : '',
      ...t.asked,
    ]
      .filter(Boolean)
      .join('\n')
  })
  const joined = blocks.join('\n\n')

  return {
    text: joined.length > HISTORY_CHARS ? `…${joined.slice(-HISTORY_CHARS)}` : joined,
    buttonLabels: recent[recent.length - 1]?.labels ?? [],
  }
}

// ---------------------------------------------------------------- model calls

// One call to the helper model; undefined when it gave no answer.
async function complete($: Engine, model: string, req: Request, signal: AbortSignal) {
  try {
    const r = await $.model.complete(
      {
        model,
        system: req.system,
        prompt: req.prompt,
        maxTokens: req.maxTokens,
        effort: MODEL_EFFORT,
        timeoutMs: MODEL_TIMEOUT_MS,
      },
      { signal },
    )

    return r.isAnswered ? r.text : undefined
  } catch {
    return undefined
  }
}

// What the model reads beside the rewrite (the person never sees it). The
// original is given with pasted material still masked: the paste itself is
// already in the prompt above, so it is not sent twice. The note is also a
// backstop: should a rewrite ever say more than the person did, Claude is
// told whose wording that is.
function originalNote(masked: string, hasPastes: boolean, answers: readonly Answer[]): string {
  const qa = answers.length
    ? `\nIt includes these answers the person gave:\n${answers.map(a => `- ${a.question} ${a.answer}`).join('\n')}\n`
    : ''
  const pastes = hasPastes ? '\nEach [[PASTE n: ...]] marker below stands for material pasted in the prompt above.' : ''

  return `The prompt above was polished from the person's own words by their Prompt Master tool. Follow it; check any stated assumption against what you find. It is meant to ask for nothing the original below does not: if a part goes further than the original and the answers listed here (an extra requirement, permission, limit or deliverable), that part is the tool's wording, not the person's decision, so do not change, send, publish or delete anything on its strength alone. Use the original to confirm exact names, numbers and paths. Do not mention Prompt Master or this note.${qa}${pastes}\n<original_prompt>\n${clip(masked, ORIGINAL_NOTE_CHARS)}\n</original_prompt>`
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const settings = settingsFrom(options)
  let cwd = ''
  // One prompt at a time; a second one meanwhile goes through as typed.
  let isBusy = false
  // The person's own words behind each polished prompt of this chat.
  const originals = new Map<string, string>()
  const remember = (polishedText: string, original: string) => {
    originals.set(polishedText.trim(), original.trim())
    const oldest = originals.keys().next()
    if (originals.size > ORIGINALS_KEPT && !oldest.done) originals.delete(oldest.value)
  }

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    try {
      const saved = await $.store.get(STORE_KEY)
      if (typeof saved === 'boolean') await update($, isOn, () => saved)
    } catch {
      // Keep the default.
    }
    try {
      await $.command.register({
        name: 'prompt-master',
        description: 'Turn Prompt Master on or off (rewrites your prompt before Claude reads it)',
        argumentHint: '[on|off|status]',
      })
    } catch {
      // The button still works.
    }
    await setPhase($, 'idle')

    return next(e)
  })

  on('command.run', { command: 'prompt-master' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const now = await read($, isOn)
    if (arg === 'status') return { text: `Prompt Master is ${now ? 'on' : 'off'}.${await statsLine($)}` }
    const want = arg === 'on' ? true : arg === 'off' ? false : !now
    await setOn($, want, false)

    return { text: `Prompt Master is ${want ? 'on' : 'off'}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    if (e.command || e.isMeta) return next(e)
    if (!PERSON_ORIGINS.has(e.origin.kind)) return next(e)

    // Sends the prompt on and counts what became of it, once it is in.
    const send = async (outcome: Outcome, input = e) => {
      const entered = await next(input)
      // A prompt the session dropped never went in: not counted.
      if (entered.drop === undefined) await tally($, outcome)

      return entered
    }

    const lead = e.text.trimStart()
    if (lead.startsWith(SKIP_PREFIX)) {
      const text = lead.slice(SKIP_PREFIX.length).trimStart()
      return text ? next({ ...e, text }) : next(e)
    }
    if (isMachineFramed(e.text)) return next(e)
    // Quick and short replies need no polishing, and no model call.
    if (isQuickReply(e.text) || isShortReply(e.text)) return send('quick')
    if (e.turnId) {
      $.ui.toast('Prompt Master skipped this one: Claude was still working, so it went as typed.')
      return send('skipped')
    }
    if (isBusy) {
      $.ui.toast('Prompt Master is still on your last prompt, so this one went as typed.')
      return send('skipped')
    }

    isBusy = true
    const mine = new AbortController()
    stop = mine
    const onAbort = () => mine.abort()
    next.signal.addEventListener('abort', onAbort)
    const signal = mine.signal

    try {
      const raw = e.text
      const asTyped = (why: string) => {
        $.ui.toast(`Prompt Master ${why}, so your prompt went as typed.`)
        return send('skipped')
      }
      const stopped = () => {
        if (next.signal.aborted) return next(e)
        $.ui.toast('Prompt Master off: your prompt went as typed.')
        return send('skipped')
      }
      const alreadyClear = () => {
        $.ui.toast('Prompt Master: your prompt was already clear, so it went as typed.')
        return send('clear')
      }

      const chat = await recentChat($, originals)
      // A click on one of Claude's next-step buttons is an answer: send it,
      // before the band says anything.
      if (chat.buttonLabels.includes(raw.trim())) return send('quick')

      await setPhase($, 'reading')
      const pastes = maskPastes(raw)
      const attachments = (e.attachments ?? []).map(a => (a.filename ? `${a.type} "${a.filename}"` : a.type))
      const situation: Situation = { raw: pastes.text, conversation: chat.text, cwd, attachments }

      const reply = await complete($, settings.model, analyzeRequest(situation, settings.maxQuestions), signal)
      if (signal.aborted) return stopped()
      if (reply === undefined) return asTyped("couldn't reach the model")
      if (isCutOff(reply)) return asTyped('ran out of room on a long prompt')

      const plan = parsePlan(reply, settings.maxQuestions)
      if (plan?.action === 'pass') return alreadyClear()

      let rewrite: string | undefined
      const answers: Answer[] = []

      if (plan?.action === 'rewrite') {
        rewrite = plan.prompt
      } else {
        const questions = plan?.action === 'ask' ? plan.questions : []
        if (questions.length > 0) await setPhase($, 'asking')
        for (const [i, q] of questions.entries()) {
          const shown = questions.length > 1 ? `(${i + 1}/${questions.length}) ${q.question}` : q.question
          let answer: string
          try {
            answer = await $.ui.ask(shown, {
              options: q.options,
              header: q.header,
              ...(q.multiSelect ? { multiSelect: true as const } : {}),
            })
          } catch {
            // Closing a question means: skip Prompt Master this time.
            return asTyped('question was closed')
          }
          if (signal.aborted) return stopped()
          const a = answer.trim()
          if (!a || a === SKIP_IT) continue
          answers.push({
            question: q.question,
            answer: a === FIND_IT ? 'Not given: Claude should look it up.' : a,
          })
        }

        await setPhase($, 'writing')
        const written = await complete($, settings.model, rewriteRequest(situation, answers), signal)
        if (signal.aborted) return stopped()
        rewrite = written === undefined ? undefined : extractPrompt(written)
      }

      if (!rewrite) return asTyped("couldn't finish the rewrite")
      // The same words back: nothing to review.
      if (bare(restorePastes(rewrite, pastes.blocks)) === bare(raw)) return alreadyClear()

      if (settings.review) {
        await setPhase($, 'review')
        for (let round = 0; ; round += 1) {
          const isLast = round >= MAX_REVISIONS
          let choice: string
          try {
            choice = await $.ui.ask(
              `Here's your polished prompt:\n\n${restorePastes(rewrite, pastes.blocks)}\n\n${
                isLast ? 'Send it? (type one last change and it will be applied and sent)' : 'Send it?'
              }`,
              // The last round has no fresh version to offer: it would be sent unseen.
              { options: isLast ? [SEND_IT, SEND_ORIGINAL] : [SEND_IT, ANOTHER_VERSION, SEND_ORIGINAL], header: 'Review' },
            )
          } catch {
            $.ui.toast('Prompt Master review was closed, so your prompt went as typed.')
            return send('original')
          }
          if (signal.aborted) return stopped()
          if (choice === SEND_IT) break
          // The dialog's own Skip leaves the answer empty: send the original.
          if (choice === SEND_ORIGINAL || !choice.trim()) return send('original')

          const change = choice === ANOTHER_VERSION ? FRESH_VERSION : choice.trim()
          await setPhase($, 'writing')
          const revised = await complete($, settings.model, reviseRequest(situation, rewrite, change), signal)
          if (signal.aborted) return stopped()
          const text = revised === undefined ? undefined : extractPrompt(revised)
          if (text) rewrite = text
          if (isLast) {
            $.ui.toast(
              text
                ? 'Prompt Master applied your last change and sent it.'
                : "Prompt Master couldn't apply that change; sent the last version.",
            )
            break
          }
          if (!text) $.ui.toast("Prompt Master couldn't apply that change; showing the last version.")
          await setPhase($, 'review')
        }
      }

      const final = restorePastes(rewrite, pastes.blocks)
      if (final.trim() === raw.trim()) return send('clear')

      $.ui.toast(
        answers.length > 0
          ? `Prompt Master polished your prompt using your ${answers.length} answer${answers.length > 1 ? 's' : ''}.`
          : 'Prompt Master polished your prompt.',
      )
      remember(final, raw)

      return await send('polished', {
        ...e,
        text: final,
        context: [...(e.context ?? []), originalNote(pastes.text, pastes.blocks.length > 0, answers)],
      })
    } finally {
      next.signal.removeEventListener('abort', onAbort)
      if (stop === mine) stop = undefined
      isBusy = false
      try {
        await setPhase($, 'idle')
      } catch {
        // The prompt is already in: a status that won't clear must not replay it.
      }
    }
  }).catch(($, e, next) => {
    // Never lose the person's prompt: on any failure it goes as typed.
    isBusy = false
    $.ui.status(undefined)
    return next(e)
  })

  // The on/off button, in the band right above the prompt box. The engine
  // gives each mod its own row there and stacks them.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    if (e.plugin) ownRow = e.plugin

    const row = await starRow($, e)
    const { Box } = $.ui.resolve(e)

    // An older engine handed other mods' drawing down this chain: keep it on
    // the same row, after the star.
    return below ? (
      <Box flexDirection="row" gap={2}>
        {row}
        <Box key="prompt-master-rest" flexGrow={1}>
          {below}
        </Box>
      </Box>
    ) : (
      row
    )
  })

  // The band stacks one row per mod. Rather than a line of its own, the star
  // row goes beside the others (usage-bars-chat's bars), so they share one line.
  // This site has no element table: the wrapper is plain Box data.
  on('ui.render', { component: 'AbovePromptList' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const mine = e.props.rows.filter(r => r.plugin === ownRow)
    const rest = e.props.rows.filter(r => r.plugin !== ownRow)
    if (mine.length === 0 || rest.length === 0) return next(e)

    const star = await next({ ...e, props: { ...e.props, rows: mine } })
    const others = await next({ ...e, props: { ...e.props, rows: rest } })

    return {
      type: 'Box',
      props: { flexDirection: 'row', gap: 2 },
      children: [
        { type: 'Box', props: { key: 'prompt-master-star', flexShrink: 0 }, children: [star] },
        { type: 'Box', props: { key: 'prompt-master-rest', flexGrow: 1 }, children: [others] },
      ],
    }
  })

  // A small "prompt master" label among the footer's mode labels while on.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)

    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, '✨ prompt master'] } })
  })
}
