import { OutputChannel, window } from 'vscode';

let channel: OutputChannel | undefined;

function getChannel(): OutputChannel {
  if (!channel) {
    channel = window.createOutputChannel('赚钱离场');
  }
  return channel;
}

export function logInfo(message: string): void {
  getChannel().appendLine(`[信息] ${message}`);
}

export function logWarn(message: string): void {
  getChannel().appendLine(`[警告] ${message}`);
}

export function logError(message: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err ? String(err) : '';
  getChannel().appendLine(`[错误] ${message}${detail ? `: ${detail}` : ''}`);
}

export function showLog(): void {
  getChannel().show(true);
}
