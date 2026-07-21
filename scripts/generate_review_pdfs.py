#!/usr/bin/env python3
"""Generate conservative initial review PDFs from confirmed repository notes.

Safety policy:
- Uses only confirmed records and their original images.
- Does not invent solutions, formulas, or textbook explanations.
- Uses title, user remark, and stored wrongReason only as annotations.
- Fails closed when an image is missing or its SHA-256 mismatches.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "data" / "index.json"
OUT = ROOT / "generated"
MISTAKE_PDF = OUT / "错题综合整理.pdf"
MEMORY_PDF = OUT / "背诵综合整理.pdf"
MANIFEST = OUT / "manifest.json"
PAGE_W, PAGE_H = A4
FONT = "STSong-Light"

pdfmetrics.registerFont(UnicodeCIDFont(FONT))

BODY = ParagraphStyle("body", fontName=FONT, fontSize=10.2, leading=15.5, textColor=colors.HexColor("#202A31"))
SMALL = ParagraphStyle("small", fontName=FONT, fontSize=8.8, leading=13, textColor=colors.HexColor("#65727A"))
TITLE = ParagraphStyle("title", fontName=FONT, fontSize=15, leading=21, textColor=colors.HexColor("#142C3B"), spaceAfter=5)
PATH = ParagraphStyle("path", fontName=FONT, fontSize=8.5, leading=12, textColor=colors.HexColor("#65727A"))
SECTION = ParagraphStyle("section", fontName=FONT, fontSize=18, leading=24, textColor=colors.white)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def load_notes() -> list[dict[str, Any]]:
    data = json.loads(INDEX.read_text(encoding="utf-8"))
    notes = []
    errors: list[str] = []
    for note in data.get("notes", []):
        if note.get("organizationStatus") != "confirmed":
            continue
        if note.get("kind") not in {"mistake", "memory"}:
            continue
        rel = note.get("imagePath")
        if not rel:
            errors.append(f"{note.get('id')}: missing imagePath")
            continue
        image_path = ROOT / rel
        if not image_path.exists():
            errors.append(f"{note.get('id')}: image missing: {rel}")
            continue
        expected = str(note.get("imageSha256") or "").lower()
        actual = sha256_file(image_path)
        if expected and actual != expected:
            errors.append(f"{note.get('id')}: SHA-256 mismatch: {rel}")
            continue
        copied = dict(note)
        copied["_image"] = image_path
        notes.append(copied)
    if errors:
        raise RuntimeError("Input validation failed:\n" + "\n".join(errors))
    return notes


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont(FONT, 8)
    canvas.setFillColor(colors.HexColor("#7D878E"))
    canvas.drawCentredString(PAGE_W / 2, 7.5 * mm, str(doc.page))
    canvas.restoreState()


def section_band(text: str):
    table = Table([[Paragraph(text, SECTION)]], colWidths=[PAGE_W - 28 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#173B54")),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return table


def safe_text(value: Any) -> str:
    return str(value or "").strip().replace("\n", "<br/>")


def image_flowable(path: Path, max_w: float, max_h: float):
    with PILImage.open(path) as im:
        w, h = im.size
    scale = min(max_w / w, max_h / h)
    return Image(str(path), width=w * scale, height=h * scale)


def annotation_box(label: str, text: str, tone: str = "blue"):
    palette = {
        "blue": ("#F2F6F8", "#B7CAD4", "#173B54"),
        "red": ("#FAF0F0", "#D7B0B0", "#792E2E"),
        "amber": ("#FBF6EA", "#DCC58E", "#75531C"),
    }
    bg, border, head = palette[tone]
    t = Table([[Paragraph(label, ParagraphStyle("label" + tone, fontName=FONT, fontSize=9.5, leading=13, textColor=colors.HexColor(head))), Paragraph(text, BODY)]], colWidths=[27 * mm, PAGE_W - 61 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(bg)),
        ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor(border)),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


def blank_area(height_mm: float = 28):
    rows = [[""] for _ in range(max(2, int(height_mm // 8)))]
    t = Table(rows, colWidths=[PAGE_W - 28 * mm], rowHeights=[8 * mm] * len(rows))
    t.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#D3DDE2")),
        ("LINEBELOW", (0, 0), (-1, -2), 0.35, colors.HexColor("#E4EAED")),
    ]))
    return t


def note_path(note: dict[str, Any]) -> str:
    path = [str(x) for x in note.get("knowledgePath") or [] if x]
    subject = str(note.get("subject") or "未分类")
    if not path or path[0] != subject:
        path.insert(0, subject)
    return " / ".join(path)


def build_mistake_pdf(notes: list[dict[str, Any]]):
    story = []
    grouped: dict[str, list[dict[str, Any]]] = {}
    for n in notes:
        grouped.setdefault(note_path(n), []).append(n)
    for group_i, (path, group_notes) in enumerate(sorted(grouped.items())):
        if group_i:
            story.append(PageBreak())
        story.extend([section_band(f"错题集 / {path}"), Spacer(1, 5 * mm)])
        for idx, note in enumerate(group_notes):
            if idx:
                story.append(PageBreak())
            story.append(Paragraph(safe_text(note.get("title") or "未命名错题"), TITLE))
            story.append(Paragraph(path, PATH))
            story.append(Spacer(1, 3 * mm))
            story.append(image_flowable(note["_image"], PAGE_W - 30 * mm, 126 * mm))
            story.append(Spacer(1, 3 * mm))
            remark = safe_text(note.get("remark"))
            wrong = safe_text(note.get("wrongReason"))
            if remark:
                story.append(annotation_box("原始备注", remark, "blue"))
                story.append(Spacer(1, 2.5 * mm))
            if wrong:
                story.append(annotation_box("已记录错因", wrong, "red"))
                story.append(Spacer(1, 2.5 * mm))
            story.append(Paragraph("补充 / 二刷记录", SMALL))
            story.append(Spacer(1, 1 * mm))
            story.append(blank_area(28))
    doc = SimpleDocTemplate(str(MISTAKE_PDF), pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm, topMargin=12 * mm, bottomMargin=14 * mm, title="错题综合整理")
    doc.build(story, onFirstPage=footer, onLaterPages=footer)


def build_memory_pdf(notes: list[dict[str, Any]]):
    story = []
    grouped: dict[str, list[dict[str, Any]]] = {}
    for n in notes:
        grouped.setdefault(note_path(n), []).append(n)
    for group_i, (path, group_notes) in enumerate(sorted(grouped.items())):
        if group_i:
            story.append(PageBreak())
        story.extend([section_band(f"背诵集 / {path}"), Spacer(1, 5 * mm)])
        for idx, note in enumerate(group_notes):
            block = [Paragraph(safe_text(note.get("title") or "未命名背诵内容"), TITLE), Paragraph(path, PATH), Spacer(1, 2.5 * mm), image_flowable(note["_image"], PAGE_W - 30 * mm, 150 * mm)]
            remark = safe_text(note.get("remark"))
            if remark:
                block.extend([Spacer(1, 2.5 * mm), annotation_box("原始备注", remark, "blue")])
            story.append(KeepTogether(block))
            if idx != len(group_notes) - 1:
                story.extend([Spacer(1, 5 * mm), Table([[""]], colWidths=[PAGE_W - 28 * mm], style=[("LINEABOVE", (0, 0), (-1, -1), 0.5, colors.HexColor("#D5DEE3"))]), Spacer(1, 5 * mm)])
    doc = SimpleDocTemplate(str(MEMORY_PDF), pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm, topMargin=12 * mm, bottomMargin=14 * mm, title="背诵综合整理")
    doc.build(story, onFirstPage=footer, onLaterPages=footer)


def write_manifest(notes: list[dict[str, Any]]):
    payload = {
        "schemaVersion": 1,
        "generationPolicy": "confirmed-original-images-only-no-invented-content",
        "sourceIndexSha256": sha256_file(INDEX),
        "counts": {
            "mistake": sum(1 for n in notes if n["kind"] == "mistake"),
            "memory": sum(1 for n in notes if n["kind"] == "memory"),
        },
        "files": [
            {"path": "generated/错题综合整理.pdf", "sha256": sha256_file(MISTAKE_PDF)},
            {"path": "generated/背诵综合整理.pdf", "sha256": sha256_file(MEMORY_PDF)},
        ],
    }
    MANIFEST.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    notes = load_notes()
    mistakes = [n for n in notes if n["kind"] == "mistake"]
    memories = [n for n in notes if n["kind"] == "memory"]
    if not mistakes or not memories:
        raise RuntimeError("Both confirmed mistake and memory records are required")
    build_mistake_pdf(mistakes)
    build_memory_pdf(memories)
    write_manifest(notes)
    print(f"Generated {MISTAKE_PDF} and {MEMORY_PDF}")


if __name__ == "__main__":
    main()
