#!/usr/bin/env python3
"""Compact v4.1 layout: relation groups stay on the first question page."""
from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

import generate_review_pdfs_v4 as v4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

base = v4.base


def group_strip(topic: str, peers: list[dict[str, Any]], linked: list[dict[str, Any]]) -> Table:
    parts = ["本组错题：" + "；".join(base.normalize(x.get("title")) for x in peers)]
    if linked:
        parts.append("配套背诵：" + "；".join(base.normalize(x.get("title")) for x in linked))
    if topic in v4.GUIDANCE:
        parts.append("对照重点：" + v4.GUIDANCE[topic])
    table = Table([[Paragraph(base.escape(topic), base.LABEL),
                    Paragraph(base.escape(" | ".join(parts)), base.SMALL)]],
                  colWidths=[34 * mm, base.USABLE_W - 34 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#EEF3F6")),
        ("BOX", (0, 0), (-1, -1), .55, colors.HexColor("#C4D1D8")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def build_mistakes(notes: list[dict[str, Any]], memories: list[dict[str, Any]],
                   prepared: dict[str, list[Path]]) -> list[dict[str, Any]]:
    story, provenance = [], []
    groups, memory_groups = defaultdict(list), defaultdict(list)
    for note in notes:
        groups[v4.mistake_topic(note)].append(note)
    for note in memories:
        memory_groups[v4.memory_topic(note)].append(note)

    number = 0
    first_page = True
    for topic in sorted(groups, key=lambda x: v4.order_key(x, v4.MISTAKE_ORDER)):
        peers = sorted(groups[topic], key=lambda x: base.normalize(x.get("title")))
        memory_name = v4.related_memory_topic(topic)
        linked = sorted(memory_groups.get(memory_name or "", []), key=lambda x: base.normalize(x.get("title")))
        grouped = len(peers) >= 2 or bool(linked)

        for position, note in enumerate(peers):
            if not first_page:
                story.append(PageBreak())
            first_page = False
            number += 1
            note_id = base.normalize(note["id"])
            title = base.normalize(note.get("title")) or "未命名错题"
            story += [base.section_header("错题集", f"{note['_path']} / {topic}"), Spacer(1, 2.6 * mm)]
            if position == 0 and grouped:
                story += [group_strip(topic, peers, linked), Spacer(1, 2.6 * mm)]
            story += [Paragraph(f"{number:02d}  {base.escape(title)}", base.TITLE),
                      base.image_panel(prepared[note_id], "mistake"), Spacer(1, 2.2 * mm)]

            remark = base.normalize(note.get("remark"))
            wrong = base.normalize(note.get("wrongReason"))
            if remark:
                story += [base.information_box("原始备注", base.escape(remark), "blue"), Spacer(1, 1.6 * mm)]
            if wrong:
                story += [base.information_box("已记录错因", base.escape(wrong), "red"), Spacer(1, 1.6 * mm)]
            if note.get("_duplicate_ids"):
                story += [Paragraph(base.escape(f"已合并 {len(note['_duplicate_ids']) + 1} 条同图重复记录"), base.SMALL), Spacer(1, 1.8 * mm)]
            story += [Paragraph("二刷补充", base.SMALL), Spacer(1, .7 * mm), base.handwriting_area(30)]

            provenance.append({
                "noteId": note_id, "field": "relationshipPlacement",
                "type": "deterministic-source-metadata", "topic": topic,
                "relatedMistakeIds": [base.normalize(x["id"]) for x in peers if x is not note],
                "relatedMemoryIds": [base.normalize(x["id"]) for x in linked],
                "containsNewFact": False,
            })

    doc = SimpleDocTemplate(str(base.MISTAKE_PDF), pagesize=base.A4,
                            leftMargin=base.LEFT, rightMargin=base.RIGHT,
                            topMargin=base.TOP, bottomMargin=base.BOTTOM,
                            title="错题综合整理")
    doc.build(story, onFirstPage=base.footer, onLaterPages=base.footer)
    return provenance


v4.build_mistakes = build_mistakes
v4.main()
