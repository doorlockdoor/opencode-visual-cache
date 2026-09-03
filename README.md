## 介绍

Vibe自opencode-visual-cache，新增首字延迟（TTFT），生成速度（TPS）等信息，支持实时刷新。

<div align="center">
<img src="https://raw.githubusercontent.com/doorlockdoor/opencode-visual-cache/master/assets/screen_shot_2026-08-31_170417.png"></img>
</div>

**信息包含**：
- **TTFT**：首字延迟，从用户发出请求（step）到第一个token的体感时间。
- **TPS**：token生成速度（去除工具调用时间）。
- **Latency**：单次请求（step）的模型生成耗时（体感时间，去除工具调用时间）。
- 忽略opencode自动压缩造成的误差，忽略工具暂停（例如提问）时的计数。

**实时TPS估算**：
- 流式传输时token数为估算值（≈），不同模型会有偏差，传输结束后替换为精确值。
- 汉字：1.5字/token（GPT-o200k实测1.34，DeepSeek-V4实测1.52）。
- ASCII：思考流4.0，答案文本2.9，工具与代码3.7，散文默认3.3。
- 全角标点与全角字符按1处理。

## 本地构建

`npm run build`，然后复制`dist/tui.js`到`~/.config/opencode/plugins`，重命名为`opencode-visual-cache.js`。

```powershell
npm run build; if ($?) { New-Item -ItemType Directory -Force "~\.config\opencode\plugins" | Out-Null; Copy-Item dist\tui.js "~\.config\opencode\plugins\opencode-visual-cache.js" -Force }
```

编辑`~/.config/opencode/tui.json`，添加本地插件。

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    // ...
    "./plugins/opencode-visual-cache.js"
  ]
}
```

编辑`~/.config/opencode/package.json`，添加依赖。

```jsonc
{
  "dependencies": {
    // ...
    "@opentui/solid": "0.4.5"
  }
}
```

重启opencode。

## License

MIT
