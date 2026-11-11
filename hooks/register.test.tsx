// Tests for Prompt Master. The hooks registered here with the test's `on` sit
// beneath the mod and stand for the engine: the helper model, the question
// dialog, the store, and the session the prompt finally enters.

import { describe, expect, test } from 'claude-code/testing'
import type { ModelCompleteInput, On, PromptSubmitInput, SessionMessage } from 'claude-code'

import { extractPrompt, isMachineFramed, isQuickReply, parsePlan } from './prompts'

const NAME = 'prompt-master'
const SESSION = { cwd: 'C:/Vault', surface: 'desktop' as const, isInteractive: true }
const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const ROUGH = 'update the MRP note with what we decided about the hardware sheet'
const REWRITE = 'Please update my MRP note with the decision we made about the hardware workbook.'

// ------------------------------------------------------------------ helpers

type Gate = { promise: Promise<void>; open: () => void }

function gate(): Gate {
  let open = () => {}
  const promise = new Promise<void>(resolve => {
    open = resolve
  })

  return { promise, open }
}

// What the helper model answers, in order: a reply's text, an empty reply,
// a refusal of the call, or a text held until a gate opens.
type Reply = string | { empty: true } | { deny: string } | { after: Promise<void>; text: string }

// What the person does with each question dialog, in order.
type Answer = string | { dismiss: true } | { after: Promise<void>; answer: string }

type Asked = { question: string; header: string; options: string[]; multiSelect: boolean }

type World = {
  calls: ModelCompleteInput[]
  asked: Asked[]
  submitted: PromptSubmitInput[]
  toasts: string[]
  statuses: (string | undefined)[]
  commands: string[]
  placed: string[]
  store: Map<string, unknown>
  /** Resolves when the helper model is first called. */
  modelReached: Promise<void>
  /** Resolves when the first question dialog opens. */
  askReached: Promise<void>
}

type Script = {
  replies?: Reply[]
  answers?: Answer[]
  history?: SessionMessage[]
  stored?: Record<string, unknown>
}

function worldOf(on: On, script: Script = {}): World {
  const replies = [...(script.replies ?? [])]
  const answers = [...(script.answers ?? [])]
  const modelGate = gate()
  const askGate = gate()

  const world: World = {
    calls: [],
    asked: [],
    submitted: [],
    toasts: [],
    statuses: [],
    commands: [],
    placed: [],
    store: new Map(Object.entries(script.stored ?? {})),
    modelReached: modelGate.promise,
    askReached: askGate.promise,
  }

  on('session.start', ($, e) => ({ cwd: e.cwd }))

  on('command.register', ($, e) => {
    world.commands.push(e.name)

    return { value: { command: e.name } }
  })

  on('store.get', ($, e) => ({ value: world.store.get(e.key) }))

  on('store.set', ($, e) => {
    world.store.set(e.key, e.value)

    return { value: undefined }
  })

  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })

  on('ui.status', ($, e) => {
    world.statuses.push(e.text)

    return { value: undefined }
  })

  on('session.messages', () => ({ value: script.history ?? [] }))

  let tick = 1_794_000_000_000
  on('clock.now', () => ({ value: (tick += 1000) }))

  on('ui.place', ($, e) => {
    world.placed.push(e.id)

    return { value: { isPlaced: true as const, requestId: `row-${e.id}` } }
  })

  // What the engine itself draws in the band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })

  on('model.complete', async ($, e) => {
    world.calls.push(e)
    modelGate.open()

    const reply = replies.shift()
    if (reply === undefined) return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }
    if (typeof reply === 'string') return { value: { isAnswered: true as const, text: reply, usage: USAGE } }
    if ('deny' in reply) return { deny: reply.deny }
    if ('empty' in reply) return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }

    await reply.after

    return { value: { isAnswered: true as const, text: reply.text, usage: USAGE } }
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
    const q = e.questions[0]
    expect(q, 'the dialog carries a question').toBeDefined()
    if (!q) return { deny: 'no question' }

    world.asked.push({ question: q.question, header: q.header, options: q.options.map(o => o.label), multiSelect: q.multiSelect })
    askGate.open()

    const answer = answers.shift()
    if (answer === undefined || typeof answer === 'object' && 'dismiss' in answer) {
      return { deny: 'The user dismissed the question.' }
    }

    let label: string
    if (typeof answer === 'string') {
      label = answer
    } else {
      await answer.after
      label = answer.answer
    }

    return { result: { questions: e.questions, answers: { [q.question]: label } } }
  })

  // The bottom: the prompt enters the session as it arrived here.
  on('prompt.submit', ($, e) => {
    world.submitted.push(e)

    return { text: e.text, ...(e.context !== undefined ? { context: e.context } : {}) }
  })

  return world
}

type Kind = 'sdk' | 'composer' | 'bridge'

const typed = (text: string, kind: Kind = 'sdk') => ({ text, wait: false, origin: { kind } }) as PromptSubmitInput

