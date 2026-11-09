#!/usr/bin/env python3
"""扫描 Git 已跟踪或暂存的文件，阻止明显的凭据与运行时数据进入仓库。"""

from __future__ import annotations

import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Finding:
    """单条扫描发现。

    :param path: 相对仓库的文件路径
    :param reason: 违规原因
    """

    path: str
    reason: str


class TrackedSecretScanner:
    """以 Git 索引为准执行轻量级敏感文件检查。

    :param root: Git 仓库根目录
    """

    DENIED_NAMES = {
        ".env", "device.json", "owner-token", "device-secret",
        "id_rsa", "id_ed25519", "mcp.db", "policy.json",
    }
    DENIED_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".sqlite", ".sqlite3", ".db")
    TOKEN_PATTERNS = [
        re.compile("-----BEGIN " + "(?:OPENSSH |RSA |EC )?PRIVATE KEY-----"),
        re.compile("gh" + "p_[A-Za-z0-9]{20,}"),
        re.compile("github_" + "pat_[A-Za-z0-9_]{30,}"),
        re.compile("sk" + "-[A-Za-z0-9]{28,}"),
    ]

    def __init__(self, root: Path) -> None:
        """初始化扫描器。

        :param root: 仓库根路径
        :return: None
        """
        self.root = root

    def tracked_paths(self) -> list[Path]:
        """列出 Git 索引中的文件，避免扫描未跟踪的个人文件。

        :return: Git 索引中的文件路径
        """
        result = subprocess.run(
            ["git", "-C", str(self.root), "ls-files", "-z"],
            check=True,
            capture_output=True,
        )
        return [Path(x.decode("utf-8", "replace")) for x in result.stdout.split(b"\0") if x]

    def scan(self) -> list[Finding]:
        """检查敏感路径及明显凭据内容。

        :return: 扫描发现的违规列表
        """
        findings: list[Finding] = []
        for relative in self.tracked_paths():
            file_path = self.root / relative
            if not file_path.is_file() or file_path.is_symlink():
                continue
            name = relative.name.lower()
            dirs = {part.lower() for part in relative.parts}
            if (
                name in self.DENIED_NAMES
                or name.startswith(".env.")
                or name.endswith(self.DENIED_SUFFIXES)
                or "secrets" in dirs
                or "node_modules" in dirs
            ) and name != ".env.example":
                findings.append(Finding(str(relative), "敏感配置、二进制密钥或运行数据不应入库"))
                continue

            if file_path.stat().st_size > 1_000_000:
                continue
            content = file_path.read_text(encoding="utf-8", errors="replace")
            if any(pattern.search(content) for pattern in self.TOKEN_PATTERNS):
                findings.append(Finding(str(relative), "检测到高风险凭据格式"))
        return findings


def main() -> int:
    """运行安全扫描并返回 CI 退出码。

    :return: 0 表示通过，1 表示发现风险
    """
    root = Path(__file__).resolve().parents[1]
    findings = TrackedSecretScanner(root).scan()
    if findings:
        for item in findings:
            print(f"ERROR {item.path}: {item.reason}", file=sys.stderr)
        return 1
    print("PASS: tracked-file secret scan")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
