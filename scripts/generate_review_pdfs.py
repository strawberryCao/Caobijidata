#!/usr/bin/env python3
"""Generate compact, study-first review PDFs from confirmed repository notes.

Content policy:
- Source facts come only from title, subject/path, original image, user remark, and wrongReason.
- The machine-generated `items` field is ignored.
- Added text is limited to generic study actions that make no claims about the answer.
- Uncertain source content is omitted rather than inferred.
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image as PILImage, ImageChops, ImageStat
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    CondPageBreak,
    Image,
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
LEFT = RIGHT = 14 * mm
TOP = 11 * mm
BOTTOM = 14 * mm
USABLE_W = PAGE_W - LEFT - RIGHT
FONT = "STSong-Light"
pdfmetrics.registerFont(UnicodeCIDFont(FONT))

BODY = ParagraphStyle(
    "body", fontName=FONT, fontSize=9.3, leading=13.6,
    textColor=colors.HexColor("#202A31"), wordWrap="CJK",
)
SMALL = ParagraphStyle(
    "small", fontName=FONT, fontSize=8.0, leading=11.2,
    textColor=colors.HexColor("#66747C"), wordWrap="CJK",
)
TITLE = ParagraphStyle(
    "title", fontName=FONT, fontSize=14.5, leading=19.5,
    textColor=colors.HexColor("#142C3B"), spaceAfter=1.2 * mm,
    wordWrap="CJK",
)
PATH_STYLE = ParagraphStyle(
    "path", fontName=FONT, fontSize=8.2, leading=11.2,
    textColor=colors.HexColor("#687781"), wordWrap="CJK",
)
SECTION = ParagraphStyle(
    "section", fontName=FONT, fontSize=10.5, leading=14.5,
    textColor=colors.HexColor("#173B54"), wordWrap="CJK",
)
LABEL = ParagraphStyle(
    "label", fontName=FONT, fontSize=8.4, leading=11.5,
    textColor=colors.HexColor("#173B54"), wordWrap="CJK",
)


def normalize(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip())


def escape(value: Any) -> str:
    text = re.sub(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]", "", str(value or "").strip())
    return html.escape(text).replace("\n", "<br/>")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def note_path(note: dict[str, Any]) -> str:
    parts = [normalize(item) for item in note.get("knowledgePath") or [] if normalize(item)]
    subject = normalize(note.get("subject")) or "未分类"
    if not parts or parts[0] != subject:
        parts.insert(0, subject)
    return " / ".join(parts)


def load_notes() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    data = json.loads(INDEX.read_text(encoding="utf-8"))
    notes: list[dict[str, Any]] = []
    errors: list[str] = []
    ids: set[str] = set()
    paths: set[str] = set()

    for raw in data.get("notes", []):
        if not isinstance(raw, dict):
            continue
        if raw.get("organizationStatus") != "confirmed":
            continue
        if raw.get("kind") not in {"mistake", "memory"}:
            continue

        note_id = normalize(raw.get("id"))
        relative = normalize(raw.get("imagePath"))
        if not note_id or note_id in ids:
            errors.append(f"invalid or duplicate id: {note_id}")
            continue
        ids.add(note_id)

        if not relative.startswith("data/assets/") or ".." in Path(relative).parts or relative in paths:
            errors.append(f"{note_id}: invalid or duplicate imagePath")
            continue
        paths.add(relative)

        image_path = ROOT / relative
        expected_hash = normalize(raw.get("imageSha256")).lower()
        if not image_path.is_file():
            errors.append(f"{note_id}: image missing")
            continue
        if not expected_hash or sha256_file(image_path) != expected_hash:
            errors.append(f"{note_id}: image hash mismatch")
            continue
        try:
            with PILImage.open(image_path) as image:
                image.verify()
        except Exception as exc:
            errors.append(f"{note_id}: unreadable image: {exc}")
            continue

        note = dict(raw)
        note.pop("items", None)
        note["_image"] = image_path
        note["_path"] = note_path(note)
        notes.append(note)

    if errors:
        raise RuntimeError("Content-source review failed:\n" + "\n".join(errors))
    if not any(note["kind"] == "mistake" for note in notes):
        raise RuntimeError("No confirmed mistake records")
    if not any(note["kind"] == "memory" for note in notes):
        raise RuntimeError("No confirmed memory records")
    return data, notes


def estimated_background(image: PILImage.Image) -> tuple[int, int, int]:
    image = image.convert("RGB")
    width, height = image.size
    sample = max(2, min(24, width // 20, height // 20))
    corners = [
        (0, 0, sample, sample),
        (width - sample, 0, width, sample),
        (0, height - sample, sample, height),
        (width - sample, height - sample, width, height),
    ]
    medians = [tuple(int(v) for v in ImageStat.Stat(image.crop(box)).median[:3]) for box in corners]
    return tuple(sorted(value[channel] for value in medians)[2] for channel in range(3))


def prepare_image(path: Path, temp_dir: Path, note_id: str) -> list[Path]:
    with PILImage.open(path) as source:
        source.load()
        image = source.convert("RGB")
        width, height = image.size
        background = PILImage.new("RGB", image.size, estimated_background(image))
        diff = ImageChops.difference(image, background).convert("L")
        crop_box = diff.point(lambda value: 255 if value > 14 else 0).getbbox()

        if crop_box:
            left, top, right, bottom = crop_box
            pad = max(8, int(min(width, height) * 0.012))
            left, top = max(0, left - pad), max(0, top - pad)
            right, bottom = min(width, right + pad), min(height, bottom + pad)
            crop_width = right - left
            crop_height = bottom - top
            # Crop broad content regions, but reject tiny isolated marks that could remove conditions.
            if crop_width >= 0.24 * width and crop_height >= 0.12 * height:
                image = image.crop((left, top, right, bottom))

        width, height = image.size
        if height / max(width, 1) > 2.35:
            overlap = max(16, int(height * 0.02))
            split = height // 2
            boxes = [(0, 0, width, min(height, split + overlap)), (0, max(0, split - overlap), width, height)]
            outputs: list[Path] = []
            for index, box in enumerate(boxes):
                output = temp_dir / f"{note_id}-{index}.png"
                image.crop(box).save(output)
                outputs.append(output)
            return outputs

        output = temp_dir / f"{note_id}.png"
        image.save(output)
        return [output]


def footer(canvas, document) -> None:
    canvas.saveState()
    canvas.setFont(FONT, 8)
    canvas.setFillColor(colors.HexColor("#7D878E"))
    canvas.drawCentredString(PAGE_W / 2, 7.2 * mm, str(document.page))
    canvas.restoreState()


def section_header(collection: str, path: str) -> Table:
    table = Table(
        [[Paragraph(escape(collection), SECTION), Paragraph(escape(path), PATH_STYLE)]],
        colWidths=[31 * mm, USABLE_W - 31 * mm],
    )
    table.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, -1), 1.1, colors.HexColor("#173B54")),
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.0 * mm),
    ]))
    return table


def information_box(label: str, text: str, tone: str = "blue") -> Table:
    palettes = {
        "blue": ("#F3F7F9", "#C3D1D8", "#173B54"),
        "red": ("#FAF1F1", "#D7B7B7", "#783434"),
    }
    background, border, heading = palettes[tone]
    label_style = ParagraphStyle(
        f"label-{tone}", parent=LABEL, textColor=colors.HexColor(heading),
    )
    table = Table(
        [[Paragraph(escape(label), label_style), Paragraph(text, BODY)]],
        colWidths=[25 * mm, USABLE_W - 25 * mm],
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(background)),
        ("BOX", (0, 0), (-1, -1), 0.55, colors.HexColor(border)),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5.5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5.5),
        ("TOPPADDING", (0, 0), (-1, -1), 4.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
    ]))
    return table


def study_actions(memory: bool = False) -> Table:
    if memory:
        left = "遮住图片，先完整口述或默写；卡住时只看标题，不直接看正文。"
        right = "核对条件、符号、下标、范围和例外；错一处就立即再默写一次。"
    else:
        left = "先遮住订正，独立写出已知条件、目标，以及第一步所依据的定义或条件。"
        right = "完成后检查：条件是否用全，方法是否适用，符号、区间、下标和回代是否一致。"

    table = Table(
        [
            [Paragraph("主动回忆", LABEL), Paragraph("二刷检查", LABEL)],
            [Paragraph(escape(left), BODY), Paragraph(escape(right), BODY)],
        ],
        colWidths=[USABLE_W / 2, USABLE_W / 2],
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F5F7")),
        ("BOX", (0, 0), (-1, -1), 0.55, colors.HexColor("#C8D4DA")),
        ("INNERGRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#DDE5E9")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5.5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5.5),
        ("TOPPADDING", (0, 0), (-1, -1), 4.2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4.2),
    ]))
    return table


def handwriting_area(height_mm: float = 22) -> Table:
    row_count = max(2, int(height_mm // 7))
    table = Table([[""] for _ in range(row_count)], colWidths=[USABLE_W], rowHeights=[7 * mm] * row_count)
    table.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#D3DDE2")),
        ("LINEBELOW", (0, 0), (-1, -2), 0.3, colors.HexColor("#E4EAED")),
    ]))
    return table


def image_panel(paths: list[Path], target: str) -> Table:
    total_height = (72 if target == "mistake" else 54) * mm
    padding = 1.5 * mm

    dimensions: list[tuple[int, int]] = []
    for path in paths:
        with PILImage.open(path) as image:
            dimensions.append(image.size)

    max_width = USABLE_W - 4 * mm
    sum_height = sum(height for _, height in dimensions)
    max_source_width = max(width for width, _ in dimensions)
    scale = min(max_width / max_source_width, max(1, total_height - padding * (len(paths) - 1)) / sum_height)

    rows = []
    for path, (width, height) in zip(paths, dimensions):
        rows.append([Image(str(path), width=width * scale, height=height * scale)])

    table = Table(rows, colWidths=[USABLE_W])
    table.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOX", (0, 0), (-1, -1), 0.45, colors.HexColor("#D4DDE2")),
        ("LINEBELOW", (0, 0), (-1, -2), 0.3, colors.HexColor("#E1E7EA")),
        ("LEFTPADDING", (0, 0), (-1, -1), 2 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), padding),
        ("BOTTOMPADDING", (0, 0), (-1, -1), padding),
    ]))
    return table


def build_mistake_pdf(notes: list[dict[str, Any]], prepared: dict[str, list[Path]]) -> list[dict[str, Any]]:
    story = []
    provenance: list[dict[str, Any]] = []

    for index, note in enumerate(sorted(notes, key=lambda item: (item["_path"], normalize(item.get("title"))))):
        if index:
            story.append(PageBreak())
        path = note["_path"]
        note_id = normalize(note["id"])
        title = normalize(note.get("title")) or "未命名错题"
        story.extend([
            section_header("错题集", path),
            Spacer(1, 3.3 * mm),
            Paragraph(f"{index + 1:02d}  {escape(title)}", TITLE),
            image_panel(prepared[note_id], "mistake"),
            Spacer(1, 2.4 * mm),
        ])

        remark = normalize(note.get("remark"))
        wrong_reason = normalize(note.get("wrongReason"))
        if remark:
            story.extend([information_box("原始备注", escape(remark), "blue"), Spacer(1, 1.8 * mm)])
        if wrong_reason:
            story.extend([information_box("已记录错因", escape(wrong_reason), "red"), Spacer(1, 1.8 * mm)])

        story.extend([
            study_actions(memory=False),
            Spacer(1, 2.2 * mm),
            Paragraph("补充与二刷记录", SMALL),
            Spacer(1, 0.8 * mm),
            handwriting_area(22),
        ])
        provenance.extend([
            {"noteId": note_id, "field": "activeRecall", "type": "generic-study-action", "containsNewFact": False},
            {"noteId": note_id, "field": "secondPassChecklist", "type": "generic-study-action", "containsNewFact": False},
        ])

    document = SimpleDocTemplate(
        str(MISTAKE_PDF), pagesize=A4,
        leftMargin=LEFT, rightMargin=RIGHT, topMargin=TOP, bottomMargin=BOTTOM,
        title="错题综合整理",
    )
    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return provenance


def build_memory_pdf(notes: list[dict[str, Any]], prepared: dict[str, list[Path]]) -> list[dict[str, Any]]:
    story = []
    provenance: list[dict[str, Any]] = []
    previous_path: str | None = None

    for index, note in enumerate(sorted(notes, key=lambda item: (item["_path"], normalize(item.get("title"))))):
        path = note["_path"]
        if index:
            story.append(CondPageBreak(105 * mm))
            story.append(Spacer(1, 3 * mm))
        if path != previous_path:
            if index:
                story.append(CondPageBreak(120 * mm))
            story.extend([section_header("背诵集", path), Spacer(1, 3 * mm)])
            previous_path = path

        note_id = normalize(note["id"])
        title = normalize(note.get("title")) or "未命名背诵内容"
        story.extend([
            Paragraph(f"{index + 1:02d}  {escape(title)}", TITLE),
            image_panel(prepared[note_id], "memory"),
            Spacer(1, 1.8 * mm),
        ])
        remark = normalize(note.get("remark"))
        if remark:
            story.extend([information_box("原始备注", escape(remark), "blue"), Spacer(1, 1.5 * mm)])
        story.extend([study_actions(memory=True), Spacer(1, 2.5 * mm)])
        provenance.extend([
            {"noteId": note_id, "field": "activeRecall", "type": "generic-study-action", "containsNewFact": False},
            {"noteId": note_id, "field": "verificationChecklist", "type": "generic-study-action", "containsNewFact": False},
        ])

    document = SimpleDocTemplate(
        str(MEMORY_PDF), pagesize=A4,
        leftMargin=LEFT, rightMargin=RIGHT, topMargin=TOP, bottomMargin=BOTTOM,
        title="背诵综合整理",
    )
    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return provenance


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    data, notes = load_notes()
    mistakes = [note for note in notes if note["kind"] == "mistake"]
    memories = [note for note in notes if note["kind"] == "memory"]

    with tempfile.TemporaryDirectory(prefix="review-pdf-") as temporary:
        temp_dir = Path(temporary)
        prepared = {
            normalize(note["id"]): prepare_image(note["_image"], temp_dir, normalize(note["id"]))
            for note in notes
        }
        provenance = build_mistake_pdf(mistakes, prepared) + build_memory_pdf(memories, prepared)

    manifest = {
        "schemaVersion": 3,
        "generationPolicy": "confirmed-source-fields-plus-generic-study-actions",
        "contentVersion": "study-first-v3-no-standalone-toc",
        "sourceIndexSha256": sha256_file(INDEX),
        "sourceRevision": data.get("sourceRevision"),
        "counts": {"mistake": len(mistakes), "memory": len(memories)},
        "contentRules": {
            "sourceFieldsUsed": ["title", "subject", "knowledgePath", "remark", "wrongReason", "imagePath"],
            "ignoredFields": ["items"],
            "allowedGenerated": ["generic active-recall action", "generic second-pass checklist"],
            "forbiddenGenerated": ["new answer", "new solution", "new formula", "new theorem", "new factual explanation", "exam prediction", "unsupported extension"],
            "uncertainContentPolicy": "omit rather than infer",
            "standaloneTableOfContents": False
        },
        "provenance": provenance,
        "files": [
            {"path": "generated/错题综合整理.pdf", "bytes": MISTAKE_PDF.stat().st_size, "sha256": sha256_file(MISTAKE_PDF)},
            {"path": "generated/背诵综合整理.pdf", "bytes": MEMORY_PDF.stat().st_size, "sha256": sha256_file(MEMORY_PDF)}
        ]
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Generated {len(mistakes)} mistakes and {len(memories)} memory records")


if __name__ == "__main__":
    main()
