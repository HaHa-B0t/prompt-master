// What the band shows while Prompt Master works on a prompt.
export type Phase = 'idle' | 'reading' | 'asking' | 'writing' | 'review'

// A polished prompt, shown in a row under the person's own message.
export type Polished = { text: string; isOpen: boolean }

declare module 'claude-code' {
  interface PluginState {
    'prompt-master': { isOn: boolean; phase: Phase; polished: StateFamily<Polished> }
  }
}
