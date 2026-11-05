/**
 * SymPy 计算服务主进程管理器（S4 数理场景）。
 *
 * 职责：
 * - spawn Python 子进程（dev 跑 python/sympy_server.py；packaged 跑 extraResources 下的 exe）
 * - NDJSON 协议：一行一个 JSON，通过 stdin/stdout 收发
 * - 请求队列 + id 配对 + 超时（COMPUTE_TIMEOUT_MS）
 * - 首次请求时启动并 ping；故障树确认停止后由下一次请求重新启动
 * - 父进程已退出但旧树无法确认时失败闭合，不重用可能已回收的 PID
 * - 退出清理
 *
 * 设计要点：
 * 1. stdout 是流式的，可能一次 data 事件返回半行 → 必须做行缓冲（stdoutBuffer）
 * 2. 每条请求设置独立定时器；超时后从 pending 移除，防止内存泄漏
 * 3. 连续 3 次超时或进程退出 → 释放故障进程并把 pending 回 SERVICE_DOWN；不重放计算
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { app } from 'electron';
import { stopOwnedProcess } from './ownedProcessShutdown';
import {
  COMPUTE_TIMEOUT_MS,
  type ComputeCommand,
  type ComputeIpcResponse,
  type ComputeServiceStatus,
} from '../types';

/** 预热等待上限（毫秒）：启动后等待 ping 成功的最长时间 */
const WARMUP_WAIT_MS = 30000;
/** 连续超时次数阈值，达到后重启进程 */
const MAX_CONSECUTIVE_TIMEOUTS = 3;

/* ===== 模块级单例状态 ===== */
let child: ChildProcess | null = null;
let ready = false;
let warming = false;
let lastError: string | undefined;
let seq = 0;
/** 请求 id → 待响应（resolve + 超时定时器） */
const pending = new Map<string, { resolve: (r: ComputeIpcResponse) => void; timer: NodeJS.Timeout }>();
/** stdout 行缓冲（处理半行） */
let stdoutBuffer = '';
/** 连续超时计数 */
let consecutiveTimeouts = 0;
/** 并发首次调用共享一轮启动及预热，不重复 spawn/ping。 */
let startup: Promise<void> | undefined;
/** Keep the exact stop operation until its complete tree receipt; a parent exit
 * alone must not release a restart/exit barrier. Failed entries remain retryable. */
const retired = new Map<ChildProcess, { stopping?: Promise<void> }>();
/** 是否正在销毁（销毁中不再重启） */
let disposing = false;

/* ================================================================
 * 入口路径解析
 * ================================================================ */

/**
 * 解析 SymPy 服务入口。
 * - 打包态：从 extraResources 下取（release/sympy_dist/sympy_server/）
 * - 开发态：直接跑 python/sympy_server.py
 */
function resolveSympyEntry(): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };

  if (app.isPackaged) {
    // 打包态：预编译的独立可执行文件（阶段五接入打包流程）
    const exe = path.join(process.resourcesPath, 'sympy_server', 'sympy_server.exe');
    return { cmd: exe, args: [], env };
  }

  // 开发态：直接跑源码脚本
  const script = path.join(app.getAppPath(), 'python', 'sympy_server.py');
  return { cmd: 'python', args: [script], env };
}

/* ================================================================
 * 请求分发与响应处理
 * ================================================================ */

/** 清空所有待响应请求（回 SERVICE_DOWN） */
function rejectAllPending(reason: string, errorCode = 'SERVICE_DOWN'): void {
  for (const [, item] of pending) {
    clearTimeout(item.timer);
    item.resolve({ ok: false, error: reason, errorCode });
  }
  pending.clear();
}

