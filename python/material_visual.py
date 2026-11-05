"""Render a scoped PDF page only. No OCR, model, network, or arbitrary output path."""
import base64
import json
import math
import sys
import pymupdf


def content_clip(page, clip):
    """Conservative outer-margin crop, no OCR and no removal of inner gaps.

    Image/background objects covering the page keep it intact. The browser can
    provide a display-only white-margin preview for already-saved scan images.
    """
    try:
        boxes = []
        for kind, box, *_ in page.get_bboxlog():
            if kind == "ignore-text":
                continue
            region = pymupdf.Rect(box) & clip
            if not region.is_empty and not region.is_infinite:
                boxes.append(region)
        if not boxes:
            return clip
        result = boxes[0]
        for box in boxes[1:]:
            result |= box
        return pymupdf.Rect(result.x0 - 6, result.y0 - 6, result.x1 + 6, result.y1 + 6) & clip
    except Exception:
        return clip


def main():
    with pymupdf.open(sys.argv[1]) as document:
        if len(sys.argv) == 2:
            if document.page_count > 2000:
                raise ValueError("PDF 页数超过视觉物料上限")
            return {"pageCount": document.page_count}
        page_number = int(sys.argv[2])
        if not 1 <= page_number <= document.page_count:
            raise ValueError("页码无效")
        page = document[page_number - 1]
        clip = page.rect
        cropped = len(sys.argv) == 7
        if cropped:
            values = [float(value) for value in sys.argv[3:7]]
            if not all(math.isfinite(value) for value in values) or values[2] <= values[0] or values[3] <= values[1]:
                raise ValueError("区域无效")
            clip = pymupdf.Rect(values) & page.rect
            if clip.is_empty:
                raise ValueError("区域不在页面内")
        clip = content_clip(page, clip)
        width, height = clip.width, clip.height
        if width <= 0 or height <= 0 or not math.isfinite(width * height):
            raise ValueError("页面尺寸无效")
        scale = min(3.5 if cropped else 2, 4096 / max(width, height), math.sqrt(3_000_000 / (width * height)))
        for _ in range(4):
            pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=clip, colorspace=pymupdf.csRGB, alpha=False)
            data = pixmap.tobytes("png") if cropped else pixmap.tobytes("jpeg", jpg_quality=80)
            if len(data) <= 1024 * 1024:
                return {"dataUrl": f"data:image/{'png' if cropped else 'jpeg'};base64," + base64.b64encode(data).decode("ascii"),
                        "alt": f"PDF 第 {page_number} 页{'公式候选区域' if cropped else '原图'}（未执行本地图片或公式识别）"}
            scale *= .75
        raise ValueError("页面图像超过安全上限")


if __name__ == "__main__":
    try:
        result = {"ok": True, **main()}
    except Exception:
        result = {"ok": False, "error": "PDF 原图暂不可读取"}
    sys.stdout.write(json.dumps(result, ensure_ascii=True))
