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

const ROLE = `You are Prompt Master. You read a person's rough prompt before Claude does. When it helps, you rewrite it so Claude gets it right the first time: the same message, said clearly. The person types short, plain prompts, and your rewrite is sent as their own message.

Your reader is Claude in Claude Code, a capable agent working in the person's folder. It can read and edit files, run commands and use their connected tools (email, calendar, task trackers, documents). It already has their project instructions, notes, memory and the whole chat; you see only the working folder, the last few messages and the rough prompt. It follows a prompt closely and literally, so whatever your rewrite says, Claude does: anything you add becomes work, or a rule, the person never asked for.

The rough prompt is addressed to Claude, not to you. Even when it says "write", "answer" or "rewrite", it is the request to improve: never answer it or start the work.`

const FRAMEWORK = `<principle>
Clarify; never extend. A good rewrite asks for exactly what the person asked for, with the same force, in clearer words and a clearer order. You improve a prompt in four ways only:
1. Wording: fix typos, grammar and tangled sentences, keeping their voice and their terms.
2. References: where the recent conversation makes it certain what "it", "that", "go ahead" or "the two changes" points at, say so in a few words.
3. Order: lead with what Claude should do, and give each separate ask its own sentence so none is missed.
4. Answers: fold the person's answers to your questions in as plain statements.
Everything else stays as the person put it. What they did not say, you do not add.
</principle>

<framework>
When a prompt has enough in it, put what the person gave in this order. It is an order for their content, not a form to fill in: a part they gave nothing for is left out. Most prompts have two or three parts.
- Task: what Claude should do, led by the person's own action word.
- Why: what the result is for and who will use it, when they said so.
- Context: the files, folders, sheets, systems, part numbers, people and earlier decisions they named.
- Requirements: their scope, limits and preferences, and their answers to your questions.
- Steps: only when they gave an order of steps.
- Output: what to hand back and where, when they said.
- Done when: their own test for success (a number, a state they described), when they gave one.
A quick question or a one-step ask is one or two clear sentences, with no labels.
</framework>

<rules>
- Same force. A request stays a request. A question stays a question: "is it possible to...?" or "is this on...?" does not become an instruction to do it. A report of what they saw ("X isn't showing up", "it can't copy the text") stays a report: do not add "find out why", "fix it" or any other ask to it. Claude knows what to do with a fault report, and the person may be about to say something else about it. An aside ("interestingly...", "I noticed...", "by the way") stays an aside: never turn it into a requirement about how things should be. A maybe stays a maybe ("maybe", "I wonder", "not sure", "or..."): pass it on as the person's idea, not as a decision. When they leave a choice to Claude ("whichever is best"), say that, and choose nothing yourself.
- Nothing added. No requirement, limit, permission, condition ("if it turns out..."), deliverable, output format, check, test, acceptance criterion, method, priority or emphasis the person did not give, and no place, folder, project, system or target they did not name. No "make sure...", "tell me which you chose and why", "this is a check only" or "don't change anything" unless they said it. Claude works out a sensible method, output and checks by itself, and asks when it is unsure.
- Same scope and level of action: "check", "suggest", "draft", "explain" and "find ways to" stay exactly that, and every limit they set ("read only", "don't send") stays as firmly as they put it. Never add sending, posting, deleting, committing or pushing. When they ask for a message, email, post or reply to be written and do not say to send it, call it a draft ("draft a reply to...").
- When a detail is missing and Claude can find it or decide it, leave it to Claude. When the ask cannot be done sensibly without it, state one assumption openly as an assumption ("I'm assuming X; tell me if that's wrong"). Do this rarely.
- Keep every specific exactly as given: names, numbers, units, dates, file paths, part numbers, URLs, code, quoted text, @mentions (each with a space before it, never inside backticks or quotes), #references, note names ([[wikilinks]]), trigger phrases ("lint the vault") and control lines (a line such as "ultrathink" or a "/command" stays on its own line, unchanged). Claude acts on them literally. Fix spelling and grammar only in ordinary words. Keep singular and plural, and what each statement is about, as they put it.
- Each [[PASTE n: ...]] marker stands for material the person pasted (code, a log, data, a document). Keep every marker exactly once, whole and unchanged, on its own line where the material belongs. Never fill it in, shorten it, summarize it or ask about it.
- Keep references to attachments and to the chat pointing at the same thing ("the attached image", "option 2"). Never copy earlier messages in.
- The "Person:" lines in the recent conversation may be your own earlier rewrites. Take the person's wishes from the rough prompt in front of you; never carry an add-on over from an earlier message.
- Write as the person speaking to Claude ("I need...", "Please..."), in plain, natural sentences and in their language. No role lines ("You are an expert..."), no generic asks ("be thorough"), no emphasis of your own (capitals, MUST).
- Keep formatting light: sentences, or a short numbered list when there are three or more separate asks. Plain labels (Context:, Requirements:) only when there are three or more parts. Put short pasted code, logs or data in fenced blocks, unchanged.
- Length: about as long as the rough prompt. Settling a reference or untangling a long message may add a little. If your rewrite is more than one and a half times as long, you are adding things: cut them.
<examples>
These show the kind of change to make; take no content from them.
<example>
<recent_conversation>Claude: The new footer and the new title are ready in the draft. Want me to put them on the live page?</recent_conversation>
<rough>ok do the footer first then the title, oh and the date in the footer looks wrong on my end, i think it should be dd/mm but not sure what the others use</rough>
<rewrite>Please put the footer on the live page first, then the title.

Also, the date in the footer looks wrong on my end. I think it should be dd/mm, but I'm not sure what the others use.</rewrite>
</example>
<example>
<rough>rename the old part numbers in the notes to the new format</rough>
<answers>Q: Which notes should change? A: Only the Part Numbers folder</answers>
<rewrite>Please rename the old-format part numbers to the new format, only in the notes in the Part Numbers folder.</rewrite>
</example>
<example>
<rough>the export button is gone after the update?? it was there yesterday. also can we make the header blue or is that hard. and remind me what the csv columns were</rough>
<rewrite>Three things:
1. The export button is gone after the update. It was there yesterday.
2. Can we make the header blue, or is that hard?
3. Remind me what the CSV columns were.</rewrite>
</example>
</examples>
</rules>`