/** 处理 Python 返回的一行 */
function handleLine(line: string): void {
  let msg: { id?: string; ok?: boolean; result?: unknown; error?: string; errorCode?: string };
  try {
    msg = JSON.parse(line);
  } catch {
    // 非 JSON 输出（如调试 print）忽略，不打断协议
    console.log('[sympy] 忽略非 JSON 输出:', line.slice(0, 200));
    return;
  }
  if (!msg || typeof msg !== 'object') return;

  const id = typeof msg.id === 'string' ? msg.id : '';
  const item = pending.get(id);
  if (!item) {
    // id 不匹配（可能是超时后迟到的响应）直接丢弃
    return;
  }
  pending.delete(id);
  clearTimeout(item.timer);

  if (msg.ok !== true) {
    consecutiveTimeouts = 0;
    item.resolve({ ok: false, error: msg.error || '未知错误', errorCode: msg.errorCode || 'INTERNAL_ERROR' });
    return;
  }

  consecutiveTimeouts = 0;
  item.resolve({ ok: true, result: msg.result });
}

/** stdout 数据到达：按行切分（最后一段留回缓冲） */
function handleStdout(chunk: Buffer | string): void {
  stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
  let idx = stdoutBuffer.indexOf('\n');
  while (idx >= 0) {
    const line = stdoutBuffer.slice(0, idx).trim();
    stdoutBuffer = stdoutBuffer.slice(idx + 1);
    if (line) handleLine(line);
    idx = stdoutBuffer.indexOf('\n');
  }
}

/* ================================================================
 * 进程生命周期
 * ================================================================ */

/** 发送一条原始请求（内部使用，不做就绪检查） */
function sendRaw(id: string, cmd: ComputeCommand, args: Record<string, unknown>, timeoutMs = COMPUTE_TIMEOUT_MS): Promise<ComputeIpcResponse> {
  return new Promise<ComputeIpcResponse>((resolve) => {
    if (!child || !child.stdin || child.killed) {
      resolve({ ok: false, error: '计算服务未启动', errorCode: 'SERVICE_DOWN' });
      return;
    }

    const timer = setTimeout(() => {
      pending.delete(id);
      consecutiveTimeouts += 1;
      resolve({ ok: false, error: `计算超时（${timeoutMs}ms）`, errorCode: 'TIMEOUT' });
      // 释放可能卡死的进程；下一次功能调用再启动，不在空闲时预热。
      if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
        console.warn('[sympy] 连续超时达阈值，重启计算服务');
        if (child) retireProcess(child, '计算服务重启中');
      }
    }, timeoutMs);

    pending.set(id, { resolve, timer });

    try {
      child.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
    } catch (e) {
      if (child) retireProcess(child, `写入计算服务失败：${(e as Error).message}`);
    }
  });
}

/** 故障回调只拥有它实际创建的句柄，旧进程不能清空新进程或回复新请求。 */
function stopRetiredProcess(owned: ChildProcess, options: { timeoutMs?: number } = {}): Promise<void> {
  const entry = retired.get(owned);
  if (!entry) return Promise.resolve();
  if (entry.stopping) return entry.stopping;
  const operation = Promise.resolve().then(() => stopOwnedProcess(owned, { ...options, requireTreeStop: true }));
  entry.stopping = operation;
  void operation.then(() => {
    if (retired.get(owned) === entry) retired.delete(owned);
  }, () => {
    // Do not discard the handle or reinterpret an exited parent as success.
    if (entry.stopping === operation) entry.stopping = undefined;
  });
  return operation;
}

function retireProcess(owned: ChildProcess, reason: string, options: { timeoutMs?: number } = {}): void {
  if (child !== owned) return;
  child = null;
  ready = false;
  warming = false;
  stdoutBuffer = '';
  consecutiveTimeouts = 0;
  lastError = reason;
  rejectAllPending(reason);
  // A failed spawn has no PID and no running process to stop.
  if (owned.pid) {
    if (!retired.has(owned)) retired.set(owned, {});
    void stopRetiredProcess(owned, options).catch(() => {
      console.warn('[sympy] 故障计算进程尚未确认停止，保留所属句柄供重试');
    });
  }
}

