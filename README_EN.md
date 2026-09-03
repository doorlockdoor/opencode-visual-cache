## Introduction

Vibe-forked from opencode-visual-cache, adding first-token latency (TTFT), generation speed (TPS), and more, with real-time refresh.

<div align="center">
<img src="https://raw.githubusercontent.com/doorlockdoor/opencode-visual-cache/master/assets/screen_shot_2026-08-31_170417.png"></img>
</div>

**Included metrics**:
- **TTFT**: Time to first token — perceived time from when the user sends a request (step) to when the first token arrives.
- **TPS**: Token generation speed (excluding tool-call time).
- **Latency**: Model generation time per request (step) — perceived time, excluding tool-call time.
- Errors introduced by OpenCode's auto-compaction are ignored, and counting is paused while tools are suspended (e.g. asking a question).

**Real-time TPS estimation**:
- While streaming, the token count is an estimate (≈) that varies slightly by model; it is replaced with the exact value once the stream ends.
- Chinese characters: 1.5 chars/token (measured 1.34 on GPT-o200k, 1.52 on DeepSeek-V4).
- ASCII: 4.0 for reasoning streams, 2.9 for answer text, 3.7 for tools & code, 3.3 default for prose.
- Full-width punctuation and full-width characters are counted as 1.

## Local Build

Run `npm run build`, then copy `dist/tui.js` into `~/.config/opencode/plugins` and rename it to `opencode-visual-cache.js`.

```powershell
npm run build; if ($?) { New-Item -ItemType Directory -Force "~\.config\opencode\plugins" | Out-Null; Copy-Item dist\tui.js "~\.config\opencode\plugins\opencode-visual-cache.js" -Force }
```

Edit `~/.config/opencode/tui.json` to add the local plugin.

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    // ...
    "./plugins/opencode-visual-cache.js"
  ]
}
```

Edit `~/.config/opencode/package.json` to add the dependency.

```jsonc
{
  "dependencies": {
    // ...
    "@opentui/solid": "0.4.5"
  }
}
```

Restart OpenCode.

## License

MIT
