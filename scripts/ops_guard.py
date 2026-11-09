#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
RemoteOps VPS 运维核验工具（只使用 Python 标准库）。

支持：
1. releases：对照 Agent/Gateway 发布提交与握手协议；
2. memory：读取 cgroup v2 内核计数器，观察 OOM 和内存峰值；
3. backup：使用 SQLite Online Backup API 进行 WAL 一致性备份；
4. restore-verify：在隔离临时目录中还原备份并比对数据库结构与数据量。

本工具不会修改生产 systemd 服务，也不会输出 Token、密钥或实际业务数据。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass
from contextlib import closing
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ReleaseInfo:
    """源码发布信息。"""

    root: str
    commit: str | None
    protocol: int
    app_version: str | None


class ReleaseAuditor:
    """检查组件源码发布状态与协议兼容性。"""

    VERSION_RE = re.compile(r"const\s+VERSION\s*=\s*['\"]([^'\"]+)['\"]")
    PROTOCOL_RE = re.compile(r"const\s+PROTOCOL_VERSION\s*=\s*(\d+)")

    @classmethod
    def inspect(cls, root: Path, component: str) -> ReleaseInfo:
        """
        读取指定 Agent/Gateway 的协议与 Git 提交。
        :param root: 发布目录
        :param component: agent 或 gateway
        :return: 包含协议版本与 Git 提交的信息
        """
        relative = "agent/agent.js" if component == "agent" else "gateway/server.js"
        source = (root / relative).read_text(encoding="utf-8")
        match = cls.PROTOCOL_RE.search(source)
        if match is None:
            raise ValueError(f"缺少协议版本声明：{relative}")
        version = cls.VERSION_RE.search(source)
        result = subprocess.run(
            ["git", "-c", f"safe.directory={root.resolve()}", "-C", str(root),
             "rev-parse", "--verify", "HEAD"],
            capture_output=True, text=True, check=False, timeout=5,
        )
        commit = result.stdout.strip() if result.returncode == 0 else None
        return ReleaseInfo(str(root.resolve()), commit, int(match.group(1)),
                           version.group(1) if version else None)

    @classmethod
    def report(cls, agent: Path, gateway: Path) -> dict[str, Any]:
        """
        生成成套发布检查报告。
        :param agent: Agent 发布目录
        :param gateway: Gateway 发布目录
        :return: 兼容性、提交一致性与组件清单
        """
        a = cls.inspect(agent, "agent")
        g = cls.inspect(gateway, "gateway")
        return {
            "agent": asdict(a), "gateway": asdict(g),
            "protocol_compatible": a.protocol == g.protocol,
            "same_commit": bool(a.commit and g.commit and a.commit == g.commit),
            "same_source_tree": a.root == g.root,
            "action": ("BLOCK_PROTOCOL_MISMATCH" if a.protocol != g.protocol
                       else "RECOMMEND_PAIR_ROLLOUT" if a.commit != g.commit
                       else "OK"),
        }


class CgroupMonitor:
    """读取 cgroup v2 的控制组指标，不依赖 systemctl 或 sudo。"""

    METRICS = ("memory.current", "memory.peak", "memory.max",
               "memory.swap.current", "memory.events", "pids.current")

    @classmethod
    def read_service(cls, service: str, base: Path = Path("/sys/fs/cgroup/system.slice")) -> dict[str, Any]:
        """
        查询服务控制组当前指标。
        :param service: 已注册的 systemd 服务名，不接受目录分隔符
        :param base: cgroup v2 所在目录，测试时可注入虚拟文件目录
        :return: 内存、Swap、OOM、触限与风险判断
        """
        if not re.fullmatch(r"[A-Za-z0-9@_.-]+\.service", service):
            raise ValueError("非法 service 名称")
        folder = base / service

        def read_number(name: str) -> int | None:
            """读取字节/数量值，max 表示无限额。"""
            try:
                value = (folder / name).read_text().strip()
                return None if value == "max" else int(value)
            except (OSError, ValueError):
                return None

        events: dict[str, int] = {}
        try:
            for line in (folder / "memory.events").read_text().splitlines():
                key, number = line.split(maxsplit=1)
                events[key] = int(number)
        except (OSError, ValueError):
            pass
        current = read_number("memory.current")
        peak = read_number("memory.peak")
        limit = read_number("memory.max")
        swap = read_number("memory.swap.current")
        risk = []
        if limit and peak is not None and peak / limit >= 0.8:
            risk.append("HISTORICAL_PEAK_OVER_80_PERCENT")
        if events.get("oom_kill", 0) > 0:
            risk.append("OOM_KILLS_RECORDED")
        if events.get("max", 0) > 0:
            risk.append("MEMORY_LIMIT_HITS_RECORDED")
        if limit and swap is not None and swap > limit * 0.25:
            risk.append("SWAP_OVER_25_PERCENT_OF_MEMORY_LIMIT")
        return {
            "service": service, "current_bytes": current, "peak_bytes": peak,
            "limit_bytes": limit, "swap_bytes": swap,
            "oom_count": events.get("oom", 0),
            "oom_kill_count": events.get("oom_kill", 0),
            "max_events": events.get("max", 0),
            "pids": read_number("pids.current"),
            "warnings": risk,
        }


