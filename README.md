# Prompt Master

Polishes your rough prompt before Claude reads it.

1. You send a prompt as usual.
2. Prompt Master reads it, with the last few messages of the chat for context.
3. If something that changes the result is missing, it asks you (up to 3 short questions, in Claude's own question dialog).
4. It rewrites the prompt with a clear frame (Task, Why, Context, Requirements, Steps, Output, Done when; only the parts that help) and sends the rewrite.

Once a prompt is polished, a **💬** appears next to the ✨ above the prompt box. Click it to see the latest polished prompt (what Claude received), with **Put in prompt box** in the apps (to edit and resend it) or **Copy it** in a terminal. The desktop app's bubble shows your own words; the mobile app shows the polished version.

Your facts, names, numbers, file paths and part numbers are kept exactly. Nothing is invented. Long pastes (logs, tables, code) go through untouched.

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
- Or type `/prompt-master` (toggle), `/prompt-master on`, `/prompt-master off`, `/prompt-master status`.
- The setting is remembered across sessions.

## Skipped automatically

- Slash commands, and quick replies like "yes", "ok", "2".
- Prompts typed while Claude is still working.
- Scheduled and other unattended runs (nobody is there to answer questions).
- Any prompt you start with `::` (sent as typed, minus the `::`).

## When it sends your prompt as typed

A short notice tells you why: it was already clear, or Claude was still working, or a question was closed. Quick replies like "yes" go through quietly.

## If you close a question

Your prompt goes to Claude exactly as you typed it.

## Settings

In the plugin's settings:

- **Prompt Master model**: `sonnet` (default), `opus` or `haiku`.
- **Most questions per prompt**: 0 to 4 (default 3; 0 = never ask, just rewrite).
- **Review before sending**: show the polished prompt first, then choose Send it, Try another version (a fresh rewrite), Send my original, or type what to change. The dialog's own Skip button also sends your original.

Each polished prompt costs one or two extra model calls.