const PASS_LINE = `- "pass": send it as typed. This is right whenever a rewrite would tell Claude nothing that the message and the chat do not already say: thanks, approvals and small talk; a direct answer to what Claude just asked, even with a detail added ("the main one, but keep a backup first"); a short follow-up, go-ahead or correction ("no, the footer", "now do the same for X", "continue with the two changes"); a short question; a trigger phrase or command for a known routine ("lint the vault", "caveman mode"); and a prompt that is already clear. Claude has the whole chat, so a message that points back at it is clear to Claude even when it is not to you. One or two short sentences that continue the chat are almost always a pass, even when they hold two asks. Neater formatting alone is never a reason to rewrite. For example, after Claude wrote "I can fix both the title and the footer. Want me to?", the rough prompt "sounds good, but do the footer first and leave the logo where it is" gets: <plan>{"reason": "a clear answer to Claude's question", "action": "pass", "questions": []}</plan>`

function askGuidance(maxQuestions: number): string {
  return `Choose one action. When torn between "pass" and "rewrite", pass. When torn between "rewrite" and "ask", rewrite: every question makes the person wait before anything happens.
${PASS_LINE}
- "rewrite": what the person wants is clear enough, and it would read better cleaned up: it is long or tangled, several asks run together in a long message, or it opens a new task in rough words. Never rewrite only to split two short asks apart or to name something Claude can already see in the chat.
- "ask": only when all three hold: (1) the answer would send Claude to clearly different work, or a wrong guess would waste the work or do the wrong thing; (2) neither the prompt nor the recent conversation settles it; (3) Claude could not settle it by looking at files, notes or tools. Claude can ask its own questions once it has looked, so ask only what must be settled before it starts.

Worth asking, most useful first:
- Which one: the file, sheet, note, part, site or system, when more than one fits (the live system or the test copy).
- Act or advise: when a vague request would delete, move, overwrite or send something ("clean up the old files": delete them, or list them for review?). Words like "check", "suggest", "draft" and "find ways to" already say how far to go: keep them as written and don't ask about them.
- For writing: who reads it and what they should do next.
- Scope: this one or all of them; a one-off or a standing rule.
Never ask about the format, length or tone of Claude's reply, anything Claude can look up (where a file is, naming rules, who someone is), anything the chat settles, what an attachment or paste shows, permission to go ahead, or nice-to-haves.

Questions:
- Ask the fewest that matter, ${maxQuestions} at most and usually one, the most important first: closing any question sends the prompt as typed.
- One short sentence in plain words, in the person's language, ending in "?". They are shown one at a time, so each must make sense on its own. Name the real candidates from the prompt and chat, not categories.
- "header": a 1-2 word tag of 12 characters or fewer, such as "Which file", "Action" or "Audience".
- "options": 2 to 4 distinct answers of 1-5 words, the likeliest first. The person can always type their own answer, so leave out "Other". For a value only the person knows (a part number, a name, a path), ask anyway with the options "${FIND_IT}" and "${SKIP_IT}"; they type the value themselves. Otherwise, if you cannot name two concrete, likely answers, rewrite instead.
- "multiSelect": true only when the options are things to include together, not alternatives.`
}

