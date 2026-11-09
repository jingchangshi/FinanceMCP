# 账户研究日报 Feishu Publisher（goal-1109 §4）

新模块，不修改、不依赖 DailyETF 的任何文件（`run_lark` 子进程模式是重复实现，不是导入）。

## 文件

| 文件 | 作用 |
|---|---|
| `feishu_render.py` | §2 六节模板 → 确定性原生块 XML（`<title>/<h1>/<h2>/<p>/<b>/<table>/<ul>/<li>/<a>/<blockquote>`）。`RENDERER_VERSION = "feishu-account-v1"`。只接受已计算好的事实，永不重算价格/账户/权重/风险；禁止词与 Markdown 泄漏在渲染前拦截 |
| `feishu_publish.py` | `lark-cli +create/+update(overwrite)/+fetch` 发布 + 回读验收 + 每日回执台账。`--dry-run` 只校验不发 API |
| `config.example.json` | 配置模板（无任何真实 token）。复制为 `config.json` 或用 `$FEISHU_ACCOUNT_FOLDER_TOKEN` 环境变量提供 |
| `samples/sections-20261106.example.json` | 2026-11-06 结构示例（值为占位/示例事实），供测试与真实发布前的渲染复核 |
| `tests/` | `python3 -m unittest discover -s scripts/feishu-publish/tests -v` |

## 配置

```json
{
  "enabled": true,
  "identity": "bot",
  "format": "docx",
  "name_prefix": "A股账户研究日报",
  "folder_token_env": "FEISHU_ACCOUNT_FOLDER_TOKEN",
  "folder_token": "",
  "image_width_px": 780
}
```

`folder_token` 优先级：环境变量（`folder_token_env` 指定）> 配置文件。两者都为空 → 未发 API 直接失败（fail-closed）。token 只存在于本地 `config.json`/环境，不进版本库。

## 调用约定

1. 上游 agent 产出 `sections` 对象（见 `samples/` 的字段结构：`title/subtitle/account_status/sections{六节+数据说明与参考来源}`）。
2. `from feishu_render import render_xml; xml = render_xml(sections)` → 写 `report.xml`。缺章节、空结论、禁止词（DEGRADED/NOT_READY/NO_ACTION/MCP/snapshot_get/report_id/hash/V1/V2/HHI 等）、Markdown 泄漏、非 https 链接 → 抛 `ValueError`，不产生 XML。
3. 发布：
   ```bash
   python3 scripts/feishu-publish/feishu_publish.py \
     --root <repo-root> --xml report.xml --config <config.json> \
     --trade-date 20261106 --title "A 股账户研究日报｜2026 年 11 月 6 日收盘" \
     --source-count 1 [--dry-run]
   ```
4. 回执台账：`<root>/data/feishu/account_publish_ledger.jsonl`，每交易日一行（`trade_date, document_id, document_url, file_name, report_sha256, published_at, renderer_version`）。旧日的行不被覆盖；同日重跑原地更新该日行。
5. 失败回执：`<root>/data/feishu/account_publish_incidents.jsonl`，记录 `readback_failed` 的 trade_date/document_id/problems/时间。失败时台账不动，上一已验收文档保持可读。

## 幂等与验收

- 同 `trade_date` 已有台账行 → `+update --command overwrite` 同一 `document_id`；新日期 → `+create` 新文档（`--parent-token` 为 folder）。
- 回读验收：标题一致、七个标题齐全（六节 + 数据说明与参考来源）、无禁止词、超链接数 == `--source-count`。任一失败 → 抛错并写 incident，不写台账。
- 回执台账是内部交付记录，不进入飞书正文（正文末只有“研究记录，不构成自动交易指令。”）。

## 仍需真实发布时完成（本模块不代办）

1. 提供真实 `folder_token`（环境变量）与可写死的飞书文件夹权限，`lark-cli` 凭证以 `/home/jcshi/.local/share/lark-cli/` 现有加密存储为准，不打印、不入版本库。
2. 首次真实运行先 `--dry-run`，再正式发布一次，保存 `document_url`。
3. **视觉验收**：电脑 + 手机实际打开文档检查（第一屏结论/最大风险可见、持仓表不挤作竖排、数字单位不跨行、链接可点且显示标题）。无浏览器权限时按此清单人工核对，并在交付报告中如实写“未做视觉验收”，不得声称完成。