class SqliteBackupDrill:
    """在线备份与可重复的隔离恢复验证。"""

    @staticmethod
    def table_summary(db: sqlite3.Connection) -> dict[str, int]:
        """
        返回各普通业务表行数，不读取或打印业务字段。
        :param db: 数据库连接
        :return: 按表名映射的行数
        """
        rows = db.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        summary: dict[str, int] = {}
        for (name,) in rows:
            quoted = '"' + name.replace('"', '""') + '"'
            summary[name] = db.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0]
        return summary

    @classmethod
    def verify(cls, backup: Path) -> dict[str, Any]:
        """
        对备份执行独立还原与数据/结构一致性核验。
        :param backup: 要验证的 SQLite 备份文件
        :return: 完整性、表数、总记录数和验证结果
        """
        if not backup.is_file():
            raise FileNotFoundError(f"备份文件不存在：{backup}")
        with tempfile.TemporaryDirectory(prefix="remoteops-restore-") as work:
            target = Path(work) / "restored.db"
            inspect_copy = Path(work) / "source-copy.db"
            # 既有备份可能在文件头保留 WAL 模式：先复制到隔离目录，
            # 再以读写模式打开，避免在只读备份目录创建 -wal/-shm 失败。
            import shutil
            shutil.copyfile(backup, inspect_copy)
            with closing(sqlite3.connect(inspect_copy)) as source:
                integrity = source.execute("PRAGMA integrity_check").fetchone()[0]
                if integrity != "ok":
                    raise ValueError("原始备份完整性校验失败")
                original = cls.table_summary(source)
                schema = source.execute(
                    "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"
                ).fetchall()
                with closing(sqlite3.connect(target)) as restored:
                    source.backup(restored)
                    if restored.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                        raise ValueError("恢复数据库完整性校验失败")
                    if cls.table_summary(restored) != original:
                        raise ValueError("恢复后表的行数不匹配")
                    restored_schema = restored.execute(
                        "SELECT type,name,sql FROM sqlite_master ORDER BY type,name"
                    ).fetchall()
                    if restored_schema != schema:
                        raise ValueError("恢复后数据库结构不匹配")
            return {
                "restored": True, "integrity": "ok", "tables": len(original),
                "total_rows": sum(original.values()),
                "backup_bytes": backup.stat().st_size,
            }

    @classmethod
    def backup(cls, source: Path, destination: Path) -> dict[str, Any]:
        """
        使用 SQLite 在线备份接口创建 WAL 一致性快照并立即验证恢复。
        :param source: 业务数据库（运行中也可备份）
        :param destination: 私有备份路径，不允许覆盖既有备份
        :return: 创建并验证的结果
        """
        if destination.exists():
            raise FileExistsError("拒绝覆盖已有备份")
        destination.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".remoteops-backup-", suffix=".db",
                                        dir=destination.parent)
        os.close(fd)
        temp_path = Path(temporary)
        try:
            os.chmod(temp_path, 0o600)
            with closing(sqlite3.connect(f"{source.resolve().as_uri()}?mode=ro", uri=True)) as active:
                with closing(sqlite3.connect(temp_path)) as snapshot:
                    active.backup(snapshot)
                    # 快照文件必须可独立恢复：消除 WAL 模式对伴随 -wal/-shm 文件的依赖。
                    snapshot.execute("PRAGMA journal_mode=DELETE")
                    snapshot.commit()
            result = cls.verify(temp_path)
            os.replace(temp_path, destination)
            return {"path": str(destination), **result}
        finally:
            temp_path.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    """
    运维检查命令行入口。
    :param argv: 可选命令行参数，默认使用 sys.argv
    :return: 0 成功，2 协议不兼容或错误，3 非同提交严格检查失败
    """
    parser = argparse.ArgumentParser(description="RemoteOps 发布、资源与备份核验")
    sub = parser.add_subparsers(dest="action", required=True)
    releases = sub.add_parser("releases", help="发布提交与协议检查")
    releases.add_argument("--agent", required=True, type=Path)
    releases.add_argument("--gateway", required=True, type=Path)
    releases.add_argument("--strict", action="store_true", help="要求同一个 Git 提交")
    memory = sub.add_parser("memory", help="cgroup 资源核验")
    memory.add_argument("--service", action="append", required=True)
    backup = sub.add_parser("backup", help="在线备份并立即恢复验证")
    backup.add_argument("--source", required=True, type=Path)
    backup.add_argument("--destination", required=True, type=Path)
    restore = sub.add_parser("restore-verify", help="只读恢复演练")
    restore.add_argument("--backup", required=True, type=Path)
    opts = parser.parse_args(argv)
    try:
        if opts.action == "releases":
            result = ReleaseAuditor.report(opts.agent, opts.gateway)
            code = 2 if not result["protocol_compatible"] else (
                3 if opts.strict and not result["same_commit"] else 0)
        elif opts.action == "memory":
            result = {"services": [CgroupMonitor.read_service(s) for s in opts.service]}
            code = 0
        elif opts.action == "backup":
            result = SqliteBackupDrill.backup(opts.source, opts.destination)
            code = 0
        else:
            result = SqliteBackupDrill.verify(opts.backup)
            code = 0
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return code
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False),
              file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