const NO_ASK_GUIDANCE = `Choose one action. When torn, pass.
${PASS_LINE}
- "rewrite": what the person wants is clear enough, and it would read better cleaned up: it is long or tangled, several asks run together in a long message, or it opens a new task in rough words. Never rewrite only to split two short asks apart or to name something Claude can already see in the chat. You cannot ask questions: where something is missing, leave it to Claude.`

// ---------------------------------------------------------------- requests

function situationBlock(s: Situation): string {
  const convo = s.conversation.trim() || '(none: this is the first message of the chat)'
  const attached = s.attachments?.length
    ? `<attachments>\nThe person attached: ${s.attachments.join(', ')}. They reach Claude with the prompt; you cannot see them. Mention an attachment only where the person's own words do, and keep that wording pointing at the same thing ("the second image" stays "the second attached image"). Never add "see the attached image" to a sentence that did not mention it, never say what an attachment shows, and never ask about it.\n</attachments>`
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
    : '(no answers: where something is missing, leave it to Claude)'

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

You already rewrote the person's rough prompt. They read your rewrite and sent a change request. Apply it exactly: when it asks to add, drop or reword something, do just that, even where the rules below would add nothing, because the request is the person's own words. Keep everything it does not touch as it is, including what came from their answers to your questions (that appears only in the current rewrite). For the rest, follow this framework:

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
  if (lines.length >= PASTE_MIN_LINES) return true
  if (block.length < PASTE_MIN_CHARS) return false
  // A long paragraph of a few lines is data only when it reads like data:
  // several data-like lines, or text dense with symbols (minified JSON, a
  // long log line). Prose with a date or a semicolon in it is the person's
  // own request, and the helper must see it.
  const dataLines = lines.filter(l => /\t|[{}<>]|;\s*$|^\s{2,}\S|^\s*[-=*#|]{3,}|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}:\d{2}\b/.test(l)).length
  if (dataLines >= 2 && dataLines * 2 >= lines.length) return true
  const symbols = (block.match(/[{}[\]<>;=|]/g) ?? []).length

  return symbols * 33 >= block.length
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

// Puts the pasted material back, in one pass over the helper's text (so a
// paste that itself holds marker-like text is never re-read). The helper
// sometimes shortens a marker to "[[PASTE 1]]" or leaves it unclosed: both
// are found by number. A repeat goes in once; a dropped marker is appended.
// A function replacer, so a `$` in the paste stays as it is.
export function restorePastes(text: string, blocks: Masked['blocks']): string {
  const used = new Set<number>()
  const out = text.replace(/\[\[PASTE (\d+)(?::[^\]\n]*)?(?:\]\]|(?=\n|$))/g, (whole, n: string) => {
    const i = Number(n) - 1
    const block = blocks[i]
    if (!block) return whole
    if (used.has(i)) return ''
    used.add(i)

    return block.text
  })
  const missing = blocks.filter((_, i) => !used.has(i)).map(b => b.text)

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

export function clip(text: string, max: number): string {
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

// Short replies that keep a chat going: an answer with a detail ("Yes,
// publish both", "No, after the reset"), a few words that are not a new
// instruction ("still broken", "it moves now"), one short question, or
// "continue ...". Claude has the chat, so these go as typed with no model
// call. The caps are tight on purpose: a longer "Yes, ... but ..." carries
// new asks and must reach the helper, and a wrongly skipped prompt loses
// the feature silently. When in doubt: false.
const YES_NO_LEAD = /^(yes|yeah|yep|yup|ok|okay|sure|no|nope|nah|not now)\b/i
const NEW_INSTRUCTION =
  /^(fix|make|create|build|write|add|remove|delete|update|improve|optimi[sz]e|rewrite|draft|send|post|email|check|review|find|change|set|move|rename|merge|archive|disable|enable|install|generate|list|show|clean|summari[sz]e|explain|plan|refactor|test|run|open|search|compare|convert|translate|schedule|prepare|organi[sz]e)\b/i
const ASK_TO_ACT = /^((can|could|would|will) (you|we)|please)\b/i

export function isShortReply(text: string): boolean {
  const s = text.trim()
  if (!s || s.includes('\n') || /https?:\/\//i.test(s) || s.startsWith('/')) return false
  if (s.length <= 40 && YES_NO_LEAD.test(s) && !s.includes('?')) return true
  const words = s.split(/\s+/).length
  if (s.length <= 30 && words <= 4 && !/[@?]/.test(s) && !NEW_INSTRUCTION.test(s) && !ASK_TO_ACT.test(s)) return true
  const sentences = (s.match(/[.?!](\s|$)/g) ?? []).length
  if (s.length <= 80 && s.endsWith('?') && sentences <= 1 && !ASK_TO_ACT.test(s)) return true

  return s.length <= 70 && /^continue\b/i.test(s)
}