const command = (args: string) => ({
  command: 'prompt-master',
  args,
  origin: { kind: 'sdk' as const },
  presentation: { isFullscreen: false, columns: 120 },
})

const plan = (body: object, prompt?: string) =>
  `<plan>${JSON.stringify(body)}</plan>${prompt === undefined ? '' : `\n<prompt>\n${prompt}\n</prompt>`}`

const written = (prompt: string) => `<prompt>\n${prompt}\n</prompt>`

const askPlan = (...questions: object[]) => plan({ action: 'ask', reason: 'missing detail', questions })

const WORKBOOK_Q = {
  question: 'Which workbook should I use?',
  header: 'Workbook',
  options: ['Main parts', 'Hardware', 'Other'],
  multiSelect: false,
}

const BAND = {
  plugin: NAME,
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop'] as const

// ------------------------------------------------------------------ the main flow

describe('polishing a prompt', () => {
  test('(a) a rough prompt: one question, answered, then the rewrite reaches Claude with the original beside it', async ($, on) => {
    const world = worldOf(on, {
      replies: [askPlan(WORKBOOK_Q), written(REWRITE)],
      answers: ['Hardware'],
    })
    await $.session.start(SESSION)

    const result = await $.prompt.submit(typed(ROUGH))

    expect(world.calls, 'one call reads the prompt, one rewrites it').toHaveLength(2)
    expect(world.calls[0]?.model).toBe('sonnet')
    expect(world.calls[0]?.prompt).toContain(`<rough_prompt>\n${ROUGH}\n</rough_prompt>`)
    expect(world.calls[0]?.prompt).toContain('<working_folder>C:/Vault</working_folder>')
    expect(world.calls[0]?.system).toContain('"ask"')

    expect(world.asked, '"Other" is the dialog\'s own, so it is dropped').toEqual([
      { question: 'Which workbook should I use?', header: 'Workbook', options: ['Main parts', 'Hardware'], multiSelect: false },
    ])
    expect(world.calls[1]?.prompt).toContain('Q: Which workbook should I use?\nA: Hardware')

    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]?.text).toBe(REWRITE)
    expect(world.submitted[0]?.context).toHaveLength(1)
    expect(world.submitted[0]?.context?.[0]).toContain(`<original_prompt>\n${ROUGH}\n</original_prompt>`)
    expect(result.text).toBe(REWRITE)

    expect(world.toasts).toContain('Prompt Master polished your prompt using your 1 answer.')
    expect(world.statuses).toContain('✨ Prompt Master reading your prompt…')
    expect(world.statuses).toContain('✨ Prompt Master has a question for you…')
    expect(world.statuses).toContain('✨ Prompt Master polishing your prompt…')
    expect(world.statuses.at(-1), 'the status line is cleared at the end').toBeUndefined()
  })

  test('(a) the prompt is polished from the terminal and from Remote Control too', async ($, on) => {
    const world = worldOf(on, {
      replies: [plan({ action: 'rewrite', reason: 'clear' }, REWRITE), plan({ action: 'rewrite', reason: 'clear' }, REWRITE)],
    })
    await $.session.start(SESSION)

    for (const kind of ['composer', 'bridge'] as const) {
      await $.prompt.submit(typed(ROUGH, kind))
    }

    expect(world.submitted.map(s => s.text)).toEqual([REWRITE, REWRITE])
  })

  test('(a) context already beside the prompt is kept, the original added after it', async ($, on) => {
    const world = worldOf(on, { replies: [plan({ action: 'rewrite', reason: 'clear' }, REWRITE)] })
    await $.session.start(SESSION)

    await $.prompt.submit({ ...typed(ROUGH), context: ['an earlier block'] })

    expect(world.submitted[0]?.context?.[0]).toBe('an earlier block')
    expect(world.submitted[0]?.context?.[1]).toContain('<original_prompt>')
  })

  test('a "rewrite" plan sends its own prompt after one model call, asking nothing', async ($, on) => {
    const world = worldOf(on, { replies: [plan({ action: 'rewrite', reason: 'clear enough' }, REWRITE)] })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(ROUGH))

    expect(world.calls).toHaveLength(1)
    expect(world.asked).toEqual([])
    expect(world.submitted[0]?.text).toBe(REWRITE)
    expect(world.toasts).toContain('Prompt Master polished your prompt.')
  })

  test('two questions are numbered in the dialog and both answers reach the rewrite', async ($, on) => {
    const world = worldOf(on, {
      replies: [
        askPlan(WORKBOOK_Q, { question: 'Who is it for', header: 'Audience', options: ['Me', 'Purchasing'], multiSelect: false }),
        written(REWRITE),
      ],
      answers: ['Main parts', 'Purchasing'],
    })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(ROUGH))

    expect(world.asked.map(a => a.question)).toEqual(['(1/2) Which workbook should I use?', '(2/2) Who is it for?'])
    expect(world.calls[1]?.prompt).toContain('Q: Which workbook should I use?\nA: Main parts')
    expect(world.calls[1]?.prompt).toContain('Q: Who is it for?\nA: Purchasing')
    expect(world.toasts).toContain('Prompt Master polished your prompt using your 2 answers.')
  })

  test('a multi-select question is asked as one', async ($, on) => {
    const world = worldOf(on, {
      replies: [askPlan({ ...WORKBOOK_Q, multiSelect: true }), written(REWRITE)],
      answers: ['Main parts, Hardware'],
    })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(ROUGH))

    expect(world.asked[0]?.multiSelect).toBe(true)
    expect(world.calls[1]?.prompt).toContain('A: Main parts, Hardware')
  })

  test('a question with one option offers the two fallbacks; "Skip this" is left out of the answers', async ($, on) => {
    const world = worldOf(on, {
      replies: [askPlan({ question: 'What is the new part number?', header: 'PN', options: [] }), written(REWRITE)],
      answers: ['Skip this'],
    })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(ROUGH))

    expect(world.asked[0]?.options).toEqual(['Claude should find it', 'Skip this'])
    expect(world.calls[1]?.prompt).toContain('(no answers')
    expect(world.submitted[0]?.text).toBe(REWRITE)
  })

  test('an "ask" with no usable question goes straight to the rewrite', async ($, on) => {
    const world = worldOf(on, {
      replies: [askPlan({ question: '', header: 'x', options: ['a', 'b'] }), written(REWRITE)],
    })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(ROUGH))

    expect(world.asked).toEqual([])
    expect(world.calls).toHaveLength(2)
    expect(world.calls[1]?.prompt).toContain('(no answers')
    expect(world.submitted[0]?.text).toBe(REWRITE)
  })

  test('an unreadable analysis falls back to a rewrite with no questions', async ($, on) => {
    const world = worldOf(on, { replies: ['I think this prompt is fine.', written(REWRITE)] })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(ROUGH))

    expect(world.asked).toEqual([])
    expect(world.submitted[0]?.text).toBe(REWRITE)
  })

  test('a rewrite identical to the prompt goes as typed, with no note beside it', async ($, on) => {
    const world = worldOf(on, { replies: [plan({ action: 'rewrite', reason: 'same' }, `  ${ROUGH}  `)] })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(ROUGH))

    expect(world.submitted[0]?.text).toBe(ROUGH)
    expect(world.submitted[0]?.context).toBeUndefined()
    expect(world.toasts.some(t => t.includes('polished'))).toBe(false)
  })

  test('the recent chat rides along, machine rows left out', async ($, on) => {
    const world = worldOf(on, {
      replies: [plan({ action: 'pass', reason: 'clear' })],
      history: [
        { role: 'user', text: '<system-reminder>internal</system-reminder>', toolUses: [] },
        { role: 'user', text: 'Which sheet holds the fasteners?', toolUses: [] },
        { role: 'assistant', text: 'The HARDWARE workbook.', toolUses: [] },
        { role: 'user', text: '<scheduled-task name="brief">run</scheduled-task>', toolUses: [] },
      ],
    })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(ROUGH))

    const sent = world.calls[0]?.prompt ?? ''
    expect(sent).toContain('Person: Which sheet holds the fasteners?\nClaude: The HARDWARE workbook.')
    expect(sent).not.toContain('system-reminder')
    expect(sent).not.toContain('scheduled-task')
  })

  test("Claude's question and buttons ride along; a click on one of its buttons goes as typed", async ($, on) => {
    const history: SessionMessage[] = [
      { role: 'user', text: 'Review the mod', toolUses: [] },
      { role: 'assistant', text: 'Working on it.', toolUses: [] },
      {
        role: 'assistant',
        text: 'Done: found 3 issues.',
        toolUses: [
          { tool_use_id: 't1', tool: 'mcp__ccd_turn__wrap_up', input: { ask: 'Which fix first?', actions: [{ label: 'Yes, fix 1' }, { label: 'Not now' }] } },
        ],
      },
    ]
    const world = worldOf(on, { replies: [plan({ action: 'pass', reason: 'reply' })], history })
    await $.session.start(SESSION)

    await $.prompt.submit(typed('Yes, fix 1'))
    expect(world.calls, 'a button click needs no model call').toHaveLength(0)
    expect(world.submitted[0]?.text).toBe('Yes, fix 1')

    await $.prompt.submit(typed('fix the second issue but keep the old file'))
    const sent = world.calls[0]?.prompt ?? ''
    expect(sent).toContain('Claude: Done: found 3 issues.')
    expect(sent).not.toContain('Working on it.')
    expect(sent).toContain('Claude asked: Which fix first? [buttons: Yes, fix 1 / Not now]')
  })

  test('long pastes are hidden from the helper and put back whole, $ signs intact', async ($, on) => {
    const log = Array.from({ length: 12 }, (_, i) => `line ${i} cost $${i}.00 ERROR`).join('\n')
    const rough = `why does this fail\n\n${log}`
    const world = worldOf(on, {
      replies: [plan({ action: 'rewrite', reason: 'r' }, 'Please find why this log fails.\n\n[[PASTE 1: line 0 cost $0.00 ERROR]]\n\nTell me the cause.')],
    })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(rough))

    expect(world.calls[0]?.prompt).toContain('[[PASTE 1: line 0 cost $0.00 ERROR]]')
    expect(world.calls[0]?.prompt).not.toContain('line 11 cost')
    expect(world.submitted[0]?.text).toBe(`Please find why this log fails.\n\n${log}\n\nTell me the cause.`)
  })

  test('attachments are named to the helper', async ($, on) => {
    const world = worldOf(on, { replies: [plan({ action: 'pass', reason: 'r' })] })
    await $.session.start(SESSION)

    await $.prompt.submit({ ...typed('what is wrong with this drawing'), attachments: [{ type: 'image' }, { type: 'document', filename: 'bom.pdf' }] })

    expect(world.calls[0]?.prompt).toContain('The person attached: image, document "bom.pdf"')
  })

  test('a cut-off analysis sends the prompt as typed without a second call', async ($, on) => {
    const world = worldOf(on, { replies: ['<plan>{"action":"rewrite","reason":"r"}</plan>\n<prompt>\nPlease do the first half of'] })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(ROUGH))

    expect(world.calls).toHaveLength(1)
    expect(world.submitted[0]?.text).toBe(ROUGH)
  })

  test('a second prompt while the first is being polished goes through as typed', async ($, on) => {
    const hold = gate()
    const world = worldOf(on, { replies: [{ after: hold.promise, text: plan({ action: 'rewrite', reason: 'r' }, REWRITE) }] })
    await $.session.start(SESSION)

    const first = $.prompt.submit(typed(ROUGH))
    await world.modelReached

    const second = await $.prompt.submit(typed('and also check the inventory note please'))
    expect(second.text).toBe('and also check the inventory note please')
    expect(world.calls).toHaveLength(1)

    hold.open()
    expect((await first).text).toBe(REWRITE)
  })
})

