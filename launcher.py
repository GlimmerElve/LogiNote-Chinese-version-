# -*- coding: utf-8 -*-
"""LogiNote Pro 桌面版启动器（纯 Python 实现，可靠处理中文路径）。

迁移后不再依赖独立的 Express/Vite 后端：直接构建前端 + 启动 Electron。
"""
import subprocess
import sys
import os

BASE = os.path.dirname(os.path.abspath(__file__))


def main() -> int:
    print("=" * 40)
    print("  LogiNote Pro Desktop Launcher")
    print("=" * 40)

    print("[1/1] Building frontend + launching Electron ...")
    r = subprocess.run(
        ["npm", "run", "electron"],
        cwd=BASE,
        shell=True,
    )
    return r.returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        pass
    except Exception as e:
        print(f"启动失败: {e}", file=sys.stderr)
        input("按回车键退出...")