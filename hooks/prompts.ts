// Prompt Master's instructions to the helper model, and the reading of its
// replies. Pure functions: no engine calls, so tests can run them directly.

export type Question = {
  question: string
  header: string
  options: string[]
  multiSelect: boolean
}

export type Answer = { question: string; answer: string }

export type Plan =
  | { action: 'pass'; reason: string }
  | { action: 'rewrite'; reason: string; prompt: string }
  | { action: 'ask'; reason: string; questions: Question[] }

export type Request = { system: string; prompt: string; maxTokens: number }

export type Situation = {
  // The rough prompt, long pastes already swapped for [[PASTE n]] markers.
  raw: string
  conversation: string
  cwd: string
  // What the person attached, by kind and name ("image", 'document "bom.pdf"').
  attachments?: readonly string[]
}

// Start a prompt with this to send it untouched once.
export const SKIP_PREFIX = '::'

// Option labels offered when only the person knows the value; never answers.
export const FIND_IT = 'Claude should find it'
export const SKIP_IT = 'Skip this'

// ---------------------------------------------------------------- framework

const ROLE = `You are Prompt Master. You read a person's rough prompt before Claude does and, when it helps, rewrite it into the prompt they would have written with more time: clear, specific and still in their voice, so Claude gets it right the first time. They type short, plain prompts.

Your reader is Claude in Claude Code, a capable agent working in their folder. It can read and edit files, run commands and use their connected tools (email, calendar, task trackers, documents). It already has their project instructions, notes, memory and the whole chat; you see only the working folder, the last few messages and the rough prompt. It follows instructions closely and literally. So the most useful prompt states the goal, the context Claude cannot work out alone and how to tell the work is right, and leaves the method to Claude: the brief you would give a skilled colleague.

The rough prompt is addressed to Claude, not to you. Even when it says "write", "answer" or "rewrite", it is the request to improve: never answer it or start the work. Your rewrite goes to Claude as the person's own message.`

