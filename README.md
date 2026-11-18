# Prompt Master

Polishes your rough prompt before Claude reads it.

1. You send a prompt as usual.
2. Prompt Master reads it, with the last few messages of the chat for context.
3. If something that changes the result is missing, it asks you (up to 3 short questions, in Claude's own question dialog).
4. It rewrites the prompt so it says the same thing clearly, and sends the rewrite.

Before it is sent, the polished prompt is shown in full in Claude's question dialog: Send it, Try another version, Send my original, or type what to change (review, on by default). The desktop app's bubble shows your own words; the mobile app shows the polished version.

## What a rewrite changes, and what it never does

It clarifies; it never extends. A rewrite:

- cleans up wording (typos, grammar, tangled sentences) in your own voice;
- settles references from the chat ("go ahead" becomes "go ahead and add the date filter");
- puts the ask first and gives each separate ask its own sentence, in the order Task, Why, Context, Requirements, Steps, Output, Done when (only the parts you gave);
- folds in your answers to its questions.

It adds nothing you did not say: no extra requirements, limits, permissions, checks, deliverables or "done when" lines. A question stays a question, an observation stays an observation, and a "maybe" stays a maybe. The one thing it makes explicit: a message or email you ask for is a draft unless you say to send it.

Your facts, names, numbers, file paths and part numbers are kept exactly. Long pastes (logs, tables, code) go through untouched. A rewrite is about as long as what you typed.

## Install

At the prompt of a terminal session:

```
/plugin install prompt-master --marketplace HaHa-B0t/prompt-master
```

From a shell:

```bash
claude plugin install prompt-master --marketplace HaHa-B0t/prompt-master
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `HaHa-B0t/prompt-master`, then Add plugin.

Answer `y` to add the marketplace, then pick a scope (user is first).

## On / off

- Click the **✨** in the band right above the prompt box: bright when on, dim when off. With [usage-bars-chat](https://github.com/HaHa-B0t/usage-bars-chat) it sits at the start of the bars row.
- Or type `/prompt-master` (toggle), `/prompt-master on`, `/prompt-master off`.
- `/prompt-master status` says whether it is on, and how many prompts were polished, sent as your original after review, already clear, quick replies, or skipped (sent as typed because Claude was still working, the helper failed or a question was closed). It keeps counts only, never any text.
- The setting is remembered across sessions.

## Skipped automatically

- Slash commands, and quick replies like "yes", "ok", "2".
- Short replies that keep a chat going: "Yes, publish both", "No, after the reset", "still broken", one short question. Claude has the chat, so these go as typed at once, with no wait.
- Prompts typed while Claude is still working.
- Scheduled and other unattended runs (nobody is there to answer questions).
- Any prompt you start with `::` (sent as typed, minus the `::`).

## When it sends your prompt as typed

A short notice tells you why: it was already clear, or Claude was still working, or a question was closed. Quick and short replies go through quietly.

## If you close a question or the review

Your prompt goes to Claude exactly as you typed it.

## Settings

In the plugin's settings (desktop app: Settings → Customize → Prompt master → Settings):

- **Prompt Master model**: the model that reads your prompt and writes the suggested one: `opus` (default), `sonnet` or `haiku`.
- **Most questions per prompt**: pick 1, 2, 3 or 4 (default 3). Updating from 0.2.1 or earlier sets this back to 3, so pick your number again.
- **Review before sending** (default on): show the polished prompt first, then choose Send it, Try another version (a fresh rewrite), Send my original, or type what to change. The dialog's own Skip button also sends your original.

Each prompt that reaches the helper costs one quick model call, two when it asks you a question, plus one for each new version or change you ask for in review (at most three). Quick and short replies cost none.
