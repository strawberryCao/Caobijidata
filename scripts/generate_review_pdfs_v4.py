#!/usr/bin/env python3
"""Relation-grouped v4 renderer built on the verified v3 image/PDF utilities."""
from __future__ import annotations

import json
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any

import generate_review_pdfs as base
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import CondPageBreak, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

GROUP_TITLE = ParagraphStyle("group-title-v4", parent=base.TITLE, fontSize=17, leading=22)
GROUP_NOTE = ParagraphStyle("group-note-v4", parent=base.BODY, fontSize=9.5, leading=14,
                            textColor=colors.HexColor("#30444F"))
MISTAKE_ORDER = ["导数定义与极限", "复合与分段函数求导", "反函数求导", "隐函数二阶导数",
                 "高阶导数与泰勒", "极值、拐点与单调性", "数列与离散最值", "切线交点与极限", "其他错题"]
MEMORY_ORDER = ["高阶导数公式组", "反函数求导组", "函数图像判定组", "基础求导公式组", "其他背诵内容"]
GUIDANCE = {
    "导数定义与极限": "把同源重复题合并后，连续查看“导数定义式识别”和“奇函数条件下的极限拼凑”。",
    "隐函数二阶导数": "对照两类真实错因：把一阶导数分式误当成洛必达对象；二次求导后没有继续回代化简。",
    "高阶导数与泰勒": "将泰勒展开求高阶导数的错题，与莱布尼茨公式和常用高阶导数资料放在同一专题中。",
    "极值、拐点与单调性": "集中区分极值、拐点、凹凸和平方单调性中的判定条件，避免把充分条件误当必要条件。",
    "反函数求导": "例题与反函数二阶导公式推导配套放置，复习时先确认原函数与反函数的对应点。",
}


def blob(note: dict[str, Any]) -> str:
    values = [note.get("title"), note.get("remark"), note.get("wrongReason"), note.get("questionType")]
    values += list(note.get("tags") or [])
    return " ".join(base.normalize(v).lower() for v in values if base.normalize(v))


def score(note: dict[str, Any]) -> tuple[int, int, int]:
    remark, wrong = base.normalize(note.get("remark")), base.normalize(note.get("wrongReason"))
    return (int(bool(remark)) + int(bool(wrong)), len(remark) + len(wrong), len(note.get("tags") or []))


