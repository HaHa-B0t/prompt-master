// Runs Prompt Master's helper-model instructions against a set of rough
// prompts with REAL model calls, the way the mod makes them (one system
// prompt, one user message, no tools), and records what came back.
//
//   node eval/run-eval.mjs [--prompts hooks/prompts.ts] [--cases eval/cases.json]
//                          [--out eval/out/<label>.json] [--label name]
//                          [--model sonnet] [--effort low|medium|high]
//                          [--concurrency 4] [--follow-asks] [--only id1,id2]
//
// With no flags it runs the mod's own prompts.ts on the made-up cases beside
// this file. Each case costs one small model call on your Claude account
// (two when the helper asks a question and --follow-asks is on).
//
// Each call goes through `claude -p` with tools, MCP servers and user settings
// off, so the request is close to what $.model.complete sends.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  return i < 0 ? undefined : (process.argv[i + 1] ?? '')
}
const has = name => process.argv.includes(`--${name}`)

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const promptsPath = path.resolve(arg('prompts') ?? path.join(here, '..', 'hooks', 'prompts.ts'))
const cases = JSON.parse(fs.readFileSync(arg('cases') ?? path.join(here, 'cases.json'), 'utf8'))
const model = arg('model') ?? 'sonnet'
const effort = arg('effort')
const concurrency = Number(arg('concurrency') ?? 4)
const only = arg('only')?.split(',')
const label = arg('label') ?? 'run'
const outPath = arg('out') ?? path.join(here, 'out', `${label}.json`)
fs.mkdirSync(path.dirname(outPath), { recursive: true })
const MAX_QUESTIONS = 3

const P = await import(pathToFileURL(promptsPath).href)

const runDir = path.join(here, 'run-cwd')
fs.mkdirSync(runDir, { recursive: true })

function callModel(system, prompt) {
  return new Promise(resolve => {
    const args = [
      '-p',
      '--model', model,
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', 'project',
      '--no-session-persistence',
      '--output-format', 'json',
      '--system-prompt', system,
      ...(effort ? ['--effort', effort] : []),
    ]
    const child = spawn('claude', args, { cwd: runDir, windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill(), 240_000)
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', e => {
      clearTimeout(timer)
      resolve({ error: String(e) })
    })
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const j = JSON.parse(out)
        const u = j.usage ?? {}
        resolve({
          text: typeof j.result === 'string' ? j.result : '',
          isError: j.is_error === true,
          apiMs: j.duration_api_ms ?? 0,
          inTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outTokens: u.output_tokens ?? 0,
          thinkingTokens: u.output_tokens_details?.thinking_tokens ?? 0,
        })
      } catch {
        resolve({ error: `unreadable output: ${(out || err).slice(0, 300)}` })
      }
    })
    child.stdin.end(prompt)
  })
}

const words = s => (s ?? '').trim().split(/\s+/).filter(Boolean).length

async function runCase(c) {
  const masked = P.maskPastes(c.raw)
  const situation = { raw: masked.text, conversation: c.conversation ?? '', cwd: c.cwd ?? '', attachments: c.attachments ?? [] }
  const rec = { id: c.id, group: c.group, expect: c.expect, original: c.raw, calls: 0, apiMs: 0, outTokens: 0, thinkingTokens: 0 }
  const add = r => {
    rec.calls += 1
    rec.apiMs += r.apiMs ?? 0
    rec.outTokens += r.outTokens ?? 0
    rec.thinkingTokens += r.thinkingTokens ?? 0
    rec.inTokens = r.inTokens
  }

  const req = P.analyzeRequest(situation, MAX_QUESTIONS)
  const first = await callModel(req.system, req.prompt)
  if (first.error || first.isError) return { ...rec, action: 'error', error: first.error ?? first.text }
  add(first)
  rec.reply = first.text

  if (P.isCutOff(first.text)) return { ...rec, action: 'cutoff' }
  const plan = P.parsePlan(first.text, MAX_QUESTIONS)
  if (!plan) return { ...rec, action: 'unreadable' }
  rec.action = plan.action
  rec.reason = plan.reason

  if (plan.action === 'rewrite') rec.final = P.restorePastes(plan.prompt, masked.blocks)
  if (plan.action === 'ask') {
    rec.questions = plan.questions
    if (has('follow-asks')) {
      // The person picks the first option of each question.
      const answers = plan.questions.map(q => ({ question: q.question, answer: q.options[0] === P.FIND_IT ? 'Not given: Claude should look it up.' : q.options[0] }))
      rec.answers = answers
      const req2 = P.rewriteRequest(situation, answers)
      const second = await callModel(req2.system, req2.prompt)
      if (!second.error && !second.isError) {
        add(second)
        const text = P.extractPrompt(second.text)
        if (text) rec.final = P.restorePastes(text, masked.blocks)
      }
    }
  }
  if (rec.final) {
    rec.wordsIn = words(c.raw)
    rec.wordsOut = words(rec.final)
    rec.growth = Number((rec.wordsOut / Math.max(1, rec.wordsIn)).toFixed(2))
  }
  return rec
}

const todo = cases.filter(c => !only || only.includes(c.id))
const results = new Array(todo.length)
let next = 0
const started = Date.now()
await Promise.all(
  Array.from({ length: Math.min(concurrency, todo.length) }, async () => {
    while (next < todo.length) {
      const i = next++
      results[i] = await runCase(todo[i])
      process.stderr.write(`${label} ${i + 1}/${todo.length} ${results[i].id}: ${results[i].action} ${results[i].apiMs}ms\n`)
    }
  }),
)

const median = xs => {
  const s = xs.filter(x => typeof x === 'number').sort((a, b) => a - b)
  return s.length ? s[s.length >> 1] : null
}
const count = k => results.filter(r => r.action === k).length
const summary = {
  label,
  model,
  effort: effort ?? '(default)',
  cases: results.length,
  actions: { pass: count('pass'), rewrite: count('rewrite'), ask: count('ask'), other: results.length - count('pass') - count('rewrite') - count('ask') },
  medianFirstCallMs: median(results.map(r => (r.calls === 1 ? r.apiMs : null))),
  medianApiMsAll: median(results.map(r => r.apiMs)),
  medianThinkingTokens: median(results.map(r => r.thinkingTokens)),
  medianOutTokens: median(results.map(r => r.outTokens)),
  medianGrowth: median(results.map(r => r.growth)),
  maxGrowth: Math.max(0, ...results.map(r => r.growth ?? 0)),
  systemChars: P.analyzeRequest({ raw: 'x', conversation: '', cwd: '' }, MAX_QUESTIONS).system.length,
  wallSeconds: Math.round((Date.now() - started) / 1000),
}
fs.writeFileSync(outPath, JSON.stringify({ summary, results }, null, 2))
console.log(JSON.stringify(summary))
