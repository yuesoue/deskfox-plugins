---
description: 把 Markdown 转成 A4 打印样式的 HTML，可导出 PDF
---

请只调用一次 `getbot_md2html` 工具，filePath 参数使用：$ARGUMENTS

调用后把返回的 HTML 路径原样告诉我，不要再次调用任何工具。

## 输出约定（如果是你生成 md 再调用本工具）

- 表格一律使用 GFM pipe table（`| 列 | 列 |` 配 `|---|---|`）。
- 不要使用 Unicode 框字符（`┌─┐│├┼┤└┴┘╔═╗║╠╣╚╝` 等）或 ASCII `+---+` 画表格；必须保留原样时，放入 ```text 代码块。
- 超长 URL 用 `[短文本](url)` 形式，避免裸粘贴。
