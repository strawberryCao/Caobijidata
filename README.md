# Caobijidata

考研学习助手的公开复习资料仓库。主应用只会同步**已经确认分类为“错题”或“背诵”**的内容；其他笔记不会进入这里。

## 固定输出

仓库每次重新读取当前全部有效来源，综合生成并覆盖两份文件：

- `generated/错题综合整理.pdf`
- `generated/背诵综合整理.pdf`

不会按周新增一批 PDF，也不会把本周内容机械追加到旧文件尾部。

## AI 的权限边界

AI 只允许：

- 识别同一道题的原题、错误过程、订正和重复截图；
- 将不同题目按相同知识点或错误模式放进同一专题；
- 安排来源顺序并生成很短的专题标题。

AI 不允许：

- 补充答案、解法、知识点、例题或记忆口诀；
- 改写原始正文；
- 把未确认分类的笔记加入 PDF；
- 丢失、创造或重复来源 ID。

AI 返回结果必须通过程序校验：全部来源 ID 必须恰好出现一次。校验失败、API 不可用或没有配置密钥时，系统自动使用确定性分组，不会让本次 PDF 生成失败。

## 公开仓库提醒

本仓库是 Public。`data/` 中的题目截图、手写过程、备注、教材页面和来源信息可以被任何人查看、下载和索引。上传前应确认其中没有真实姓名、账号、电话号码、学校内部信息或其他不希望公开的内容。

## 目录

```text
config/review-config.json   每周时间、AI 模型和排版规则
data/index.json             已确认笔记的结构化索引
data/assets/                导出的原始图片
generated/                  永远只维护最新两份 PDF 与 manifest
scripts/generate-review.mjs 严格分组、固定模板和 PDF 生成程序
```

## GitHub Actions AI 配置

在仓库 Settings -> Secrets and variables -> Actions 中配置：

### Secret

- `REVIEW_AI_API_KEY`：所选 OpenAI-compatible API 的密钥。

### Variables

- `REVIEW_AI_BASE_URL`：可选。OpenAI-compatible API 根地址或完整 `/chat/completions` 地址；优先级高于 `config/review-config.json`。
- `REVIEW_AI_MODEL`：可选。模型名称；优先级高于 `config/review-config.json`。

不配置 AI 密钥时仍会生成 PDF，只是使用程序的保守分组规则。

## 运行时间

工作流每天 21:00（中国标准时间）启动一次，但脚本只在 `config/review-config.json` 指定的星期执行。默认是星期日 21:00。这样修改星期几时不需要同时改 GitHub Actions cron。

也可以在 Actions 页面手动运行 `Weekly review PDFs`，立即重新生成两份 PDF。

## 本地验证

```bash
npm install
npx playwright install chromium
npm run validate
npm run generate:dry
```