// ------------------------------------------------------------------ passing through

describe('what goes through untouched', () => {
  test('(b) a "pass" plan leaves the text as typed', async ($, on) => {
    const world = worldOf(on, { replies: [plan({ action: 'pass', reason: 'already clear' })] })
    await $.session.start(SESSION)

    const result = await $.prompt.submit(typed(ROUGH))

    expect(world.calls).toHaveLength(1)
    expect(world.asked).toEqual([])
    expect(result.text).toBe(ROUGH)
    expect(world.submitted[0]?.text).toBe(ROUGH)
    expect(world.submitted[0]?.context).toBeUndefined()
    expect(world.toasts, 'a pass says so, so it never looks like a failure').toEqual([
      'Prompt Master: your prompt was already clear, so it went as typed.',
    ])
    expect(world.placed, 'nothing was polished, so no row').toEqual([])
    expect(world.statuses.at(-1)).toBeUndefined()
  })

  test('(c) a "::" prefix sends the prompt untouched, prefix removed, with no model call', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)

    await $.prompt.submit(typed(':: just send this one'))
    await $.prompt.submit(typed('   ::and this'))

    expect(world.calls).toEqual([])
    expect(world.submitted.map(s => s.text)).toEqual(['just send this one', 'and this'])
  })

  test('(d) a scheduled task never gets a question or a model call', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)

    const scheduled = '<scheduled-task name="morning-brief">\nBuild the morning brief. The user is not present to answer questions.\n</scheduled-task>'
    const loose = 'Update the vault index. The user is not present to answer questions, so decide yourself.'
    await $.prompt.submit(typed(scheduled))
    await $.prompt.submit(typed(loose))

    expect(world.calls).toEqual([])
    expect(world.asked).toEqual([])
    expect(world.submitted.map(s => s.text)).toEqual([scheduled, loose])
  })

  test('(d) quick replies go as typed with no model call', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)

    for (const text of ['yes', 'Yes!', 'ok.', 'go ahead', '2', 'option b']) {
      await $.prompt.submit(typed(text))
    }

    expect(world.calls).toEqual([])
    expect(world.submitted.map(s => s.text)).toEqual(['yes', 'Yes!', 'ok.', 'go ahead', '2', 'option b'])
  })

  test('(e) prompts no person typed go untouched', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)

    for (const kind of ['task-notification', 'scheduled-trigger', 'peer', 'coordinator'] as const) {
      await $.prompt.submit({ text: ROUGH, wait: false, origin: { kind } })
    }

    expect(world.calls).toEqual([])
    expect(world.submitted).toHaveLength(4)
    expect(world.submitted.every(s => s.text === ROUGH)).toBe(true)
  })

  test('(e) meta prompts, prompts typed into a running turn and slash commands go untouched', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)

    await $.prompt.submit({ ...typed(ROUGH), isMeta: true })
    await $.prompt.submit({ ...typed(ROUGH), turnId: 'turn-1' })
    await $.prompt.submit({ ...typed('/review the hardware sheet'), command: { name: 'review', args: 'the hardware sheet' } })

    expect(world.calls).toEqual([])
    expect(world.submitted.map(s => s.text)).toEqual([ROUGH, ROUGH, '/review the hardware sheet'])
    expect(world.toasts, 'only the mid-turn prompt is told about').toEqual([
      'Prompt Master skipped this one: Claude was still working, so it went as typed.',
    ])
  })

  test('a quick reply typed mid-turn goes as typed without a notice', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)

    await $.prompt.submit({ ...typed('ok'), turnId: 'turn-1' })

    expect(world.toasts).toEqual([])
  })
})

