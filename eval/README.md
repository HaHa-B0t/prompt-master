# Checking a change to the helper instructions

`hooks/prompts.ts` holds the instructions Prompt Master gives its helper model. A change there can't be judged by reading it: run it.

```bash
node eval/run-eval.mjs --label before        # on the current prompts.ts
# ...edit hooks/prompts.ts...
node eval/run-eval.mjs --label after --follow-asks
```

Each run sends every case in `cases.json` through the real helper call (`claude -p`, no tools, low cost: one small call per case) and writes `eval/out/<label>.json`: what the helper chose (pass, ask or rewrite), the rewrite, how much longer it is than the original, and how long the call took.

The cases are made up. Each has an `expect` note saying what a good result looks like: a question stays a question, an observation stays an observation, nothing is added, short replies pass. Read the rewrites against those notes, or have a second model judge two runs side by side without knowing which is which.

What to watch in the summary line: `medianGrowth` (a rewrite should be about as long as the original; 0.1.8 was about 3x, 0.2.0 about 1.1x) and the number of passes.

Needs Node 22.6 or newer (it imports the TypeScript file directly) and the `claude` command signed in. Don't put real prompts in `cases.json`: this repository is public.
