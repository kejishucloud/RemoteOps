/**
 * 测试资源统一清理：等待子进程停止、释放 SQLite 句柄后移除临时目录。
 * Windows 不允许删除仍被进程占用的数据库文件，因此不可直接 kill 后立即 rm。
 */
import fs from 'node:fs';

/**
 * 关闭单个 Node 子进程并等待其句柄释放。
 * @param {import('node:child_process').ChildProcess | null} child 子进程
 * @returns {Promise<void>} 关闭完成或超时
 */
async function closeChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let done = false;
    let timer;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    child.once('close', finish);
    child.once('error', finish);
    timer = setTimeout(finish, 4000);
    try { child.kill(); } catch { finish(); }
  });
}

/**
 * 关闭测试服务器，确保监听端口已释放。
 * @param {object} server HTTP/WebSocket 服务器
 * @returns {Promise<void>} 关闭完成或超时
 */
async function closeServer(server) {
  if (!server || server.listening === false) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(finish, 3000);
    try { server.close(finish); } catch { finish(); }
  });
}

/**
 * 在 Windows、macOS 和 Linux 上安全回收集成测试资源。
 * @param {{ directory: string, processes?: object[], servers?: object[], databases?: Set<object> }} args 参数
 * @returns {Promise<void>} 完成清理
 */
export async function cleanupResources({ directory, processes = [], servers = [], databases = new Set() }) {
  await Promise.all(processes.map(closeChild));
  await Promise.all(servers.map(closeServer));
  for (const db of databases) {
    try { db.close(); } catch { /* 已经关闭的连接无需重复操作 */ }
  }
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 40, retryDelay: 150 });
}
