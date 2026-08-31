## Introduction

Vibe-forked from opencode-visual-cache, adding first-token latency (TTFT), generation speed (TPS), and more.

<div align="center">
<img src="https://raw.githubusercontent.com/doorlockdoor/opencode-visual-cache/master/assets/screen_shot_2026-08-31_170417.png"></img>
</div>

Performance:
- **TTFT**: Time to first token — perceived time from when the request is sent to when the first token arrives.
- **TPS**: Token generation speed (excluding tool-call time).
- **Latency**: Model generation time per request (excluding tool-call time).
- Errors introduced by OpenCode's auto-compaction are ignored.

## Local Build

`npm run build`, then copy `dist\tui.js` into the OpenCode plugin folder and rename it to `opencode-visual-cache.js`.

```powershell
npm run build; if ($?) { New-Item -ItemType Directory -Force "$env:APPDATA\opencode\plugins" | Out-Null; Copy-Item dist\tui.js "$env:APPDATA\opencode\plugins\opencode-visual-cache.js" -Force }
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
