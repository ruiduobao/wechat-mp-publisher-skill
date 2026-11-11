#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 保留旧命令入口，参数、类型检查和状态计算统一由 launcher 处理。
if (import.meta.main) {
  const launcher = fileURLToPath(new URL('../bin/launch-publisher.mjs', import.meta.url));
  const child = spawn('node', [launcher, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('close', code => { process.exitCode = code ?? 1; });
}