// ------------------------------------------------------------------ the polished row

const placedProps = (id: string) => ({ plugin: NAME, component: 'Placed', props: { id, plugin: NAME } }) as const

describe('seeing both versions', () => {
  test('a polished prompt places a collapsed row under the message that opens to the polished text', async ($, on) => {
    const world = worldOf(on, { replies: [plan({ action: 'rewrite', reason: 'r' }, REWRITE)] })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(ROUGH))

    expect(world.placed).toHaveLength(1)
    const id = world.placed[0] ?? ''
    expect(id).toMatch(/^polished-\d+$/)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...placedProps(id), surface })
      const toggle = await ui.find({ key: `toggle-${id}` })
      expect(toggle?.text, surface).toBe('▸ ✨ Polished prompt')
      expect(await ui.find({ text: /hardware workbook/ }), `${surface}: collapsed at first`).toBeUndefined()

      await ui.press({ key: `toggle-${id}` })
      expect((await ui.find({ key: `toggle-${id}` }))?.text, surface).toBe('▾ ✨ Polished prompt')
      expect(await ui.find({ text: /hardware workbook/ }), `${surface}: open shows the polished text`).toBeDefined()

      await ui.press({ key: `toggle-${id}` })
      await ui.unmount()
    }
  })

  test("another plugin's placed row is left alone", async ($, on) => {
    worldOf(on)
    on('ui.render', { component: 'Placed' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>theirs</Text>
    })
    await $.session.start(SESSION)

    const ui = await $.ui.mount({ plugin: NAME, component: 'Placed', props: { id: 'polished-1', plugin: 'someone-else' }, surface: 'desktop' })

    expect(await ui.find({ text: 'theirs' })).toBeDefined()
    await ui.unmount()
  })
})