def deduplicate(notes: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    buckets: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for note in notes:
        buckets[(note["kind"], base.normalize(note.get("imageSha256")).lower())].append(note)
    unique, groups = [], []
    for (_, image_hash), items in buckets.items():
        kept = max(items, key=score)
        note = dict(kept)
        note["_blob"] = blob(note)
        note["_duplicate_ids"] = [base.normalize(x["id"]) for x in items if x is not kept]
        unique.append(note)
        if len(items) > 1:
            groups.append({"imageSha256": image_hash, "keptNoteId": base.normalize(kept["id"]),
                           "mergedNoteIds": note["_duplicate_ids"]})
    return unique, groups


def mistake_topic(note: dict[str, Any]) -> str:
    text = note["_blob"]
    if any(x in text for x in ["导数定义", "奇函数导数极限", "导数与极限的综合"]): return "导数定义与极限"
    if "复合" in text or "分段函数" in text: return "复合与分段函数求导"
    if "反函数" in text: return "反函数求导"
    if "隐函数" in text: return "隐函数二阶导数"
    if "泰勒" in text or "高阶导数" in text: return "高阶导数与泰勒"
    if any(x in text for x in ["极值", "拐点", "凹凸", "平方单调", "极大值"]): return "极值、拐点与单调性"
    if "n^(1/n)" in text or "最大项" in text: return "数列与离散最值"
    if "切线交点" in text or "函数族" in text: return "切线交点与极限"
    return "其他错题"


def memory_topic(note: dict[str, Any]) -> str:
    text = note["_blob"]
    if any(x in text for x in ["高阶导数", "莱布尼", "泰勒展开"]): return "高阶导数公式组"
    if "反函数" in text: return "反函数求导组"
    if any(x in text for x in ["凹凸", "极值", "拐点"]): return "函数图像判定组"
    if "常用求导公式" in text: return "基础求导公式组"
    return "其他背诵内容"


def related_memory_topic(topic: str) -> str | None:
    return {"反函数求导": "反函数求导组", "高阶导数与泰勒": "高阶导数公式组",
            "极值、拐点与单调性": "函数图像判定组"}.get(topic)


def shorten(value: Any, limit: int = 92) -> str:
    text = base.normalize(value)
    return text if len(text) <= limit else text[:limit - 1] + "…"


def order_key(topic: str, order: list[str]) -> int:
    return order.index(topic) if topic in order else len(order)


def overview(topic: str, mistakes: list[dict[str, Any]], memories: list[dict[str, Any]]) -> list[Any]:
    rows: list[list[Any]] = [[Paragraph("错题 / 资料", base.LABEL), Paragraph("来自原记录的主要卡点", base.LABEL)]]
    for note in mistakes:
        source = base.normalize(note.get("wrongReason")) or base.normalize(note.get("remark")) or "暂无明确错因记录。"
        rows.append([Paragraph(base.escape(note.get("title")), base.BODY), Paragraph(base.escape(shorten(source)), base.BODY)])
    for note in memories:
        rows.append([Paragraph("配套背诵：" + base.escape(note.get("title")), base.BODY),
                     Paragraph(base.escape(shorten(note.get("remark") or "与本专题相关的原始背诵资料。")), base.BODY)])
    table = Table(rows, colWidths=[62 * mm, base.USABLE_W - 62 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#EEF3F6")),
        ("BOX", (0, 0), (-1, -1), .55, colors.HexColor("#C4D1D8")),
        ("INNERGRID", (0, 0), (-1, -1), .35, colors.HexColor("#DCE4E8")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
    ]))
    result: list[Any] = [base.section_header("专题对照", "高等数学"), Spacer(1, 5 * mm),
                         Paragraph(base.escape(topic), GROUP_TITLE), Spacer(1, 2 * mm)]
    if topic in GUIDANCE:
        result += [Paragraph(base.escape(GUIDANCE[topic]), GROUP_NOTE), Spacer(1, 4 * mm)]
    return result + [table]


def build_mistakes(notes: list[dict[str, Any]], memories: list[dict[str, Any]], prepared: dict[str, list[Path]]) -> list[dict[str, Any]]:
    story, provenance = [], []
    groups, memory_groups = defaultdict(list), defaultdict(list)
    for note in notes: groups[mistake_topic(note)].append(note)
    for note in memories: memory_groups[memory_topic(note)].append(note)
    first, number = True, 0
    for topic in sorted(groups, key=lambda x: order_key(x, MISTAKE_ORDER)):
        peers = sorted(groups[topic], key=lambda x: base.normalize(x.get("title")))
        memory_name = related_memory_topic(topic)
        linked = sorted(memory_groups.get(memory_name or "", []), key=lambda x: base.normalize(x.get("title")))
        if len(peers) >= 2 or linked:
            if not first: story.append(PageBreak())
            story += overview(topic, peers, linked); first = False
        for note in peers:
            if not first: story.append(PageBreak())
            first = False; number += 1
            note_id, title = base.normalize(note["id"]), base.normalize(note.get("title")) or "未命名错题"
            story += [base.section_header("错题集", f"{note['_path']} / {topic}"), Spacer(1, 3.3 * mm),
                      Paragraph(f"{number:02d}  {base.escape(title)}", base.TITLE),
                      base.image_panel(prepared[note_id], "mistake"), Spacer(1, 2.4 * mm)]
            remark, wrong = base.normalize(note.get("remark")), base.normalize(note.get("wrongReason"))
            if remark: story += [base.information_box("原始备注", base.escape(remark), "blue"), Spacer(1, 1.8 * mm)]
            if wrong: story += [base.information_box("已记录错因", base.escape(wrong), "red"), Spacer(1, 1.8 * mm)]
            relations = []
            other_titles = [base.normalize(x.get("title")) for x in peers if x is not note]
            if other_titles: relations.append("同组错题：" + "；".join(other_titles))
            if linked: relations.append("配套背诵：" + "；".join(base.normalize(x.get("title")) for x in linked))
            if note.get("_duplicate_ids"): relations.append(f"已合并 {len(note['_duplicate_ids']) + 1} 条同图重复记录")
            if relations: story += [Paragraph(base.escape(" | ".join(relations)), base.SMALL), Spacer(1, 2.4 * mm)]
            story += [Paragraph("二刷补充", base.SMALL), Spacer(1, .8 * mm), base.handwriting_area(34)]
            provenance.append({"noteId": note_id, "field": "relationshipPlacement",
                               "type": "deterministic-source-metadata", "topic": topic,
                               "relatedMistakeIds": [base.normalize(x["id"]) for x in peers if x is not note],
                               "relatedMemoryIds": [base.normalize(x["id"]) for x in linked], "containsNewFact": False})
    doc = SimpleDocTemplate(str(base.MISTAKE_PDF), pagesize=base.A4, leftMargin=base.LEFT, rightMargin=base.RIGHT,
                            topMargin=base.TOP, bottomMargin=base.BOTTOM, title="错题综合整理")
    doc.build(story, onFirstPage=base.footer, onLaterPages=base.footer)
    return provenance


def build_memories(notes: list[dict[str, Any]], mistakes: list[dict[str, Any]], prepared: dict[str, list[Path]]) -> list[dict[str, Any]]:
    story, provenance = [], []
    groups, mistake_groups = defaultdict(list), defaultdict(list)
    for note in notes: groups[memory_topic(note)].append(note)
    for note in mistakes: mistake_groups[mistake_topic(note)].append(note)
    reverse = {"高阶导数公式组": "高阶导数与泰勒", "反函数求导组": "反函数求导",
               "函数图像判定组": "极值、拐点与单调性"}
    first, number = True, 0
    for topic in sorted(groups, key=lambda x: order_key(x, MEMORY_ORDER)):
        if not first: story.append(PageBreak())
        first = False
        linked = sorted(mistake_groups.get(reverse.get(topic, ""), []), key=lambda x: base.normalize(x.get("title")))
        story += [base.section_header("背诵集", f"高等数学 / {topic}"), Spacer(1, 4 * mm),
                  Paragraph(base.escape(topic), GROUP_TITLE), Spacer(1, 3 * mm)]
        if linked:
            story += [Paragraph(base.escape("关联错题：" + "；".join(base.normalize(x.get("title")) for x in linked)), base.SMALL), Spacer(1, 3 * mm)]
        for index, note in enumerate(sorted(groups[topic], key=lambda x: base.normalize(x.get("title")))):
            if index: story += [CondPageBreak(85 * mm), Spacer(1, 3.5 * mm)]
            number += 1
            note_id, title = base.normalize(note["id"]), base.normalize(note.get("title")) or "未命名背诵内容"
            story += [Paragraph(f"{number:02d}  {base.escape(title)}", base.TITLE),
                      base.image_panel(prepared[note_id], "memory"), Spacer(1, 1.8 * mm)]
            remark = base.normalize(note.get("remark"))
            if remark: story += [base.information_box("原始备注", base.escape(remark), "blue"), Spacer(1, 1.8 * mm)]
            if note.get("_duplicate_ids"): story += [Paragraph(base.escape(f"已合并 {len(note['_duplicate_ids']) + 1} 条同图重复记录"), base.SMALL), Spacer(1, 1.8 * mm)]
            provenance.append({"noteId": note_id, "field": "relationshipPlacement",
                               "type": "deterministic-source-metadata", "topic": topic,
                               "relatedMistakeIds": [base.normalize(x["id"]) for x in linked], "containsNewFact": False})
    doc = SimpleDocTemplate(str(base.MEMORY_PDF), pagesize=base.A4, leftMargin=base.LEFT, rightMargin=base.RIGHT,
                            topMargin=base.TOP, bottomMargin=base.BOTTOM, title="背诵综合整理")
    doc.build(story, onFirstPage=base.footer, onLaterPages=base.footer)
    return provenance


def main() -> None:
    base.OUT.mkdir(parents=True, exist_ok=True)
    data, all_notes = base.load_notes()
    unique, duplicates = deduplicate(all_notes)
    mistakes = [x for x in unique if x["kind"] == "mistake"]
    memories = [x for x in unique if x["kind"] == "memory"]
    with tempfile.TemporaryDirectory(prefix="review-pdf-v4-") as temp:
        prepared = {base.normalize(x["id"]): base.prepare_image(x["_image"], Path(temp), base.normalize(x["id"])) for x in unique}
        provenance = build_mistakes(mistakes, memories, prepared) + build_memories(memories, mistakes, prepared)
    mg, bg = defaultdict(list), defaultdict(list)
    for x in mistakes: mg[mistake_topic(x)].append(base.normalize(x["id"]))
    for x in memories: bg[memory_topic(x)].append(base.normalize(x["id"]))
    manifest = {
        "schemaVersion": 4, "generationPolicy": "confirmed-source-metadata-relation-grouping-no-generic-study-boxes",
        "contentVersion": "study-first-v4-related-groups", "sourceIndexSha256": base.sha256_file(base.INDEX),
        "sourceRevision": data.get("sourceRevision"),
        "sourceCounts": {"mistake": sum(x["kind"] == "mistake" for x in all_notes), "memory": sum(x["kind"] == "memory" for x in all_notes)},
        "renderedCounts": {"mistake": len(mistakes), "memory": len(memories)}, "duplicateGroups": duplicates,
        "contentRules": {"sourceFieldsUsed": ["title", "subject", "knowledgePath", "tags", "remark", "wrongReason", "imagePath", "imageSha256"],
                         "ignoredFields": ["items"], "removedModules": ["generic active-recall box", "generic second-pass checklist box"],
                         "allowedGenerated": ["deterministic topic label", "source-derived relationship line", "source-derived comparison overview"],
                         "forbiddenGenerated": ["new answer", "new solution", "new formula", "new theorem", "unsupported factual explanation", "exam prediction"],
                         "uncertainContentPolicy": "omit rather than infer", "standaloneTableOfContents": False},
        "groups": {"mistake": dict(mg), "memory": dict(bg)}, "provenance": provenance,
        "files": [{"path": "generated/错题综合整理.pdf", "bytes": base.MISTAKE_PDF.stat().st_size, "sha256": base.sha256_file(base.MISTAKE_PDF)},
                  {"path": "generated/背诵综合整理.pdf", "bytes": base.MEMORY_PDF.stat().st_size, "sha256": base.sha256_file(base.MEMORY_PDF)}],
    }
    base.MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {len(mistakes)} unique mistakes and {len(memories)} unique memory records")


if __name__ == "__main__":
    main()
