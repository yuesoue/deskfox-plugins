---
description: 把 Markdown 转成 A4 打印样式的 HTML，自动用浏览器打开；需要 PDF 时在浏览器里 Ctrl+P 另存
---

请调用 `getbot_md2html` 工具，把 Markdown 文件转成适合打印的 HTML 并自动打开浏览器，参数 filePath 使用：$ARGUMENTS

工具会返回生成的 HTML 路径；把该路径原样告诉我。如果需要 PDF，再提醒我在浏览器里按 Ctrl+P（macOS：Cmd+P）选"另存为 PDF"。

## 输出约定（如果是你生成 md 再调用本工具）

- 表格一律使用 GFM pipe table（`| 列 | 列 |` 配 `|---|---|`）。
- 不要使用 Unicode 框字符（`┌─┐│├┼┤└┴┘╔═╗║╠╣╚╝` 等）或 ASCII `+---+` 画表格；必须保留原样时，放入 ```text 代码块。
- 超长 URL 用 `[短文本](url)` 形式，避免裸粘贴。

