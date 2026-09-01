## 介绍

Vibe自opencode-visual-cache，新增首字延迟（TTFT），生成速度（TPS）等信息，支持实时刷新。

<div align="center">
<img src="https://raw.githubusercontent.com/doorlockdoor/opencode-visual-cache/master/assets/screen_shot_2026-08-31_170417.png"></img>
</div>

信息包含：
- **TTFT**：首字延迟，从请求（step）发起到第一个token的体感时间。
- **TPS**：token生成速度（去除工具调用时间）。
- **Latency**：单次请求（step）的模型生成耗时（去除工具调用时间）。
- 忽略opencode自动压缩造成的误差，忽略工具暂停（例如提问）时的计数。

## 本地构建

`npm run build`，然后复制`dist\tui.js`到opencode插件文件夹，重命名为`opencode-visual-cache.js`。

```powershell
npm run build; if ($?) { New-Item -ItemType Directory -Force "~\.config\opencode\plugins" | Out-Null; Copy-Item dist\tui.js "~\.config\opencode\plugins\opencode-visual-cache.js" -Force }
```

编辑`tui.json`，重启opencode。

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