// ------------------------------------------------------------------ failures

describe('when something goes wrong the prompt goes as typed', () => {
  test('(f) the model gives no answer', async ($, on) => {
    const world = worldOf(on, { replies: [{ empty: true }] })
    await $.session.start(SESSION)

    const result = await $.prompt.submit(typed(ROUGH))

    expect(result.text).toBe(ROUGH)
    expect(world.submitted[0]?.context).toBeUndefined()
    expect(world.toasts).toContain("Prompt Master couldn't reach the model, so your prompt went as typed.")
    expect(world.statuses.at(-1)).toBeUndefined()
  })

  test('(f) the model call is refused', async ($, on) => {
    const world = worldOf(on, { replies: [{ deny: 'model not allowed' }] })
    await $.session.start(SESSION)

    const result = await $.prompt.submit(typed(ROUGH))

    expect(result.text).toBe(ROUGH)
    expect(world.toasts).toContain("Prompt Master couldn't reach the model, so your prompt went as typed.")
  })

  test('(f) the rewrite call fails or is cut off, and the next prompt still works', async ($, on) => {
    const world = worldOf(on, {
      replies: [
        askPlan(WORKBOOK_Q),
        '<prompt>\nPlease update my MRP note with',
        plan({ action: 'rewrite', reason: 'r' }, REWRITE),
      ],
      answers: ['Hardware'],
    })
    await $.session.start(SESSION)

    const first = await $.prompt.submit(typed(ROUGH))
    expect(first.text, 'a half prompt is never sent').toBe(ROUGH)
    expect(world.toasts).toContain("Prompt Master couldn't finish the rewrite, so your prompt went as typed.")

    const second = await $.prompt.submit(typed('summarise the routing changes for line 3'))
    expect(second.text).toBe(REWRITE)
  })

  test('(g) closing the question dialog sends the original and skips the rewrite', async ($, on) => {
    const world = worldOf(on, {
      replies: [askPlan(WORKBOOK_Q), written(REWRITE)],
      answers: [{ dismiss: true }],
    })
    await $.session.start(SESSION)

    const result = await $.prompt.submit(typed(ROUGH))

    expect(world.asked).toHaveLength(1)
    expect(world.calls, 'no rewrite call after a dismissal').toHaveLength(1)
    expect(result.text).toBe(ROUGH)
    expect(world.submitted[0]?.context).toBeUndefined()
    expect(world.toasts).toContain('Prompt Master question was closed, so your prompt went as typed.')
    expect(world.statuses.at(-1)).toBeUndefined()
  })
})

// ------------------------------------------------------------------ on and off

