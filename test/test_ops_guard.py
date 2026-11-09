#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RemoteOps 运维核验工具的离线单元测试。"""
from __future__ import annotations

import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "ops_guard.py"
SPEC = importlib.util.spec_from_file_location("ops_guard", MODULE_PATH)
assert SPEC and SPEC.loader
import sys
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ReleaseAuditorTests(unittest.TestCase):
    """模拟版本兼容和不一致情况。"""

    def test_detect_protocol_mismatch(self) -> None:
        """
        不同协议版本必须标记为不可安全切换。
        :return: 无
        """
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            a, g = root / "agent", root / "gateway"
            (a / "agent").mkdir(parents=True)
            (g / "gateway").mkdir(parents=True)
            (a / "agent/agent.js").write_text("const PROTOCOL_VERSION = 1;")
            (g / "gateway/server.js").write_text("const PROTOCOL_VERSION = 2;")
            report = MODULE.ReleaseAuditor.report(a, g)
            self.assertFalse(report["protocol_compatible"])
            self.assertEqual(report["action"], "BLOCK_PROTOCOL_MISMATCH")


class CgroupMonitorTests(unittest.TestCase):
    """模拟 kernel cgroup v2 的内存指标。"""

    def test_reads_oom_and_peak_without_changing_limit(self) -> None:
        """
        读取峰值、OOM 及触限事件；不更改生产限额。
        :return: 无
        """
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            group = base / "remoteops.service"
            group.mkdir()
            values = {
                "memory.current": "50000000\n",
                "memory.peak": "180000000\n",
                "memory.max": "200000000\n",
                "memory.swap.current": "60000000\n",
                "memory.events": "low 0\nhigh 0\nmax 2\noom 1\noom_kill 1\n",
                "pids.current": "6\n",
            }
            for name, value in values.items():
                (group / name).write_text(value)
            report = MODULE.CgroupMonitor.read_service("remoteops.service", base)
            self.assertEqual(report["oom_kill_count"], 1)
            self.assertEqual(report["peak_bytes"], 180000000)
            self.assertEqual(report["limit_bytes"], 200000000)
            self.assertIn("HISTORICAL_PEAK_OVER_80_PERCENT", report["warnings"])
            self.assertIn("SWAP_OVER_25_PERCENT_OF_MEMORY_LIMIT", report["warnings"])

    def test_rejects_cgroup_directory_traversal(self) -> None:
        """
        拒绝命令行注入式路径。
        :return: 无
        """
        with self.assertRaises(ValueError):
            MODULE.CgroupMonitor.read_service("../other.service")


class SqliteBackupTests(unittest.TestCase):
    """测试 WAL 模式下备份及沙盒恢复。"""

    def test_backup_and_restore_preserves_rows(self) -> None:
        """
        在线备份可用，恢复数据量与源文件一致，不能覆盖已有备份。
        :return: 无
        """
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            active = directory / "active.db"
            backup = directory / "backups" / "snapshot.db"
            with sqlite3.connect(active) as db:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("CREATE TABLE devices(id TEXT PRIMARY KEY, name TEXT)")
                db.executemany("INSERT INTO devices VALUES (?,?)", [
                    ("a", "macbook"), ("b", "vps"),
                ])
                db.commit()
                result = MODULE.SqliteBackupDrill.backup(active, backup)
                self.assertEqual(result["total_rows"], 2)
                self.assertEqual(result["integrity"], "ok")
                self.assertTrue(result["restored"])
                self.assertTrue(backup.exists())
                self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    MODULE.SqliteBackupDrill.backup(active, backup)

    def test_rejects_corrupted_backup(self) -> None:
        """
        损坏备份不能通过完整性校验。
        :return: 无
        """
        with tempfile.TemporaryDirectory() as td:
            file = Path(td) / "bad.db"
            file.write_bytes(b"not-a-valid-sqlite-database")
            with self.assertRaises(sqlite3.DatabaseError):
                MODULE.SqliteBackupDrill.verify(file)


if __name__ == "__main__":
    unittest.main()
