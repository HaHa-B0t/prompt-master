// What the band shows while Prompt Master works on a prompt.
export type Phase = 'idle' | 'reading' | 'asking' | 'writing' | 'review'

declare module 'claude-code' {
  interface PluginState {
    // lastPolished: this chat's latest polished prompt, '' until one is sent.
    'prompt-master': { isOn: boolean; phase: Phase; lastPolished: string }
  }
}
