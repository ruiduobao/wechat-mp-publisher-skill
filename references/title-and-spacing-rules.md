# 标题与换行

列表外题按语义提炼。当前账号新外题不超过15字；不截断英文单词、机构名或科学含义。通过 `--title-override` 或私有 `--titles` 映射传入。旧外题优先保留，已确认错误时显式修正。

正文第一元素保留完整原题 H1，只有一个，不能缩短。源文首 H1 在渲染预处理时提取，完整粘贴时一并写入，不先把整个正文粘进旧 H1。已有正确标题直接复用；修改已有 H1 的文字用原生输入，新增标题用原生 HTML 粘贴。发现多 H1 或标题包含正文块时停止元数据修补，按源文在原 ID 完整重建。

正文中的栏目、期刊、作者等元数据各自换行。普通 Markdown 合法行尾两空格硬换行需要保留；不能全局 trim 每行尾空格。围栏代码块和行内代码中的图片示例和代码缩进必须保护，不能作为待上传图片处理或被去掉缩进。

## 零缩进与零空行规范

1. **源文与 HTML 清洗（防莫名缩进）**：
   - `prepareMarkdownWithAbsoluteImages` 在代码块保护之外，清除普通段落、标题与引用块行首多余的空格、Tab、全角空格 `\u3000` 与不间断空格 `\u00A0`；保留合法列表前缀。
   - `sanitizeWechatHtml` 清除 `<p>`、`<ul>`、`<ol>`、`<li>` 上的 `margin-left`、`margin-right`、`padding-left`、`text-indent` 及主题自带的 `margin: 1.5em 8px` / `0.5em 8px` / `padding-left: 1.5em` 水平缩进，统一左对齐至 `0`，并剥离块首 `&nbsp;`/`\u3000`。
   - `injectHtmlIntoProseMirror` 展开外层 `section.container` 并清除标签间的纯空白文本节点，防止粘贴后在 H1 下或正文末尾凭空生出空白段落。
2. **原生按键清零空行**：
   - 图片占位符独占一行时，删除锚点标记后如段落变空，立即补发原生 `Backspace` 消除该空 `<p>`。
   - 全部组件插入完成、保存之前，调用 `cleanupEmptyParagraphsNatively` 遍历 H1 后、图片前后、正文内部及名片前的所有空 `<p>`/`<div>`，通过浏览器原生 `Backspace`/`Delete` 按键由 ProseMirror 模型移除（绝不直接调用 `el.remove()` 伪造）。
3. **重开双重验收**：保存前预检与独立标签重开后均通过 `inspectEditorLayoutHealth` 验证 `emptyParagraphCount === 0` 且完整内容更新下 `indentedParagraphCount === 0`。

图片后必要的编辑器 separator 或名片之后的单个尾部光标锚点不应误判为实质正文。名片末尾检查允许这类编辑器占位，但不能允许正文与名片之间存在空段落，或名片后还有文字、图片、表格等正文。

最终以独立重开草稿后的正文文字、图片、H1 和名片证据验收，样式或行距的编辑态效果不能代替保存持久化检查。
