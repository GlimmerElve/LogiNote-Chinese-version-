"""PDF 文本抽取脚本（PyMuPDF 引擎）。

由 Electron 主进程通过子进程调用：`python pdf_extract.py <pdf_path>`，
从 stdout 输出一行 UTF-8 JSON。`text` 保持旧契约，`blocks` 增加页码与 bbox：
  {"ok": true, "totalPages": n, "text": "...", "blocks": [...]}
失败时：
  {"ok": false, "error": "..."}

相比 unpdf（底层 pdf.js），PyMuPDF 对中文 CJK 字体的 ToUnicode/内置编码
识别更完整，能避免"芯片→芯""龙头企业→头企业"这类文本层缺字问题。
"""
import json
import contextlib
import io
import statistics
import sys
import re

# Windows 下确保 stdout 以 UTF-8 输出，避免中文被 GBK 编码截断
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def _clean_cell(value) -> str:
    return " ".join(str(value or "").replace("\r", "\n").split())


def _formula_evidence(lines, page, page_lines, strokes):
    """Cheap risk signals only: no OCR, confidence percentage or truth claim.

    Conservative region may include surrounding prose. Vector/scanned equations
    can escape these heuristics; callers must keep the full-page fallback.
    """
    text = " ".join(line["text"] for line in lines)
    reasons = []
    if re.search(r"[∫∑∏√≤≥≠∞±∂∇]|[A-Za-zα-ωΑ-Ω][^。！？]{0,32}[=^]|[=][^。！？]{0,32}[A-Za-zα-ωΑ-Ω]", text):
        reasons.append("math_symbols_or_equation")
    if any(line.get("superscript") for line in lines):
        reasons.append("superscript_layout")
    if "\ufffd" in text:
        reasons.append("missing_glyph")
    box = [min(line["bbox"][0] for line in lines), min(line["bbox"][1] for line in lines),
           max(line["bbox"][2] for line in lines), max(line["bbox"][3] for line in lines)]
    # A short horizontal stroke with nearby text above and below may be a
    # fraction, but could also be a table rule. False positives stay unverified.
    fraction_strokes = []
    for x0, y, x1 in strokes:
        if x1 < box[0] - 40 or x0 > box[2] + 40 or not box[1] - 22 <= y <= box[3] + 22:
            continue
        nearby = [line for line in page_lines if line["bbox"][2] >= x0 - 5 and line["bbox"][0] <= x1 + 5
                  and line["bbox"][1] < y + 24 and line["bbox"][3] > y - 24]
        if any(line["baseline"] < y for line in nearby) and any(line["baseline"] > y for line in nearby):
            fraction_strokes.append((x0, y, x1, nearby))
    if fraction_strokes:
        reasons.append("possible_fraction_layout")
        for x0, y, x1, nearby in fraction_strokes:
            box = [min(box[0], x0, *(line["bbox"][0] for line in nearby)),
                   min(box[1], y, *(line["bbox"][1] for line in nearby)),
                   max(box[2], x1, *(line["bbox"][2] for line in nearby)),
                   max(box[3], y, *(line["bbox"][3] for line in nearby))]
    # Include an adjacent base glyph / equality on the same mathematical row.
    # It is safer to retain a little context than cut off a sub/superscript base.
    if reasons:
        neighbors = [line for line in page_lines if line["bbox"][2] >= box[0] - 35 and line["bbox"][0] <= box[2] + 35
                     and line["bbox"][1] < box[3] and line["bbox"][3] > box[1]]
        if neighbors:
            box = [min(box[0], *(line["bbox"][0] for line in neighbors)), min(box[1], *(line["bbox"][1] for line in neighbors)),
                   max(box[2], *(line["bbox"][2] for line in neighbors)), max(box[3], *(line["bbox"][3] for line in neighbors))]
    if not reasons:
        return None
    rect = page.rect
    region = [max(rect.x0, box[0] - 8), max(rect.y0, box[1] - 10),
              min(rect.x1, box[2] + 8), min(rect.y1, box[3] + 10)]
    return {"origin": "pdf_layout", "status": "needs_visual_check", "reasons": reasons,
            "region": [round(float(value), 2) for value in region]}