describe('turning it on and off', () => {
  test('(h) /prompt-master off sends prompts untouched; on and status answer too', async ($, on) => {
    const world = worldOf(on, { replies: [plan({ action: 'rewrite', reason: 'r' }, REWRITE)] })
    await $.session.start(SESSION)

    expect(world.commands).toContain('prompt-master')
    expect(await $.command.run(command('off'))).toEqual({ text: 'Prompt Master is off.' })
    expect(world.store.get('isOn'), 'kept for the next session').toBe(false)

    await $.prompt.submit(typed(ROUGH))
    expect(world.calls).toEqual([])
    expect(world.submitted[0]?.text).toBe(ROUGH)

    expect(await $.command.run(command('status'))).toEqual({ text: 'Prompt Master is off.' })
    expect(await $.command.run(command('on'))).toEqual({ text: 'Prompt Master is on.' })
    expect(world.store.get('isOn')).toBe(true)

    await $.prompt.submit(typed(ROUGH))
    expect(world.submitted[1]?.text).toBe(REWRITE)
  })

  test('(h) /prompt-master with no argument flips it', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)

    expect(await $.command.run(command(''))).toEqual({ text: 'Prompt Master is off.' })
    expect(await $.command.run(command(''))).toEqual({ text: 'Prompt Master is on.' })
  })

  test('(h) a saved "off" holds in a new session', async ($, on) => {
    const world = worldOf(on, { stored: { isOn: false } })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(ROUGH))

    expect(world.calls).toEqual([])
    expect(world.submitted[0]?.text).toBe(ROUGH)
  })

  test('(i) the band draws the toggle on terminal and desktop, and pressing it flips the label', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })

      const before = await ui.find({ key: 'prompt-master-toggle' })
      expect(before?.type, surface).toBe('Button')
      expect(before?.text, surface).toBe('✨')
      // What is beneath stays drawn. (This runner has no `keepsBeneath` yet, so look for it.)
      expect(await ui.find({ type: 'Text', text: 'engine band' }), `${surface}: the engine's band is kept`).toBeDefined()

      await ui.press({ key: 'prompt-master-toggle' })
      expect(world.store.get('isOn'), surface).toBe(false)
      expect((await ui.find({ key: 'prompt-master-toggle' }))?.text, surface).toBe('✨')

      await ui.press({ key: 'prompt-master-toggle' })
      expect(world.store.get('isOn'), surface).toBe(true)

      await ui.unmount()
    }

    expect(world.toasts).toContain('Prompt Master off: prompts go to Claude as typed.')
    expect(world.toasts).toContain('Prompt Master on: prompts get polished before Claude reads them. Start one with :: to skip it.')
  })

  test('(i) the button turned off really stops the polishing', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await ui.press({ key: 'prompt-master-toggle' })
    await ui.unmount()

    await $.prompt.submit(typed(ROUGH))

    expect(world.calls).toEqual([])
    expect(world.store.get('isOn')).toBe(false)
  })

  test('(i) the band shows what Prompt Master is doing while it asks', async ($, on) => {
    const answer = gate()
    const world = worldOf(on, {
      replies: [askPlan(WORKBOOK_Q), written(REWRITE)],
      answers: [{ after: answer.promise, answer: 'Hardware' }],
    })
    await $.session.start(SESSION)

    const sent = $.prompt.submit(typed(ROUGH))
    await world.askReached

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: 'has a question for you' }))?.text).toBe('has a question for you…')
    await ui.unmount()

    answer.open()
    expect((await sent).text).toBe(REWRITE)

    const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await after.find({ type: 'Text', text: 'has a question for you' })).toBeUndefined()
    await after.unmount()
  })

  test('(i) the band keeps another mod\'s drawing above the toggle', {
    plugins: [
      {
        name: 'usage-bars',
        tier: 'append',
        register(on) {
          on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
            const { Text } = $.ui.resolve(e)

            return <Text>usage bars</Text>
          })
        },
      },
    ],
  }, async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: 'usage bars' }), surface).toBeDefined()
      expect(await ui.find({ key: 'prompt-master-toggle' }), surface).toBeDefined()
      await ui.unmount()
    }
  })

  test('(i) the band steps aside while a survey shows', async ($, on) => {
    worldOf(on)
    await $.session.start(SESSION)

    const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } })

    expect(await ui.find({ key: 'prompt-master-toggle' })).toBeUndefined()
    await ui.unmount()
  })

  test('the footer lists "prompt master" among the modes only while on', async ($, on) => {
    const seen: (readonly string[])[] = []
    worldOf(on)
    on('ui.render', { component: 'SessionMode' }, ($, e) => {
      seen.push(e.props.modes)
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.modes.join(' ')}</Text>
    })
    await $.session.start(SESSION)

    const MODE = { component: 'SessionMode', surface: 'terminal', requestId: 'mode', props: { modes: ['plan'] } } as const
    await $.ui.render(MODE)
    await $.command.run(command('off'))
    await $.ui.render(MODE)

    expect(seen).toEqual([['plan', '✨ prompt master'], ['plan']])
  })
})

// ------------------------------------------------------------------ settings