/** 启动只由明确调用触发；共享的 Promise 也包含 ping 成功/失败的等待。 */
export function initSympyServer(): Promise<void> {
  if (disposing || (ready && child && !child.killed)) return Promise.resolve();
  if (startup) return startup;
  warming = true;
  const attempt = Promise.resolve().then(startSympyServer);
  startup = attempt;
  void attempt.then(() => { if (startup === attempt) startup = undefined; }, () => {
    if (startup === attempt) startup = undefined;
  });
  return attempt;
}

async function startSympyServer(): Promise<void> {
  if (disposing) return;
  warming = true;
  ready = false;
  stdoutBuffer = '';
  let owned: ChildProcess;
  try {
    for (const obsolete of retired.keys()) {
      await stopRetiredProcess(obsolete);
    }
    if (disposing) return;
    const { cmd, args, env } = resolveSympyEntry();
    owned = spawn(cmd, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = owned;
  } catch (e) {
    warming = false;
    lastError = `启动计算服务失败：${(e as Error).message}`;
    console.warn('[sympy]', lastError);
    return;
  }

  owned.stdout?.on('data', (chunk: Buffer | string) => {
    if (child === owned && !disposing) handleStdout(chunk);
  });

  owned.stderr?.on('data', (chunk: Buffer) => {
    if (child !== owned || disposing) return;
    // stderr 只记日志，不参与协议
    const text = chunk.toString('utf-8').trim();
    if (text) console.log('[sympy]', text.slice(0, 500));
  });

  const failed = (err: Error) => retireProcess(owned, `计算服务进程错误：${err.message}`);
  owned.on('error', failed);
  // Pipe failures are asynchronous too; never leave an unhandled EPIPE event.
  owned.stdin?.on('error', failed);

  owned.on('exit', (code, signal) => {
    if (child !== owned) return;
    const reason = `计算服务已退出（code=${code}, signal=${signal}）`;
    console.warn('[sympy]', reason);
    retireProcess(owned, reason);
  });

  // 预热：发一条 ping（用 warmup- 前缀 id 标记）
  const warmupId = `warmup-${++seq}`;
  const res = await sendRaw(warmupId, 'ping', {}, WARMUP_WAIT_MS);
  if (child === owned && !disposing) {
    if (res.ok) {
      ready = true;
      warming = false;
      lastError = undefined;
    } else {
      retireProcess(owned, res.error || '计算服务预热失败');
    }
  }
}

/** 对外：发送一条计算命令（自带就绪等待） */
export async function runSympyCommand(
  cmd: ComputeCommand,
  args: Record<string, unknown>,
): Promise<ComputeIpcResponse> {
  // Cleanup must never create a service/session which did not exist. A view
  // cancelled during warmup closes again after its session_init has completed.
  if (cmd === 'session_close' && (disposing || !ready || !child || child.killed ||
    child.exitCode !== null || child.signalCode !== null)) {
    return { ok: true, result: { ok: true } };
  }
  if (cmd !== 'session_close') await initSympyServer();
  if (disposing || !ready || !child || child.killed) {
    return {
      ok: false,
      error: lastError || '计算服务未就绪',
      errorCode: 'SERVICE_DOWN',
    };
  }

  const id = `req-${++seq}`;
  return sendRaw(id, cmd, args);
}

/** 对外：服务状态 */
export function getSympyStatus(): ComputeServiceStatus {
  return {
    ready,
    warming,
    error: lastError,
  };
}

/** 对外：销毁（app 退出时调用） */
export async function disposeSympyServer(options:{timeoutMs?:number}={}): Promise<void> {
  disposing = true;
  ready = false;
  warming = false;
  rejectAllPending('应用退出，计算服务已关闭');
  const owned = child;
  if (owned) retireProcess(owned, '应用退出，计算服务已关闭', options);
  for (const obsolete of retired.keys()) {
    await stopRetiredProcess(obsolete, options);
  }
  ready = false;
  warming = false;
}