def _table_text(rows) -> tuple[str, str]:
    clean_rows = [[_clean_cell(cell) for cell in (row or [])] for row in (rows or [])]
    clean_rows = [row for row in clean_rows if any(row)]
    if not clean_rows:
        return "", ""
    width = max(len(row) for row in clean_rows)
    clean_rows = [row + [""] * (width - len(row)) for row in clean_rows]
    raw = "\n".join("\t".join(row) for row in clean_rows)
    escaped = [[cell.replace("|", "\\|") for cell in row] for row in clean_rows]
    markdown = ["| " + " | ".join(escaped[0]) + " |", "| " + " | ".join(["---"] * width) + " |"]
    markdown.extend("| " + " | ".join(row) + " |" for row in escaped[1:])
    return raw, "\n".join(markdown)


def _credible_table(rows):
    """Validate BEFORE masking text. A decorative frame is not a data grid.

    Rejected candidates remain normal text with their original geometry. This
    deliberately leaves single-column boxes to the prose path (no text loss).
    """
    clean = [[_clean_cell(cell) for cell in row] for row in (rows or []) if row]
    populated = [row for row in clean if any(row)]
    if len(populated) < len(clean) * .6:
        return False
    columns = {index for row in populated for index, cell in enumerate(row) if cell}
    width = max((len(row) for row in clean), default=0)
    filled = sum(bool(cell) for row in clean for cell in row)
    # Plot gridlines can cut one label into dozens of mostly empty "cells".
    # Such a sparse wide grid is not reliable table evidence. Keep its original
    # text/geometry instead of masking the chart and inventing a markdown table.
    if width >= 6 and filled < len(clean) * width * .15:
        return False
    return len(populated) >= 2 and len(columns) >= 2 and sum(
        sum(bool(cell) for cell in row) >= 2 for row in populated) >= 2


def _has_table_grid(page):
    """Cheap gate for the existing line-based table engines (not OCR).

    At least two populated rows/columns require three distinct row/column
    borders. Borderless tables were not detected by the default line strategy
    either. Uncertain/vector-heavy pages still take the full detector path.
    """
    try:
        drawings = page.get_drawings()
        if len(drawings) > 3000:
            return True
        horizontal, vertical = [], []
        for drawing in drawings:
            for item in drawing.get("items", []):
                segments = []
                if item[0] == "l":
                    segments = [(item[1], item[2])]
                elif item[0] == "re":
                    rect = item[1]
                    segments = [(rect.tl, rect.tr), (rect.tr, rect.br), (rect.br, rect.bl), (rect.bl, rect.tl)]
                elif item[0] == "qu":
                    quad = item[1]
                    segments = [(quad.ul, quad.ur), (quad.ur, quad.lr), (quad.lr, quad.ll), (quad.ll, quad.ul)]
                for a, b in segments:
                    if abs(a.y - b.y) < 1 and abs(a.x - b.x) >= 12:
                        horizontal.append(((a.y + b.y) / 2, min(a.x, b.x), max(a.x, b.x)))
                    if abs(a.x - b.x) < 1 and abs(a.y - b.y) >= 12:
                        vertical.append(((a.x + b.x) / 2, min(a.y, b.y), max(a.y, b.y)))
        # Printing crop marks provide many X/Y coordinates but no connected
        # grid. Require actual intersections, not just a count of line positions.
        if len(horizontal) * len(vertical) > 250_000:
            return True
        rows, columns = {}, {}
        for y, x0, x1 in horizontal:
            for x, y0, y1 in vertical:
                if x0 - 3 <= x <= x1 + 3 and y0 - 3 <= y <= y1 + 3:
                    row, column = round(y), round(x)
                    rows.setdefault(row, set()).add(column)
                    columns.setdefault(column, set()).add(row)
        return sum(sum(len(columns[x]) >= 3 for x in xs) >= 3 for xs in rows.values()) >= 3
    except Exception:
        return True


def _pdfplumber_tables(pdf_path: str, candidate_pages=None):
    if candidate_pages is not None and not candidate_pages:
        return {}, []
    try:
        import pdfplumber  # type: ignore
    except Exception:
        return {}, ["pdfplumber 未安装；将尝试 PyMuPDF 内置表格检测。"]
    result = {}
    warnings = []
    try:
        with pdfplumber.open(pdf_path, pages=candidate_pages) as pdf:
            for page in pdf.pages:
                page_index = page.page_number - 1
                tables = []
                try:
                    for table_index, table in enumerate(page.find_tables()):
                        rows = table.extract()
                        if not _credible_table(rows):
                            continue
                        raw, text = _table_text(rows)
                        if not text:
                            continue
                        bbox = [round(float(value), 2) for value in table.bbox]
                        tables.append({"tableIndex": table_index, "bbox": bbox, "rawText": raw, "text": text})
                except Exception as exc:
                    warnings.append(f"第 {page_index + 1} 页 pdfplumber 表格检测失败：{exc}")
                result[page_index] = tables
                # pdfplumber otherwise retains every page's parsed layout for
                # the lifetime of the book. Table results are already detached.
                if hasattr(page, "close"):
                    page.close()
    except Exception as exc:
        return {}, [f"pdfplumber 打开资料失败：{exc}"]
    return result, warnings


