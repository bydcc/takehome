import * as http from 'http';
import * as https from 'https';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface HttpGetOptions {
  params?: Record<string, string>;
  headers?: Record<string, string>;
  encoding?: 'utf8' | 'gb18030' | 'gbk' | 'latin1';
  timeoutMs?: number;
  /** 行情类请求应开启，避免 CDN/代理返回旧数据 */
  noCache?: boolean;
  /** 部分接口（如新浪 list=）会把额外 query 拼进代码，需只保留禁缓存请求头 */
  noCacheQueryParam?: boolean;
}

function decodeBody(buffer: Buffer, encoding: HttpGetOptions['encoding']): string {
  if (!encoding || encoding === 'utf8') {
    return buffer.toString('utf8');
  }
  if (encoding === 'latin1') {
    return buffer.toString('latin1');
  }
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch {
    // 部分 Electron 运行时不支持 gbk/gb18030，行情数字段仍为 ASCII
    return buffer.toString('latin1');
  }
}

/** 扩展宿主内使用 Node https，比 fetch 更稳定（代理/Referer 场景） */
export async function httpGet(url: string, options?: HttpGetOptions): Promise<string> {
  const target = new URL(url);
  if (options?.params) {
    for (const [key, value] of Object.entries(options.params)) {
      target.searchParams.set(key, value);
    }
  }
  if (options?.noCache && options.noCacheQueryParam !== false) {
    target.searchParams.set('_', String(Date.now()));
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...options?.headers,
  };
  if (options?.noCache) {
    headers['Cache-Control'] = 'no-cache, no-store';
    headers.Pragma = 'no-cache';
  }

  return new Promise((resolve, reject) => {
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      target,
      { method: 'GET', headers, timeout: timeoutMs },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = decodeBody(Buffer.concat(chunks), options?.encoding);
          if (body.trim() === 'Forbidden') {
            reject(new Error('HTTP Forbidden'));
            return;
          }
          resolve(body);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function httpGetJson<T>(url: string, options?: HttpGetOptions): Promise<T> {
  const body = await httpGet(url, { ...options, encoding: options?.encoding ?? 'utf8' });
  return JSON.parse(body) as T;
}
