// Prompt Master: reads the person's prompt before Claude does, asks what is
// missing, then rewrites it with a clear prompt framework. One button above
// the prompt box (and /prompt-master) turns it on or off.

import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, PluginOptions, Register, SessionMessage } from 'claude-code'

import type { Phase } from '../types'
import {
  FIND_IT,
  SKIP_IT,
  SKIP_PREFIX,
  analyzeRequest,
  extractPrompt,
  isCutOff,
  isMachineFramed,
  isQuickReply,
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
const MODEL_TIMEOUT_MS = 90_000
const MAX_REVISIONS = 2
const ORIGINAL_NOTE_CHARS = 20_000

type Settings = { model: string; maxQuestions: number; review: boolean }

function settingsFrom(options: PluginOptions): Settings {
  const model = typeof options.model === 'string' && options.model.trim() ? options.model.trim() : 'sonnet'
  const n = Number(options.maxQuestions)
  const maxQuestions = Number.isFinite(n) ? Math.max(0, Math.min(4, Math.round(n))) : 3

  return { model, maxQuestions, review: options.review === true }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
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

// ---------------------------------------------------------------- chat context

const MACHINE_ROW = /^\s*<(system-reminder|command-|local-command|task-notification|scheduled-task)/i

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
// that turn (Claude's narration in between is left out), newest last.
async function recentChat($: Engine): Promise<Chat> {
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
      if (text && !MACHINE_ROW.test(text) && !(row.toolResults?.length && !text)) {
        turns.push({ prompt: text, reply: '', asked: [], labels: [] })
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
      { model, system: req.system, prompt: req.prompt, maxTokens: req.maxTokens, timeoutMs: MODEL_TIMEOUT_MS },
      { signal },
    )

    return r.isAnswered ? r.text : undefined
  } catch {
    return undefined
  }
}

// What the model reads beside the rewrite (the person never sees it).
function originalNote(raw: string, answers: readonly Answer[]): string {
  const qa = answers.length
    ? `\nIt includes these answers the person gave:\n${answers.map(a => `- ${a.question} ${a.answer}`).join('\n')}\n`
    : ''

  return `The prompt above was polished from the person's own words by their Prompt Master tool. Follow it; check any stated assumption against what you find. Use the original below only to confirm exact names, numbers and paths. Do not mention Prompt Master or this note.${qa}\n<original_prompt>\n${clip(raw, ORIGINAL_NOTE_CHARS)}\n</original_prompt>`
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const settings = settingsFrom(options)
  let cwd = ''
  // One prompt at a time; a second one meanwhile goes through as typed.
  let isBusy = false

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
    if (arg === 'status') return { text: `Prompt Master is ${now ? 'on' : 'off'}.` }
    const want = arg === 'on' ? true : arg === 'off' ? false : !now
    await setOn($, want, false)

    return { text: `Prompt Master is ${want ? 'on' : 'off'}.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    if (e.command || e.isMeta || e.turnId) return next(e)
    if (!PERSON_ORIGINS.has(e.origin.kind)) return next(e)

    const lead = e.text.trimStart()
    if (lead.startsWith(SKIP_PREFIX)) {
      const text = lead.slice(SKIP_PREFIX.length).trimStart()
      return text ? next({ ...e, text }) : next(e)
    }
    if (isMachineFramed(e.text) || isQuickReply(e.text)) return next(e)
    if (isBusy) {
      $.ui.toast('Prompt Master is still on your last prompt, so this one went as typed.')
      return next(e)
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
        return next(e)
      }
      const stopped = () => {
        if (next.signal.aborted) return next(e)
        $.ui.toast('Prompt Master off: your prompt went as typed.')
        return next(e)
      }

      await setPhase($, 'reading')
      const chat = await recentChat($)
      // A click on one of Claude's next-step buttons is an answer: send it.
      if (chat.buttonLabels.includes(raw.trim())) return next(e)

      const pastes = maskPastes(raw)
      const attachments = (e.attachments ?? []).map(a => (a.filename ? `${a.type} "${a.filename}"` : a.type))
      const situation: Situation = { raw: pastes.text, conversation: chat.text, cwd, attachments }

      const reply = await complete($, settings.model, analyzeRequest(situation, settings.maxQuestions), signal)
      if (signal.aborted) return stopped()
      if (reply === undefined) return asTyped("couldn't reach the model")
      if (isCutOff(reply)) return asTyped('ran out of room on a long prompt')

      const plan = parsePlan(reply, settings.maxQuestions)
      if (plan?.action === 'pass') return next(e)

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
              { options: ['Send it', 'Send my original'], header: 'Review' },
            )
          } catch {
            return asTyped('review was closed')
          }
          if (signal.aborted) return stopped()
          if (choice === 'Send it') break
          if (choice === 'Send my original' || !choice.trim()) return next(e)

          await setPhase($, 'writing')
          const revised = await complete($, settings.model, reviseRequest(situation, rewrite, choice.trim()), signal)
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
      if (final.trim() === raw.trim()) return next(e)

      $.ui.toast(
        answers.length > 0
          ? `Prompt Master polished your prompt using your ${answers.length} answer${answers.length > 1 ? 's' : ''}.`
          : 'Prompt Master polished your prompt.',
      )

      return next({ ...e, text: final, context: [...(e.context ?? []), originalNote(raw, answers)] })
    } finally {
      next.signal.removeEventListener('abort', onAbort)
      if (stop === mine) stop = undefined
      isBusy = false
      await setPhase($, 'idle')
    }
  }).catch(($, e, next) => {
    // Never lose the person's prompt: on any failure it goes as typed.
    isBusy = false
    $.ui.status(undefined)
    return next(e)
  })

  // The on/off button, in the band right above the prompt box. Whatever
  // another plugin draws there stays, with this row under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const active = await read($, isOn)
    const now = await read($, phase)
    const { Box, Button, Text } = $.ui.resolve(e)

    const row = (
      <Box key="prompt-master" flexDirection="row" gap={1}>
        {/* The star alone: bright when on, dim when off. */}
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

    return below ? (
      <Box flexDirection="column">
        {below}
        {row}
      </Box>
    ) : (
      row
    )
  })

  // A small "prompt master" label among the footer's mode labels while on.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)

    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, '✨ prompt master'] } })
  })
}