describe('settings', () => {
  test('the chosen model reads the prompt', { options: { model: 'haiku' } }, async ($, on) => {
    const world = worldOf(on, { replies: [plan({ action: 'pass', reason: 'ok' })] })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(ROUGH))

    expect(world.calls[0]?.model).toBe('haiku')
  })

  test('maxQuestions 0 never asks, and the analysis is not offered "ask"', { options: { maxQuestions: 0 } }, async ($, on) => {
    const world = worldOf(on, { replies: [askPlan(WORKBOOK_Q), written(REWRITE)] })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(ROUGH))

    expect(world.calls[0]?.system).not.toContain('"ask"')
    expect(world.asked).toEqual([])
    expect(world.submitted[0]?.text).toBe(REWRITE)
  })

  test('maxQuestions 1 asks one question only, unnumbered', { options: { maxQuestions: 1 } }, async ($, on) => {
    const world = worldOf(on, {
      replies: [askPlan(WORKBOOK_Q, { question: 'Who is it for?', header: 'Audience', options: ['Me', 'Team'] }), written(REWRITE)],
      answers: ['Hardware'],
    })
    await $.session.start(SESSION)

    await $.prompt.submit(typed(ROUGH))

    expect(world.asked.map(a => a.question)).toEqual(['Which workbook should I use?'])
  })

  test('review: "Send it" sends the rewrite', { options: { review: true } }, async ($, on) => {
    const world = worldOf(on, { replies: [plan({ action: 'rewrite', reason: 'r' }, REWRITE)], answers: ['Send it'] })
    await $.session.start(SESSION)

    const result = await $.prompt.submit(typed(ROUGH))

    expect(world.asked[0]?.header).toBe('Review')
    expect(world.asked[0]?.question).toContain(REWRITE)
    expect(world.asked[0]?.options).toEqual(['Send it', 'Try another version', 'Send my original'])
    expect(result.text).toBe(REWRITE)
  })

  test('review: "Send my original" sends the original', { options: { review: true } }, async ($, on) => {
    const world = worldOf(on, { replies: [plan({ action: 'rewrite', reason: 'r' }, REWRITE)], answers: ['Send my original'] })
    await $.session.start(SESSION)

    const result = await $.prompt.submit(typed(ROUGH))

    expect(result.text).toBe(ROUGH)
    expect(world.submitted[0]?.context).toBeUndefined()
  })

  test('review: a typed change is applied, then sent', { options: { review: true } }, async ($, on) => {
    const SHORTER = 'Update my MRP note with the hardware workbook decision.'
    const world = worldOf(on, {
      replies: [plan({ action: 'rewrite', reason: 'r' }, REWRITE), written(SHORTER)],
      answers: ['Make it shorter', 'Send it'],
    })
    await $.session.start(SESSION)

    const result = await $.prompt.submit(typed(ROUGH))

    expect(world.calls[1]?.prompt).toContain('<change_request>\nMake it shorter\n</change_request>')
    expect(world.asked[1]?.question).toContain(SHORTER)
    expect(result.text).toBe(SHORTER)
  })

  test('review: "Try another version" shows a fresh rewrite, and the last round no longer offers it', { options: { review: true } }, async ($, on) => {
    const world = worldOf(on, {
      replies: [plan({ action: 'rewrite', reason: 'r' }, REWRITE), written('v2'), written('v3')],
      answers: ['Try another version', 'Try another version', 'Send it'],
    })
    await $.session.start(SESSION)

    const result = await $.prompt.submit(typed(ROUGH))

    expect(world.asked[0]?.options).toEqual(['Send it', 'Try another version', 'Send my original'])
    expect(world.calls[1]?.prompt).toContain('<change_request>\nWrite a noticeably different version')
    expect(world.asked[1]?.question).toContain('v2')
    expect(world.asked[2]?.options, 'the last round would send a new version unseen').toEqual(['Send it', 'Send my original'])
    expect(result.text).toBe('v3')
  })

  test('review: a change typed on the last round is applied and sent, not dropped', { options: { review: true } }, async ($, on) => {
    const world = worldOf(on, {
      replies: [plan({ action: 'rewrite', reason: 'r' }, REWRITE), written('v2'), written('v3'), written('v4')],
      answers: ['change one', 'change two', 'change three'],
    })
    await $.session.start(SESSION)

    const result = await $.prompt.submit(typed(ROUGH))

    expect(world.asked).toHaveLength(3)
    expect(world.asked[2]?.question).toContain('type one last change')
    expect(result.text).toBe('v4')
    expect(world.toasts).toContain('Prompt Master applied your last change and sent it.')
  })

  test('review: closing the review sends the original', { options: { review: true } }, async ($, on) => {
    const world = worldOf(on, { replies: [plan({ action: 'rewrite', reason: 'r' }, REWRITE)], answers: [{ dismiss: true }] })
    await $.session.start(SESSION)

    const result = await $.prompt.submit(typed(ROUGH))

    expect(result.text).toBe(ROUGH)
    expect(world.toasts).toContain('Prompt Master review was closed, so your prompt went as typed.')
  })
})

