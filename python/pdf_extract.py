"""PDF 文本抽取脚本（PyMuPDF 引擎）。

由 Electron 主进程通过子进程调用：`python pdf_extract.py <pdf_path>`，
从 stdout 输出一行 UTF-8 JSON：
  {"ok": true, "totalPages": n, "text": "..."}
失败时：
  {"ok": false, "error": "..."}

相比 unpdf（底层 pdf.js），PyMuPDF 对中文 CJK 字体的 ToUnicode/内置编码
识别更完整，能避免"芯片→芯""龙头企业→头企业"这类文本层缺字问题。
"""
import json
import sys

# Windows 下确保 stdout 以 UTF-8 输出，避免中文被 GBK 编码截断
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


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
    try:
        for page in doc:
            pages.append(page.get_text("text"))
    except Exception as e:
        _emit({"ok": False, "error": f"抽取文本失败：{e}"})
        return
    finally:
        doc.close()

    text = "\n".join(pages).strip()
    _emit({"ok": True, "totalPages": len(pages), "text": text})


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()