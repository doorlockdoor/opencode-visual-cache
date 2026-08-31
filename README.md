## 介绍

Vibe自opencode-visual-cache，新增首字延迟（TTFT），生成速度（TPS）等信息。

<div align="center">
<img src="https://raw.githubusercontent.com/doorlockdoor/opencode-visual-cache/master/assets/screen_shot_2026-08-31_170417.png"></img>
</div>

性能：
- **TTFT**：首字延迟，从请求发起到第一个Token的体感时间。
- **TPS**：token生成速度（去除工具调用时间）。
- **Latency**：单次请求的模型生成耗时（去除工具调用时间）。
- 忽略opencode自动压缩造成的误差。

## 本地构建

`npm run build`，然后复制`dist\tui.js`到opencode插件文件夹，重命名为`opencode-visual-cache.js`。

```powershell
npm run build; if ($?) { New-Item -ItemType Directory -Force "$env:APPDATA\opencode\plugins" | Out-Null; Copy-Item dist\tui.js "$env:APPDATA\opencode\plugins\opencode-visual-cache.js" -Force }
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