def _overlap_ratio(a, b) -> float:
    left, top = max(a[0], b[0]), max(a[1], b[1])
    right, bottom = min(a[2], b[2]), min(a[3], b[3])
    if right <= left or bottom <= top:
        return 0.0
    area = max(1.0, (a[2] - a[0]) * (a[3] - a[1]))
    return ((right - left) * (bottom - top)) / area


def _pymupdf_tables(page):
    if not hasattr(page, "find_tables"):
        return []
    output = []
    try:
        # 新版 PyMuPDF 会向 stdout 打印布局提示；stdout 是本脚本的 JSON 协议，必须隔离。
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            found = page.find_tables()
        for table_index, table in enumerate(getattr(found, "tables", [])):
            rows = table.extract()
            if not _credible_table(rows):
                continue
            raw, text = _table_text(rows)
            if text:
                output.append({
                    "tableIndex": table_index,
                    "bbox": [round(float(value), 2) for value in table.bbox],
                    "rawText": raw,
                    "text": text,
                })
    except Exception:
        return []
    return output


def _split_disjoint_columns(lines, page_width):
    """Some PDFs store left/right column lines in one text object.

    Split only when both substantial groups overlap vertically and their line
    boxes do not overlap horizontally. The shared TS projection orders columns.
    """
    if len(lines) < 4:
        return [lines]
    starts = sorted(set(float(line["bbox"][0]) for line in lines))
    for left, right in sorted(zip(starts, starts[1:]), key=lambda pair: pair[1] - pair[0], reverse=True):
        if right - left < page_width * 0.2:
            break
        split = (left + right) / 2
        a = [line for line in lines if line["bbox"][0] < split]
        b = [line for line in lines if line["bbox"][0] >= split]
        if len(a) < 2 or len(b) < 2:
            continue
        if max(line["bbox"][2] for line in a) > min(line["bbox"][0] for line in b) - 6:
            continue
        overlap = min(max(line["bbox"][3] for line in a), max(line["bbox"][3] for line in b)) - max(
            min(line["bbox"][1] for line in a), min(line["bbox"][1] for line in b))
        if overlap >= 15:
            return [sorted(a, key=lambda line: line["bbox"][1]), sorted(b, key=lambda line: line["bbox"][1])]
    return [lines]


def _split_drop_caps(lines, median_size):
    # A text object may contain both the preceding heading and the next
    # paragraph's oversized initial. Isolate by line, not the object's max font.
    groups, pending = [], []
    for line in lines:
        if re.fullmatch(r"[A-Z]", line["text"]) and max(line["sizes"], default=0) >= median_size * 2:
            if pending:
                groups.append(pending)
                pending = []
            groups.append([line])
        else:
            pending.append(line)
    if pending:
        groups.append(pending)
    return groups


