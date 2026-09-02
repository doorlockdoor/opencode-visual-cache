## Introduction

Vibe-forked from opencode-visual-cache, adding first-token latency (TTFT), generation speed (TPS), and more, with real-time refresh.

<div align="center">
<img src="https://raw.githubusercontent.com/doorlockdoor/opencode-visual-cache/master/assets/screen_shot_2026-08-31_170417.png"></img>
</div>

Included metrics:
- **TTFT**: Time to first token — perceived time from when the user sends a request (step) to when the first token arrives.
- **TPS**: Token generation speed (excluding tool-call time).
- **Latency**: Model generation time per request (step) — perceived time, excluding tool-call time.
- Errors introduced by OpenCode's auto-compaction are ignored, and counting is paused while tools are suspended (e.g. asking a question).

## Local Build

Run `npm run build`, then copy `dist\tui.js` into the OpenCode plugin folder and rename it to `opencode-visual-cache.js`.

```powershell
npm run build; if ($?) { New-Item -ItemType Directory -Force "~\.config\opencode\plugins" | Out-Null; Copy-Item dist\tui.js "~\.config\opencode\plugins\opencode-visual-cache.js" -Force }
```

Edit `tui.json`, then restart OpenCode.

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "./plugins/opencode-visual-cache.js"
  ]
}
```

## License

MIT