// ------------------------------------------------------------------ pure functions

describe('(j) reading the model\'s replies', () => {
  test('parsePlan reads pass, rewrite and ask', () => {
    expect(parsePlan('<plan>{"action": "pass", "reason": "thanks"}</plan>', 3)).toEqual({ action: 'pass', reason: 'thanks' })
    expect(parsePlan('<plan>{"action":"rewrite","reason":"r"}</plan>\n<prompt>\nDo it well.\n</prompt>', 3)).toEqual({
      action: 'rewrite',
      reason: 'r',
      prompt: 'Do it well.',
    })
    expect(parsePlan('{"action":"pass","reason":"no tags"}', 3)).toEqual({ action: 'pass', reason: 'no tags' })
  })

  test('parsePlan cleans up questions', () => {
    const reply = askPlan(
      { question: 'Which workbook should I use.', header: 'A very long header', options: ['Parts', { label: 'Hardware' }, 'parts', 'Other (type it)'], multiSelect: true },
      { question: 'Only one option', options: ['Solo'] },
      { question: '', options: ['a', 'b'] },
      { question: 'Who is it for?', options: ['Me', 'Team'] },
    )

    expect(parsePlan(reply, 3)).toEqual({
      action: 'ask',
      reason: 'missing detail',
      questions: [
        { question: 'Which workbook should I use?', header: 'A very long…', options: ['Parts', 'Hardware'], multiSelect: true },
        { question: 'Only one option?', header: 'Detail', options: ['Solo', 'Claude should find it'], multiSelect: false },
        { question: 'Who is it for?', header: 'Detail', options: ['Me', 'Team'], multiSelect: false },
      ],
    })
    expect(parsePlan(reply, 1)).toMatchObject({ questions: [{ question: 'Which workbook should I use?' }] })
    expect(parsePlan(reply, 0)).toEqual({ action: 'ask', reason: 'missing detail', questions: [] })
  })

  test('parsePlan gives undefined for what it cannot read', () => {
    expect(parsePlan('no json at all', 3)).toBeUndefined()
    expect(parsePlan('<plan>{"action": "pass",</plan>', 3), 'broken JSON still reads a pass').toEqual({ action: 'pass', reason: '' })
    expect(parsePlan('<plan>{"action": "ask", "questions": [</plan>', 3)).toBeUndefined()
    expect(parsePlan('<plan>{"reason": "says "hi"", "action": "rewrite"}</plan>\n<prompt>\nDo X.\n</prompt>', 3)).toEqual({
      action: 'rewrite',
      reason: '',
      prompt: 'Do X.',
    })
    expect(parsePlan('<plan>{"action": "shout"}</plan>', 3)).toBeUndefined()
    expect(parsePlan('<plan>{"action": "rewrite", "reason": "r"}</plan>', 3), 'a rewrite with no prompt').toBeUndefined()
    expect(parsePlan('<plan>{"action":"rewrite"}</plan><prompt>\nhalf a prompt', 3), 'a cut-off prompt').toBeUndefined()
  })

  test('extractPrompt', () => {
    expect(extractPrompt('<prompt>\n  Hello there.  \n</prompt>')).toBe('Hello there.')
    expect(extractPrompt('Sure! <prompt>Do X.</prompt> Hope that helps.')).toBe('Do X.')
    expect(extractPrompt('<prompt>Quote: <prompt>inner</prompt> done.</prompt>')).toBe('Quote: <prompt>inner</prompt> done.')
    expect(extractPrompt('no tags')).toBeUndefined()
    expect(extractPrompt('<prompt>cut off')).toBeUndefined()
    expect(extractPrompt('<prompt>   </prompt>')).toBeUndefined()
    expect(extractPrompt('</prompt> backwards <prompt>')).toBeUndefined()
  })

  test('isQuickReply', () => {
    for (const t of ['yes', 'Yes!', ' ok. ', 'no', 'thanks!', 'go ahead', '2', '12', 'option b', 'b', 'hi', 'LGTM', 'sounds good.']) {
      expect(isQuickReply(t), t).toBe(true)
    }
    for (const t of ['fix bug', 'fix', 'yes, but use the 2025 sheet', 'update the MRP note', 'option b with the hardware sheet', '123']) {
      expect(isQuickReply(t), t).toBe(false)
    }
  })

  test('isMachineFramed', () => {
    expect(isMachineFramed('<scheduled-task name="morning-brief">run</scheduled-task>')).toBe(true)
    expect(isMachineFramed('  <task-notification>done</task-notification>')).toBe(true)
    expect(isMachineFramed('<system-reminder>x</system-reminder>')).toBe(true)
    expect(isMachineFramed('Do the brief. The user is not present to answer questions.')).toBe(true)
    expect(isMachineFramed('What does <scheduled-task> mean in my transcript?')).toBe(false)
    expect(isMachineFramed(ROUGH)).toBe(false)
  })
})