def main() -> None:
    if len(sys.argv) < 2:
        _emit({"ok": False, "error": "缺少 PDF 路径参数"})
        return

    pdf_path = sys.argv[1]

    try:
        # 优先用新版 `pymupdf` 命名（避免 `fitz` 的 deprecated warning 污染 stdout）
        try:
            import pymupdf as fitz  # pyright: ignore[reportMissingImports]
        except ImportError:
            import fitz  # type: ignore  # PyMuPDF 旧版命名
    except Exception as e:  # pragma: no cover - 依赖缺失提示
        _emit({"ok": False, "error": f"PyMuPDF 未安装：{e}"})
        return

    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        _emit({"ok": False, "error": f"打开 PDF 失败：{e}"})
        return

    pages = []
    output_blocks = []
    candidate_pages = [index + 1 for index, page in enumerate(doc) if _has_table_grid(page)]
    candidate_page_set = set(candidate_pages)
    plumber_tables, warnings = _pdfplumber_tables(pdf_path, candidate_pages)
    table_engine = "pdfplumber" if any(plumber_tables.values()) else "pymupdf"
    pymupdf_table_api = False
    try:
        for page_index, page in enumerate(doc):
            page_dict = page.get_text("dict")
            image_boxes = [block["bbox"] for block in page_dict.get("blocks", []) if block.get("type") == 1]
            text_blocks = [block for block in page_dict.get("blocks", []) if block.get("type") == 0]
            page_lines = [{"text": "".join(str(span.get("text", "")) for span in line.get("spans", [])),
                           "bbox": line["bbox"], "baseline": max((span.get("origin", (0, 0))[1]
                           for span in line.get("spans", [])), default=line["bbox"][3])}
                          for block in text_blocks for line in block.get("lines", [])]
            strokes = []
            # Cap retained signals. A pathological/vector-heavy page falls back
            # to the page screenshot rather than quadratic layout analysis.
            try:
                drawings = page.get_drawings()
                if len(drawings) <= 3000:
                    for drawing in drawings:
                        for item in drawing.get("items", []):
                            if item[0] == "l" and abs(item[1].y - item[2].y) < .8:
                                x0, x1 = sorted([item[1].x, item[2].x])
                                if 3 <= x1 - x0 <= 120 and len(strokes) < 100:
                                    strokes.append((x0, item[1].y, x1))
            except Exception:
                pass
            tables = plumber_tables.get(page_index, [])
            if not tables and page_index + 1 in candidate_page_set:
                pymupdf_table_api = pymupdf_table_api or hasattr(page, "find_tables")
                tables = _pymupdf_tables(page)
                if tables:
                    table_engine = "pymupdf-find-tables"
            font_sizes = [
                float(span.get("size", 0))
                for block in text_blocks
                for line in block.get("lines", [])
                for span in line.get("spans", [])
                if span.get("text", "").strip() and float(span.get("size", 0)) > 0
            ]
            median_size = statistics.median(font_sizes) if font_sizes else 0
            page_items = []
            for original_index, block in enumerate(text_blocks):
                bbox = [round(float(value), 2) for value in block.get("bbox", (0, 0, 0, 0))]
                retained_lines = []
                for line in block.get("lines", []):
                    line_bbox = list(line.get("bbox", bbox))
                    # A text block can contain both prose and table cells. Only
                    # exclude the individual lines actually covered by a table.
                    if any(_overlap_ratio(line_bbox, table["bbox"]) >= 0.5 for table in tables):
                        continue
                    spans = line.get("spans", [])
                    line_text = "".join(str(span.get("text", "")) for span in spans).strip()
                    if line_text:
                        retained_lines.append({"text": line_text, "bbox": line_bbox,
                            "direction": list(line.get("dir", (1, 0))),
                            "superscript": any(int(span.get("flags", 0)) & 1 for span in spans),
                            "sizes": [float(span.get("size", 0)) for span in spans if span.get("text", "").strip()]})
                line_groups = [group for column in _split_disjoint_columns(retained_lines, float(page.rect.width))
                               for group in _split_drop_caps(column, median_size)]
                for group_index, lines in enumerate(line_groups):
                    block_text = "\n".join(line["text"] for line in lines).strip()
                    if not block_text:
                        continue
                    retained_boxes = [line["bbox"] for line in lines]
                    block_sizes = [size for line in lines for size in line["sizes"]]
                    bbox = [round(min(box[0] for box in retained_boxes), 2),
                            round(min(box[1] for box in retained_boxes), 2),
                            round(max(box[2] for box in retained_boxes), 2),
                            round(max(box[3] for box in retained_boxes), 2)]
                    max_size = max(block_sizes, default=0)
                    # Only explicit chapter labels are decorations. Other
                    # vertical text can be a legitimate label and is retained.
                    rotated = any(abs(line["direction"][1]) > .8 for line in lines)
                    layout_role = None
                    if re.search(r"\.qxp\b.*\bPage\s*\d+", block_text, re.I):
                        layout_role = "print_furniture"
                    elif bbox[3] - bbox[1] < 30 and len(block_text) < 180 and re.search(
                            r"^(?:\d+\s+)?(?:C\s+H\s+A\s+P\s+T\s+E\s+R|P\s+A\s+R\s+T)\s*\d+\s*■", block_text):
                        layout_role = "print_furniture"
                    elif rotated and re.fullmatch(r"chapter\s*\d+", block_text, re.I):
                        layout_role = "chapter_label"
                    elif re.fullmatch(r"part\s*\d+", block_text, re.I) and max_size > median_size * 2:
                        layout_role = "chapter_label"
                    elif rotated and len(block_text) < 160 and re.search(
                            r"copyright|©|corbis|bettmann|coleman|photo|photograph|courtesy", block_text, re.I):
                        layout_role = "credit"
                    elif rotated and len(block_text) < 160 and max_size <= median_size * .8 and any(
                            0 <= bbox[0] - image[2] <= 18 and bbox[1] >= image[1] - 5
                            and bbox[3] <= image[3] + 5 for image in image_boxes):
                        # Tiny rotated attribution immediately outside a photo,
                        # not an arbitrary vertical diagram/axis label.
                        layout_role = "credit"
                    elif len(lines) == 1 and re.fullmatch(r"[A-Z]", block_text) and max_size >= median_size * 2:
                        layout_role = "drop_cap"
                    is_heading = bool(median_size and max_size >= median_size * 1.25 and len(block_text) <= 160)
                    if layout_role:
                        is_heading = False
                    rendered_text = f"# {block_text}" if is_heading and not block_text.startswith("#") else block_text
                    evidence = _formula_evidence(lines, page, page_lines[:2000], strokes)
                    page_items.append({
                        "page": page_index + 1,
                        "originalIndex": original_index * 1000 + group_index,
                        "bbox": bbox,
                        "pageHeight": round(float(page.rect.height), 2),
                        "fontSize": max_size,
                        "layoutRole": layout_role,
                        "kind": "notes" if layout_role in ("print_furniture", "chapter_label", "credit") else "heading" if is_heading else "paragraph",
                        "rawText": block_text,
                        "text": rendered_text,
                        **({"formulaEvidence": evidence} if evidence else {}),
                    })
            for table in tables:
                page_items.append({
                    "page": page_index + 1,
                    "originalIndex": 1_000_000 + int(table["tableIndex"]),
                    "tableIndex": int(table["tableIndex"]),
                    "bbox": table["bbox"],
                    "pageHeight": round(float(page.rect.height), 2),
                    "kind": "table",
                    "rawText": table["rawText"],
                    "text": table["text"],
                })
            # Chapter-openers often contain a small-font contents sidebar next
            # to the drop-cap paragraph. Do not mistake it for prose or a new
            # section; leave unrelated sidebars / vertical labels untouched.
            caps = [item for item in page_items if item.get("layoutRole") == "drop_cap"]
            has_chapter_label = any(item.get("layoutRole") == "chapter_label" for item in page_items)
            contents_candidates = []
            for item in page_items:
                if not has_chapter_label or item.get("layoutRole") or item["kind"] not in ("paragraph", "heading"):
                    continue
                box = item["bbox"]
                if any(box[2] < cap["bbox"][0] - 10 and box[1] >= cap["bbox"][1] - 30
                       and box[3] > cap["bbox"][1] and box[2] - box[0] < page.rect.width * .28
                       and item.get("fontSize", 0) <= median_size * 1.5 for cap in caps):
                    contents_candidates.append(item)
            # A single explanatory margin note is not a contents list. Require
            # multiple short, non-sentential entries on the chapter opener.
            short_entries = [item for item in contents_candidates if not re.search(r"[.!?。！？]\s*$", item["rawText"])
                             and all(len(line.split()) <= 12 for line in item["rawText"].splitlines())]
            if len(contents_candidates) >= 4 and len(short_entries) >= len(contents_candidates) * .8:
                for item in contents_candidates:
                    item["kind"] = "list"
                    item["layoutRole"] = "contents"
                    item["text"] = item["rawText"]
            page_items.sort(key=lambda item: (item["bbox"][1], item["bbox"][0], item["originalIndex"]))
            page_parts = []
            for block_index, item in enumerate(page_items):
                item["blockIndex"] = block_index
                item["id"] = f"p{page_index + 1}:b{block_index}"
                item.pop("originalIndex", None)
                output_blocks.append(item)
                page_parts.append(item["text"])
            pages.append("\n\n".join(page_parts))
    except Exception as e:
        _emit({"ok": False, "error": f"抽取文本失败：{e}"})
        return
    finally:
        doc.close()

    text = "\n".join(pages).strip()
    if pymupdf_table_api:
        warnings = [warning for warning in warnings if "未安装" not in warning]
    _emit({
        "ok": True,
        "totalPages": len(pages),
        "text": text,
        "blocks": output_blocks,
        "engine": f"pymupdf+{table_engine}",
        "warnings": warnings,
    })


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