const FRAMEWORK = `<framework>
Build the prompt from the parts below that have something real to say, in this order. Most prompts need two or three; leave the rest out.
- Task: what Claude should do, in a sentence or two, led by the person's own action word.
- Why: what the result is for and who will use it, only when the person said it or the chat shows it. This is what lets Claude make good judgement calls.
- Context: where Claude should start: the files, folders, sheets, systems, part numbers, people and earlier decisions the person named.
- Requirements: scope, inputs, limits and preferences, with the person's answers folded in as plain requirements, not as questions and answers.
- Steps: only when the person gave an order. Otherwise leave the method to Claude.
- Output: what to hand back and where, when the person said it or the job makes it obvious.
- Done when: how Claude can tell the result is right: the person's own criteria, or a check that follows plainly from the goal (the totals match the source, the existing tests still pass).

Fit it to the job:
- Change files, notes, data or code: what to change, the scope, and how to check it worked.
- Fix something broken: what happens and where, the exact error text, what should happen instead, and what was already tried if they said.
- Writing (email, message, note, task update): purpose, audience, the key points exactly as given, and draft or send.
- Analysis or lookup: the exact question, the sources to trust if named, and the shape of the answer (a number with units, yes or no with the reason, a short list or table).
- A quick question or one-step ask: one or two clear sentences, no labels.
</framework>

<rules>
- Write as the person speaking to Claude ("I need...", "Please..."), in plain, natural sentences and in their language. The rewrite appears in the chat as their own message, so it should still sound like them: keep their terms, shorthand and note names ([[wikilinks]]) as written.
- Keep every specific exactly as given: names, numbers, units, dates, file paths, part numbers, URLs, code, quoted text, @mentions (each with a space before it, never inside backticks or quotes), #references, skill and command names, trigger phrases ("lint the vault") and control words ("ultrathink"). Claude acts on them literally, so a "corrected" identifier sends it to the wrong place and a reworded trigger phrase no longer starts its routine. Fix spelling and grammar only in ordinary words.
- Each [[PASTE n]] marker stands for material the person pasted (code, a log, data, a document). Keep every marker exactly once, on its own line, where the material belongs. Never fill it in, summarize it or ask about it.
- Keep references to the chat and attachments ("the file above", "option 2", "this screenshot") pointing at the same thing. Claude sees the whole chat and every attachment, so leave them as they are, or name the thing only when the recent conversation makes it certain. Never copy earlier messages in.
- Add no facts the person did not give and the chat does not show: no files, names, numbers, dates, deadlines or extra work. Claude treats everything in the prompt as the person's wish, so an invented detail becomes a wrong instruction. You may make the obvious explicit: the shape of the result, a check that follows plainly from the goal, and that a look-only request leaves things unchanged. Where the work rests on an assumption, state it once as one ("I'm assuming X; if you find otherwise, go with what you find and tell me").
- Keep the person's scope, level of action and every limit they set ("read only", "don't send") as firmly as they put it: "check", "suggest", "draft" and "explain" stay exactly that. Never add an action they did not ask for, such as sending, posting, deleting, committing or pushing; when it is unclear whether they want something sent or only drafted, ask Claude for the draft. Claude does whatever the prompt says, so leave out extra deliverables and nice-to-haves.
- Claude already has the person's project instructions, notes and memory, so don't restate them or add conventions of your own (where to save, naming, format, sign-off).
- Spend every sentence on this task. Role lines ("You are an expert...") and generic asks ("be thorough") only add length.
- Add no emphasis of your own (capitals, CRITICAL, MUST): Claude follows plain instructions closely and overreacts to emphasis.
- Keep formatting light, because the prompt's style carries into Claude's reply: a few sentences or short lines, with plain labels (Context:, Output:) only when there are three or more parts. Put short pasted code, logs or data in fenced blocks, unchanged.
- Make it as short as it can be while leaving nothing to guess: a one-line ask becomes a few clear lines, not a document.
<examples>
These show voice, length and how answers fold in; take no content from them.
<example>
<rough>can u check the hardware tab for dupes</rough>
<rewrite>Please check the hardware tab for duplicate entries and list each one with the rows it appears on. This is a check only, so leave the sheet unchanged.</rewrite>
</example>
<example>
<rough>rename the old part numbers in the notes to the new format</rough>
<answers>Q: Which notes should change? A: Only the Part Numbers folder</answers>
<rewrite>Please rename the old-format part numbers to the new format in the notes in the Part Numbers folder, and leave notes in other folders as they are. When you're done, no old-format numbers should be left in that folder; tell me which notes you changed.</rewrite>
</example>
</examples>
</rules>`

const PASS_LINE = `- "pass": send it as typed. Use it for small talk, thanks, approvals, a direct answer to what Claude just asked, a short follow-up or correction the chat already makes clear ("no, the other sheet", "now do the same for X"), a trigger phrase or skill name for a known routine ("lint the vault", "caveman mode"), and a prompt that is already clear and specific. Claude has the whole chat, so a follow-up that points back at earlier work is usually clear to it even when it is not to you.`

function askGuidance(maxQuestions: number): string {
  return `Choose one action. When torn, prefer "pass" to a rewrite that would only reshuffle words, and "rewrite" to "ask": every question makes the person wait before anything happens.
${PASS_LINE}
- "rewrite": the intent is clear enough to write a better prompt now. Where a detail is missing and a wrong guess is cheap to fix, state a sensible assumption in the prompt instead of asking.
- "ask": only when all three hold: (1) the answer would send Claude to clearly different work, or a wrong guess would waste the work or do the wrong thing; (2) neither the prompt nor the recent conversation settles it; (3) Claude could not settle it by looking at files, notes or tools. Claude can ask its own questions once it has looked, so ask only what must be settled before it starts.

Worth asking, most useful first:
- Which one: the file, sheet, note, part, site or system, when more than one fits (the live ERP or the test copy).
- Act or advise: change it, or only check, suggest or draft.
- For writing: who reads it and what they should do next.
- Scope: this one or all of them; a one-off or a standing rule.
Never ask about the format, length or tone of Claude's reply, anything Claude can look up (where a file is, naming rules, who someone is), anything the chat settles, what an attachment or paste shows, permission to go ahead, or nice-to-haves.

Questions:
- Ask the fewest that matter, ${maxQuestions} at most and usually one, the most important first: closing any question sends the prompt as typed.
- One short sentence in plain words, in the person's language, ending in "?". They are shown one at a time, so each must make sense on its own. Name the real candidates from the prompt and chat, not categories.
- "header": a 1-2 word tag of 12 characters or fewer, such as "Which file", "Action" or "Audience".
- "options": 2 to 4 distinct answers of 1-5 words, the likeliest first. The person can always type their own answer, so leave out "Other". For a value only the person knows (a part number, a name, a path), ask anyway with the options "${FIND_IT}" and "${SKIP_IT}"; they type the value themselves. Otherwise, if you cannot name two concrete, likely answers, rewrite with an assumption instead.
- "multiSelect": true only when the options are things to include together, not alternatives.`
}

const NO_ASK_GUIDANCE = `Choose one action. When torn, prefer "pass" to a rewrite that would only reshuffle words.
${PASS_LINE}
- "rewrite": improve it now. Where a detail is missing, state a sensible assumption in the prompt rather than asking.`

// ---------------------------------------------------------------- requests

function situationBlock(s: Situation): string {
  const convo = s.conversation.trim() || '(none: this is the first message of the chat)'
  const attached = s.attachments?.length
    ? `<attachments>\nThe person attached: ${s.attachments.join(', ')}. They reach Claude with the prompt; you cannot see them. Refer to them as "the attached image" or "the attached file"; never ask what they show.\n</attachments>`
    : ''

  return [
    s.cwd ? `<working_folder>${s.cwd}</working_folder>` : '',
    `<recent_conversation>\n${convo}\n</recent_conversation>`,
    attached,
    `<rough_prompt>\n${s.raw}\n</rough_prompt>`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function analyzeRequest(s: Situation, maxQuestions: number): Request {
  const canAsk = maxQuestions > 0
  const questionShape = canAsk ? '{"question": "...?", "header": "...", "options": ["...", "..."], "multiSelect": false}' : ''

  const system = `${ROLE}

${canAsk ? askGuidance(maxQuestions) : NO_ASK_GUIDANCE}

When you rewrite, use this framework:

${FRAMEWORK}

Reply in exactly this form and nothing else:
<plan>{"reason": "one short line", "action": "pass" | "rewrite"${canAsk ? ' | "ask"' : ''}, "questions": [${questionShape}]}</plan>
<prompt>
The rewritten prompt. Only when the action is "rewrite"; leave this block out otherwise.
</prompt>
Inside the JSON, write any quote in the reason${canAsk ? ' or questions' : ''} with single quotes, so the JSON stays valid.`

  return {
    system,
    prompt: `${situationBlock(s)}\n\nRead the rough prompt and reply in the required form.`,
    maxTokens: 8000,
  }
}

export function rewriteRequest(s: Situation, answers: readonly Answer[]): Request {
  const qa = answers.length
    ? answers.map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n')
    : '(no answers: where something is missing, state a sensible assumption)'

  return {
    system: `${ROLE}

You asked the person a few questions about their rough prompt. Now rewrite it, folding in their answers, using this framework:

${FRAMEWORK}

Reply with the rewritten prompt inside <prompt></prompt> tags and nothing else.`,
    prompt: `${situationBlock(s)}\n\n<answers>\n${qa}\n</answers>\n\nRewrite the rough prompt.`,
    maxTokens: 8000,
  }
}

export function reviseRequest(s: Situation, current: string, change: string): Request {
  return {
    system: `${ROLE}

You already rewrote the person's rough prompt. They read your rewrite and asked for a change. Apply exactly that change, keep everything else, and follow this framework:

${FRAMEWORK}

Reply with the revised prompt inside <prompt></prompt> tags and nothing else.`,
    prompt: `${situationBlock(s)}\n\n<current_rewrite>\n${current}\n</current_rewrite>\n\n<change_request>\n${change}\n</change_request>\n\nRevise the rewrite.`,
    maxTokens: 8000,
  }
}

// ---------------------------------------------------------------- long pastes

// Long pasted material (fenced blocks, logs, tables, code) is swapped for
// [[PASTE n: first line…]] markers before the helper sees the prompt, and put
// back afterwards, so the helper never has to copy it (and can't cut it short).
const PASTE_MIN_LINES = 8
const PASTE_MIN_CHARS = 600

function looksLikeData(block: string): boolean {
  const lines = block.split('\n')
  if (lines.length < PASTE_MIN_LINES && block.length < PASTE_MIN_CHARS) return false
  if (lines.length >= PASTE_MIN_LINES) return true
  const dataLines = lines.filter(l => /\t|[{};<>]|^\s{2,}\S|^\s*[-=*#|]{3,}|\d{2}[:/.-]\d{2}/.test(l)).length

  return dataLines * 2 >= lines.length
}

function marker(n: number, block: string): string {
  const first = (block.split('\n').find(l => l.trim() && !l.trim().startsWith('```')) ?? '').trim().replace(/[[\]]/g, '')

  return `[[PASTE ${n}: ${first.length > 80 ? `${first.slice(0, 79)}…` : first}]]`
}

export type Masked = { text: string; blocks: { marker: string; text: string }[] }

export function maskPastes(raw: string): Masked {
  const blocks: Masked['blocks'] = []
  const keep = (block: string) => {
    const m = marker(blocks.length + 1, block)
    blocks.push({ marker: m, text: block })
    return m
  }

  // Fenced blocks first, whatever their size beyond a few lines.
  let text = raw.replace(/```[^\n]*\n[\s\S]*?\n```/g, block =>
    block.split('\n').length > 4 ? keep(block) : block,
  )
  // Then big data-like paragraphs (blank-line separated).
  text = text
    .split(/(\n\s*\n)/)
    .map(part => (part.trim() && !part.includes('[[PASTE ') && looksLikeData(part) ? keep(part) : part))
    .join('')

  return { text, blocks }
}

// Puts the pasted material back. split/join, never String.replace, so a `$`
// in the paste stays as it is. A marker the helper dropped is appended.
export function restorePastes(text: string, blocks: Masked['blocks']): string {
  let out = text
  const missing: string[] = []
  for (const b of blocks) {
    // "[[PASTE 1:" so marker 1 never matches marker 10.
    const id = b.marker.slice(0, b.marker.indexOf(':') + 1)
    const at = out.indexOf(id)
    if (at < 0) {
      missing.push(b.text)
      continue
    }
    const end = out.indexOf(']]', at)
    out = out.slice(0, at) + b.text + out.slice(end < 0 ? at + id.length : end + 2)
  }

  return missing.length ? `${out}\n\n${missing.join('\n\n')}` : out
}

// ---------------------------------------------------------------- reading replies

function afterPlan(reply: string): number {
  const end = reply.indexOf('</plan>')

  return end >= 0 ? end + '</plan>'.length : 0
}

// The text between the <prompt> after the plan and the last </prompt>;
// undefined when the block is missing or was cut off (never send half a prompt).
export function extractPrompt(reply: string): string | undefined {
  const open = reply.indexOf('<prompt>', afterPlan(reply))
  const close = reply.lastIndexOf('</prompt>')
  if (open < 0 || close <= open) return undefined
  const text = reply.slice(open + '<prompt>'.length, close).trim()

  return text.length > 0 ? text : undefined
}

// A reply that opened a prompt block and never closed it ran out of room.
export function isCutOff(reply: string): boolean {
  const open = reply.indexOf('<prompt>', afterPlan(reply))

  return open >= 0 && reply.indexOf('</prompt>', open) < 0
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function asQuestion(raw: unknown): Question | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const q = raw as Record<string, unknown>
  if (typeof q.question !== 'string' || !q.question.trim()) return undefined

  const seen = new Set<string>()
  const options: string[] = []
  for (const o of Array.isArray(q.options) ? q.options : []) {
    const label =
      typeof o === 'string'
        ? o
        : typeof o === 'object' && o !== null && typeof (o as { label?: unknown }).label === 'string'
          ? (o as { label: string }).label
          : ''
    const clean = clip(label.trim(), 60)
    if (!clean || /^other\b/i.test(clean) || seen.has(clean.toLowerCase())) continue
    seen.add(clean.toLowerCase())
    options.push(clean)
  }
  // A question with fewer than two options asks for a value only the person
  // knows: offer the two fallbacks; they type the value under Other.
  for (const pad of [FIND_IT, SKIP_IT]) {
    if (options.length < 2 && !seen.has(pad.toLowerCase())) {
      seen.add(pad.toLowerCase())
      options.push(pad)
    }
  }

  let question = clip(q.question.trim(), 300)
  if (!question.endsWith('?')) question = `${question.replace(/[.:!]+$/, '')}?`
  const header = clip(typeof q.header === 'string' && q.header.trim() ? q.header.trim() : 'Detail', 12)

  return { question, header, options: options.slice(0, 4), multiSelect: q.multiSelect === true }
}

// Reads the analysis reply. Undefined when it can't be read at all.
export function parsePlan(reply: string, maxQuestions: number): Plan | undefined {
  const open = reply.indexOf('<plan>')
  const close = reply.indexOf('</plan>')
  const planText = open >= 0 && close > open ? reply.slice(open + '<plan>'.length, close) : reply
  const start = planText.indexOf('{')
  const end = planText.lastIndexOf('}')

  let data: Record<string, unknown> | undefined
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(planText.slice(start, end + 1))
      if (typeof parsed === 'object' && parsed !== null) data = parsed as Record<string, unknown>
    } catch {
      data = undefined
    }
  }

  if (!data) {
    // Broken JSON: recover the action alone. A pass or a rewrite with its
    // prompt block is still usable; an ask without readable questions is not.
    const action = /"action"\s*:\s*"(pass|rewrite|ask)"/.exec(planText)?.[1]
    if (action === 'pass') return { action: 'pass', reason: '' }
    const prompt = action === 'rewrite' ? extractPrompt(reply) : undefined
    return prompt ? { action: 'rewrite', reason: '', prompt } : undefined
  }

  const reason = typeof data.reason === 'string' ? clip(data.reason.trim(), 200) : ''

  if (data.action === 'pass') return { action: 'pass', reason }

  if (data.action === 'rewrite') {
    const prompt = extractPrompt(reply)
    return prompt ? { action: 'rewrite', reason, prompt } : undefined
  }

  if (data.action === 'ask') {
    const questions = (Array.isArray(data.questions) ? data.questions : [])
      .map(asQuestion)
      .filter((q): q is Question => q !== undefined)
      .slice(0, Math.max(0, maxQuestions))

    // An ask with no usable question becomes a rewrite with no answers.
    return { action: 'ask', reason, questions }
  }

  return undefined
}

// ---------------------------------------------------------------- what to leave alone

// Machine-framed prompts: scheduled runs, command records, notifications.
// Nobody is there to answer questions, so they always go as typed.
const MACHINE = /^\s*<(scheduled-task|command-|local-command|task-notification|system-reminder|teammate-message)/i

export function isMachineFramed(text: string): boolean {
  return MACHINE.test(text) || text.includes('The user is not present to answer questions')
}

// Quick replies that need no polishing: yes, ok, thanks, "2", "option b"...
const QUICK =
  /^(y|yes|yep|yeah|yup|no|nope|nah|ok|okay|k|kk|sure|thanks|thank you|thx|ty|go|go ahead|go for it|do it|continue|proceed|next|done|stop|cancel|retry|try again|again|lgtm|looks good|sounds good|perfect|great|cool|nice|got it|agreed|approved|correct|right|exactly|both|neither|all|none|either|all of them|first|second|third|the first|the second|the third|option \w+|\d{1,2}|[a-d])$/i

// Short replies made only of these words are quick too ("yes please do it").
const QUICK_WORDS = new Set(
  'y yes yep yeah yup ok okay sure please pls go ahead do it thanks thank you so much sounds looks good great perfect cool nice awesome continue proceed that works fine all right alright'.split(
    ' ',
  ),
)

export function isQuickReply(text: string): boolean {
  const t = text.trim().replace(/[\s.!?,]+$/, '')
  if (t.length < 3 || QUICK.test(t)) return true
  const words = t.toLowerCase().split(/[\s,.!]+/).filter(Boolean)

  return words.length <= 5 && words.every(w => QUICK_WORDS.has(w))
}
