import { Disposable, ViewColumn, WebviewPanel, window, workspace } from 'vscode';
import { formatStockLabel } from '../api/stockApi';
import { fetchIntraday, IntradayData, supportsIntraday } from '../api/intradayApi';
import { fetchKline, KlineBar, supportsKline } from '../api/klineApi';
import { pairwiseCorrelations, PairwiseCorrelation } from '../utils/correlation';
import { QuoteScheduler } from '../service/quoteScheduler';

export interface CompareStock {
  code: string;
  name: string;
  secid?: string;
}

type ComparePeriod = 'intraday' | 'daily';

const INTRADAY_REFRESH_MS = 60000;
const DAILY_BARS = 120;

const COMPARE_COLORS = ['#5eb8ff', '#f0c74a', '#f472b6', '#22d3ee', '#a78bfa'];

interface CompareSeriesPayload {
  code: string;
  name: string;
  color: string;
  values: (number | null)[];
  latestPct: number | null;
}

interface CompareChartPayload {
  period: ComparePeriod;
  labels: string[];
  series: CompareSeriesPayload[];
  correlations: PairwiseCorrelation[];
  warnings: string[];
  riseColor: string;
  fallColor: string;
}

/** 走势对比面板：多股归一化涨跌幅叠加 + Pearson 相关系数 */
export class StockComparePanel implements Disposable {
  private static current: StockComparePanel | undefined;
  private panel: WebviewPanel;
  private stocks: CompareStock[];
  private chartPeriod: ComparePeriod;
  private chartRequestId = 0;
  private shellLoaded = false;
  private intradayTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(panel: WebviewPanel, stocks: CompareStock[]) {
    this.panel = panel;
    this.stocks = stocks;
    this.chartPeriod = defaultComparePeriod(stocks);
    this.panel.onDidDispose(() => this.dispose(), null, []);
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) {
        this.postChartRedraw();
        if (this.chartPeriod === 'intraday') {
          void this.loadChart();
        }
      }
      this.syncIntradayTimer(e.webviewPanel.visible);
    });
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (
        msg?.type === 'switchPeriod' &&
        (msg.period === 'intraday' || msg.period === 'daily')
      ) {
        this.chartPeriod = msg.period;
        this.syncIntradayTimer(this.panel.visible);
        void this.loadChart();
      }
    });
    this.loadShell();
  }

  static show(stocks: CompareStock[]): void {
    const title =
      stocks.length <= 2
        ? `对比 · ${stocks.map((s) => s.name).join(' / ')}`
        : `走势对比 (${stocks.length})`;

    if (StockComparePanel.current) {
      const panel = StockComparePanel.current;
      panel.stocks = stocks;
      panel.chartPeriod = defaultComparePeriod(stocks);
      panel.panel.title = title;
      panel.panel.reveal(ViewColumn.One);
      panel.loadShell();
      return;
    }

    const webviewPanel = window.createWebviewPanel(
      'takeHomeStockCompare',
      title,
      ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    StockComparePanel.current = new StockComparePanel(webviewPanel, stocks);
  }

  dispose(): void {
    this.stopIntradayTimer();
    if (StockComparePanel.current === this) {
      StockComparePanel.current = undefined;
    }
  }

  private loadShell(): void {
    this.shellLoaded = true;
    this.chartRequestId++;
    this.panel.webview.html = buildShellHtml(this.stocks, this.chartPeriod);
    this.syncIntradayTimer(this.panel.visible);
    void this.loadChart();
  }

  private postChartRedraw(): void {
    if (!this.shellLoaded) {
      return;
    }
    void this.panel.webview.postMessage({ type: 'chartRedraw' });
  }

  private syncIntradayTimer(visible: boolean): void {
    this.stopIntradayTimer();
    if (!visible || this.chartPeriod !== 'intraday') {
      return;
    }
    const anyIntraday = this.stocks.some((s) => supportsIntraday(s.code, s.secid));
    if (!anyIntraday) {
      return;
    }
    this.intradayTimer = setInterval(() => {
      if (this.panel.visible && this.chartPeriod === 'intraday') {
        void this.loadChart();
      }
    }, INTRADAY_REFRESH_MS);
  }

  private stopIntradayTimer(): void {
    if (this.intradayTimer) {
      clearInterval(this.intradayTimer);
      this.intradayTimer = undefined;
    }
  }

  private async loadChart(): Promise<void> {
    if (this.chartPeriod === 'intraday') {
      await this.loadIntradayCompare();
    } else {
      await this.loadDailyCompare();
    }
  }

  private async loadIntradayCompare(): Promise<void> {
    const requestId = ++this.chartRequestId;
    const period: ComparePeriod = 'intraday';

    void this.panel.webview.postMessage({ type: 'chartStatus', period, status: 'loading' });

    try {
      const results = await Promise.all(
        this.stocks.map(async (stock) => {
          if (!supportsIntraday(stock.code, stock.secid)) {
            return { stock, data: null as IntradayData | null, error: '暂无分时' };
          }
          const data = await fetchIntraday(stock.code, stock.secid);
          if (!data || data.points.length === 0) {
            return { stock, data: null, error: '暂无分时数据' };
          }
          return { stock, data, error: undefined };
        })
      );

      if (requestId !== this.chartRequestId) {
        return;
      }

      const payload = buildIntradayPayload(results);
      if (!payload) {
        void this.panel.webview.postMessage({
          type: 'chartStatus',
          period,
          status: 'error',
          message: '所选股票均暂无分时数据，请切换日 K',
        });
        return;
      }

      void this.panel.webview.postMessage({ type: 'compareChart', ...payload });
    } catch {
      if (requestId !== this.chartRequestId) {
        return;
      }
      void this.panel.webview.postMessage({
        type: 'chartStatus',
        period,
        status: 'error',
        message: '分时对比加载失败，请稍后重试',
      });
    }
  }

  private async loadDailyCompare(): Promise<void> {
    const requestId = ++this.chartRequestId;
    const period: ComparePeriod = 'daily';

    void this.panel.webview.postMessage({ type: 'chartStatus', period, status: 'loading' });

    try {
      const results = await Promise.all(
        this.stocks.map(async (stock) => {
          if (!supportsKline(stock.code, stock.secid)) {
            return { stock, bars: [] as KlineBar[], error: '暂无日 K' };
          }
          const bars = await fetchKline(stock.code, 'daily', DAILY_BARS, stock.secid);
          if (bars.length === 0) {
            return { stock, bars, error: '暂无日 K 数据' };
          }
          return { stock, bars, error: undefined };
        })
      );

      if (requestId !== this.chartRequestId) {
        return;
      }

      const payload = buildDailyPayload(results);
      if (!payload) {
        void this.panel.webview.postMessage({
          type: 'chartStatus',
          period,
          status: 'error',
          message: '所选股票均暂无日 K 数据',
        });
        return;
      }

      void this.panel.webview.postMessage({ type: 'compareChart', ...payload });
    } catch {
      if (requestId !== this.chartRequestId) {
        return;
      }
      void this.panel.webview.postMessage({
        type: 'chartStatus',
        period,
        status: 'error',
        message: '日 K 对比加载失败，请稍后重试',
      });
    }
  }
}

function defaultComparePeriod(stocks: CompareStock[]): ComparePeriod {
  if (stocks.every((s) => supportsIntraday(s.code, s.secid))) {
    return 'intraday';
  }
  return 'daily';
}

function themeColors(): { riseColor: string; fallColor: string } {
  const cfg = workspace.getConfiguration('take-home');
  return {
    riseColor: cfg.get<string>('riseColor', '#f14c4c'),
    fallColor: cfg.get<string>('fallColor', '#73c991'),
  };
}

function normalizeIntradayPoints(data: IntradayData): Map<string, number> {
  const pre = data.preClose;
  const map = new Map<string, number>();
  if (pre <= 0) {
    return map;
  }
  for (const p of data.points) {
    map.set(p.time, ((p.price - pre) / pre) * 100);
  }
  return map;
}

function normalizeDailyBars(bars: KlineBar[]): Map<string, number> {
  const map = new Map<string, number>();
  if (!bars.length) {
    return map;
  }
  const base = bars[0].close;
  if (base <= 0) {
    return map;
  }
  for (const b of bars) {
    map.set(b.date, ((b.close - base) / base) * 100);
  }
  return map;
}

function buildIntradayPayload(
  results: {
    stock: CompareStock;
    data: IntradayData | null;
    error?: string;
  }[]
): CompareChartPayload | null {
  const valid = results.filter((r) => r.data && r.data.points.length > 0);
  if (valid.length === 0) {
    return null;
  }

  const warnings: string[] = [];
  for (const r of results) {
    if (!r.data && r.error) {
      warnings.push(`${r.stock.name}：${r.error}`);
    }
  }

  const maps = valid.map((r) => ({
    stock: r.stock,
    map: normalizeIntradayPoints(r.data!),
  }));

  const labelSet = new Set<string>();
  for (const { map } of maps) {
    for (const t of map.keys()) {
      labelSet.add(t);
    }
  }
  const labels = [...labelSet].sort(compareTimeLabel);

  const series: CompareSeriesPayload[] = maps.map(({ stock, map }, i) => {
    const values = labels.map((t) => map.get(t) ?? null);
    const finite = values.filter((v): v is number => v !== null);
    const latestPct = finite.length > 0 ? finite[finite.length - 1] : null;
    return {
      code: stock.code,
      name: stock.name,
      color: COMPARE_COLORS[i % COMPARE_COLORS.length],
      values,
      latestPct,
    };
  });

  const aligned = series.map((s) => s.values.map((v) => (v === null ? NaN : v)));
  const correlations = pairwiseCorrelations(
    series.map((s) => s.name),
    aligned
  );

  return {
    period: 'intraday',
    labels,
    series,
    correlations,
    warnings,
    ...themeColors(),
  };
}

function buildDailyPayload(
  results: {
    stock: CompareStock;
    bars: KlineBar[];
    error?: string;
  }[]
): CompareChartPayload | null {
  const valid = results.filter((r) => r.bars.length > 0);
  if (valid.length === 0) {
    return null;
  }

  const warnings: string[] = [];
  for (const r of results) {
    if (r.bars.length === 0 && r.error) {
      warnings.push(`${r.stock.name}：${r.error}`);
    }
  }

  const maps = valid.map((r) => ({
    stock: r.stock,
    map: normalizeDailyBars(r.bars),
  }));

  let labels = [...maps[0].map.keys()];
  for (let i = 1; i < maps.length; i++) {
    const set = new Set(maps[i].map.keys());
    labels = labels.filter((d) => set.has(d));
  }

  if (labels.length < 2) {
    const union = new Set<string>();
    for (const { map } of maps) {
      for (const d of map.keys()) {
        union.add(d);
      }
    }
    labels = [...union].sort();
  }

  const series: CompareSeriesPayload[] = maps.map(({ stock, map }, i) => {
    const values = labels.map((d) => map.get(d) ?? null);
    const finite = values.filter((v): v is number => v !== null);
    const latestPct = finite.length > 0 ? finite[finite.length - 1] : null;
    return {
      code: stock.code,
      name: stock.name,
      color: COMPARE_COLORS[i % COMPARE_COLORS.length],
      values,
      latestPct,
    };
  });

  const aligned = series.map((s) => s.values.map((v) => (v === null ? NaN : v)));
  const correlations = pairwiseCorrelations(
    series.map((s) => s.name),
    aligned
  );

  return {
    period: 'daily',
    labels,
    series,
    correlations,
    warnings,
    ...themeColors(),
  };
}

function compareTimeLabel(a: string, b: string): number {
  const pa = parseTimeMinutes(a);
  const pb = parseTimeMinutes(b);
  if (pa !== null && pb !== null) {
    return pa - pb;
  }
  return a.localeCompare(b);
}

function parseTimeMinutes(time: string): number | null {
  const match = time.match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function buildShellHtml(stocks: CompareStock[], activePeriod: ComparePeriod): string {
  const hasIntraday = stocks.some((s) => supportsIntraday(s.code, s.secid));
  const hasDaily = stocks.some((s) => supportsKline(s.code, s.secid));
  const period =
    activePeriod === 'intraday' && hasIntraday
      ? 'intraday'
      : hasDaily
        ? 'daily'
        : hasIntraday
          ? 'intraday'
          : 'daily';

  const tab = (p: ComparePeriod, label: string) =>
    `<button class="tab${period === p ? ' active' : ''}" data-period="${p}"${p === 'intraday' && !hasIntraday ? ' disabled title="所选股票暂无分时"' : ''}${p === 'daily' && !hasDaily ? ' disabled title="所选股票暂无日 K"' : ''}>${label}</button>`;

  const stockList = stocks
    .map(
      (s, i) =>
        `<span class="stock-tag" style="--c:${COMPARE_COLORS[i % COMPARE_COLORS.length]}">${escapeHtml(formatStockLabel(s.name, s.code))}</span>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    * { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px 24px 32px; margin: 0; line-height: 1.5; }
    h1 { font-size: 1.25em; margin: 0 0 6px; font-weight: 600; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 0.88em; margin-bottom: 12px; }
    .stock-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .stock-tag { font-size: 0.85em; padding: 2px 8px; border-radius: 3px; background: color-mix(in srgb, var(--c) 18%, transparent); border-left: 3px solid var(--c); }
    .chart-section { margin-top: 4px; }
    .chart-header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
    .chart-title { font-weight: 600; font-size: 0.95em; }
    .tabs { display: flex; gap: 4px; }
    .tab { padding: 4px 12px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35)); background: transparent; color: var(--vscode-foreground); cursor: pointer; font-family: inherit; font-size: 0.85em; border-radius: 2px; }
    .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
    .tab:disabled { opacity: 0.45; cursor: not-allowed; }
    .tab:hover:not(.active):not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
    .legend { display: flex; flex-wrap: wrap; gap: 12px 16px; margin-bottom: 8px; font-size: 0.82em; }
    .leg-item { display: inline-flex; align-items: center; gap: 6px; }
    .leg-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .leg-pct { font-variant-numeric: tabular-nums; }
    .corr { font-size: 0.82em; color: var(--vscode-descriptionForeground); margin-bottom: 10px; line-height: 1.6; }
    .corr strong { color: var(--vscode-foreground); font-variant-numeric: tabular-nums; }
    .warn { font-size: 0.8em; color: var(--vscode-editorWarning-foreground, #cca700); margin-bottom: 8px; }
    .chart-wrap { position: relative; height: 360px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25)); border-radius: 4px; background: var(--vscode-editor-background); }
    #chart { display: block; width: 100%; height: 100%; }
    .chart-tooltip { position: absolute; pointer-events: none; z-index: 5; padding: 8px 10px; font-size: 0.8em; line-height: 1.45; border-radius: 4px; background: var(--vscode-editorHoverWidget-background, #252526); border: 1px solid rgba(128,128,128,0.35); box-shadow: 0 2px 8px rgba(0,0,0,0.25); max-width: 280px; }
    .chart-tooltip.hidden { display: none; }
    .chart-status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
    .chart-status.hidden { display: none; }
    .hint { margin-top: 14px; font-size: 0.8em; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <h1>走势对比</h1>
  <div class="meta">Y 轴为归一化涨跌幅（%）；分时相对昨收，日 K 相对区间起点收盘</div>
  <div class="stock-tags">${stockList}</div>
  <div class="chart-section">
    <div class="chart-header">
      <span class="chart-title">叠加图</span>
      <div class="tabs">
        ${tab('intraday', '分时')}
        ${tab('daily', '日 K')}
      </div>
    </div>
    <div class="legend" id="legend"></div>
    <div class="corr" id="corr"></div>
    <div class="warn" id="warnings"></div>
    <div class="chart-wrap">
      <canvas id="chart"></canvas>
      <div class="chart-tooltip hidden" id="chartTooltip"></div>
      <div class="chart-status" id="chartStatus">加载…</div>
    </div>
  </div>
  <p class="hint">自选股中 Ctrl/⌘+点击多选 2～5 只，右键「对比走势」；相关系数越接近 1 走势越同步，接近 0 无明显线性相关，接近 -1 反向。跨市场对比时交易时段可能不完全对齐。</p>
  <script>
    ${getCompareChartScript(period)}
  </script>
</body>
</html>`;
}

function getCompareChartScript(activePeriod: ComparePeriod): string {
  return `
    const vscode = acquireVsCodeApi();
    let activePeriod = '${activePeriod}';
    let chartPayload = null;
    let chartState = null;
    let riseColor = '#f14c4c';
    let fallColor = '#73c991';

    const canvas = document.getElementById('chart');
    const chartTooltip = document.getElementById('chartTooltip');
    const chartWrap = canvas.parentElement;

    canvas.addEventListener('mousemove', onChartHover);
    canvas.addEventListener('mouseleave', hideChartTooltip);

    document.querySelectorAll('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const period = btn.dataset.period;
        if (period === activePeriod) return;
        activePeriod = period;
        document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.period === period));
        chartPayload = null; chartState = null;
        hideChartTooltip();
        vscode.postMessage({ type: 'switchPeriod', period });
      });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'compareChart') updateCompareChart(msg);
      if (msg.type === 'chartStatus') updateChartStatus(msg);
      if (msg.type === 'chartRedraw') redrawChart(null);
    });

    window.addEventListener('resize', () => { hideChartTooltip(); redrawChart(null); });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => requestAnimationFrame(() => redrawChart(null))).observe(chartWrap);
    }

    function updateChartStatus(msg) {
      if (msg.period !== activePeriod) return;
      const el = document.getElementById('chartStatus');
      if (msg.status === 'loading') {
        el.textContent = msg.period === 'intraday' ? '加载分时对比…' : '加载日 K 对比…';
        el.classList.remove('hidden');
        return;
      }
      if (msg.status === 'error') {
        chartPayload = null; chartState = null;
        clearChart(); hideChartTooltip();
        document.getElementById('legend').innerHTML = '';
        document.getElementById('corr').innerHTML = '';
        document.getElementById('warnings').textContent = '';
        el.textContent = msg.message || '加载失败';
        el.classList.remove('hidden');
      }
    }

    function updateCompareChart(msg) {
      if (msg.period !== activePeriod) return;
      riseColor = msg.riseColor || riseColor;
      fallColor = msg.fallColor || fallColor;
      chartPayload = msg;
      document.getElementById('chartStatus').classList.add('hidden');
      renderLegend(msg);
      renderCorrelations(msg.correlations || []);
      renderWarnings(msg.warnings || []);
      hideChartTooltip();
      drawCompareChart(msg, null);
    }

    function renderLegend(msg) {
      const el = document.getElementById('legend');
      el.innerHTML = (msg.series || []).map((s) => {
        const pct = s.latestPct != null ? fmtSignedPct(s.latestPct) : '--';
        const color = s.latestPct > 0 ? riseColor : s.latestPct < 0 ? fallColor : '';
        return '<span class="leg-item"><i class="leg-dot" style="background:' + esc(s.color) + '"></i>' +
          esc(s.name) + ' <span class="leg-pct" style="color:' + (color || 'inherit') + '">' + pct + '</span></span>';
      }).join('');
    }

    function renderCorrelations(pairs) {
      const el = document.getElementById('corr');
      if (!pairs.length) { el.innerHTML = ''; return; }
      el.innerHTML = '相关系数：' + pairs.map((p) =>
        esc(shortName(p.a)) + '↔' + esc(shortName(p.b)) + ' <strong>' + p.r.toFixed(2) + '</strong>'
      ).join('　');
    }

    function renderWarnings(warnings) {
      document.getElementById('warnings').textContent = warnings.length ? '未纳入：' + warnings.join('；') : '';
    }

    function shortName(n) { return n.length > 6 ? n.slice(0, 5) + '…' : n; }

    function fmtSignedPct(n) {
      if (n == null || !Number.isFinite(n)) return '--';
      return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
    }

    function pickIndex(mx, pad, slot, len) {
      const rel = mx - pad.left;
      return Math.min(len - 1, Math.max(0, Math.round(rel / slot - 0.5)));
    }

    function onChartHover(e) {
      if (!chartState || !chartPayload) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { pad, slot, w, h, len } = chartState;
      if (mx < pad.left || mx > w - pad.right || my < pad.top || my > h - pad.bottom) {
        hideChartTooltip(); return;
      }
      const idx = pickIndex(mx, pad, slot, len);
      const crossX = pad.left + idx * slot + slot / 2;
      redrawChart({ x: crossX, y: my });
      showChartTooltip(idx, crossX, my);
    }

    function showChartTooltip(idx, localX, localY) {
      const label = chartPayload.labels[idx] || '';
      let html = '<div><strong>' + esc(formatLabel(label)) + '</strong></div>';
      for (const s of chartPayload.series) {
        const v = s.values[idx];
        const pct = v != null ? fmtSignedPct(v) : '--';
        const color = v > 0 ? riseColor : v < 0 ? fallColor : '';
        html += '<div><i class="leg-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + esc(s.color) + ';margin-right:4px"></i>' +
          esc(s.name) + ' ' + '<span style="color:' + (color || 'inherit') + '">' + pct + '</span></div>';
      }
      chartTooltip.innerHTML = html;
      chartTooltip.classList.remove('hidden');
      const tipW = chartTooltip.offsetWidth || 180;
      const tipH = chartTooltip.offsetHeight || 80;
      let left = localX + 14, top = localY - tipH - 10;
      if (left + tipW > chartWrap.clientWidth - 8) left = localX - tipW - 14;
      if (top < 8) top = localY + 14;
      chartTooltip.style.left = Math.max(8, left) + 'px';
      chartTooltip.style.top = Math.max(8, top) + 'px';
    }

    function formatLabel(l) {
      if (activePeriod === 'daily' && l.length >= 10) return l.slice(5);
      return l;
    }

    function hideChartTooltip() {
      chartTooltip.classList.add('hidden');
      if (chartState) redrawChart(null);
    }

    function redrawChart(crosshair) {
      if (chartPayload) drawCompareChart(chartPayload, crosshair);
    }

    function clearChart() {
      const ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function setupCanvas() {
      const wrap = canvas.parentElement;
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth, h = wrap.clientHeight;
      if (w < 1 || h < 1) return null;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      return { ctx, w, h };
    }

    function drawCompareChart(payload, crosshair) {
      const setup = setupCanvas();
      if (!setup) return;
      const { ctx, w, h } = setup;
      const labels = payload.labels || [];
      const series = payload.series || [];
      if (!labels.length || !series.length) { chartState = null; return; }

      const pad = { top: 16, right: 52, bottom: 28, left: 48 };
      const cw = w - pad.left - pad.right;
      const ch = h - pad.top - pad.bottom;

      let minY = 0, maxY = 0;
      for (const s of series) {
        for (const v of s.values) {
          if (v != null && Number.isFinite(v)) {
            minY = Math.min(minY, v);
            maxY = Math.max(maxY, v);
          }
        }
      }
      const padY = Math.max((maxY - minY) * 0.1, 0.5);
      minY -= padY; maxY += padY;
      const range = maxY - minY || 1;
      const y = (v) => pad.top + ch - ((v - minY) / range) * ch;
      const slot = cw / Math.max(labels.length - 1, 1);

      chartState = { pad, slot, w, h, len: labels.length, minY, range, ch };

      ctx.font = '11px sans-serif';
      for (let i = 0; i <= 4; i++) {
        const v = minY + (range * i) / 4;
        const yy = y(v);
        const pctStr = fmtSignedPct(v);
        ctx.fillStyle = v > 0 ? riseColor : v < 0 ? fallColor : 'rgba(128,128,128,0.55)';
        ctx.textAlign = 'left';
        ctx.fillText(pctStr, 4, yy + 4);
        ctx.strokeStyle = 'rgba(128,128,128,0.1)';
        ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(w - pad.right, yy); ctx.stroke();
      }

      if (minY < 0 && maxY > 0) {
        const zy = y(0);
        ctx.strokeStyle = 'rgba(128,128,128,0.55)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(pad.left, zy); ctx.lineTo(w - pad.right, zy); ctx.stroke();
        ctx.setLineDash([]);
      }

      for (const s of series) {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < s.values.length; i++) {
          const v = s.values[i];
          if (v == null || !Number.isFinite(v)) { started = false; continue; }
          const x = pad.left + i * slot;
          const yy = y(v);
          if (!started) { ctx.moveTo(x, yy); started = true; } else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }

      const idxs = [0, Math.floor(labels.length / 2), labels.length - 1];
      ctx.fillStyle = 'rgba(128,128,128,0.75)';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      for (const i of idxs) {
        const lbl = labels[i];
        if (!lbl) continue;
        ctx.fillText(formatLabel(lbl), pad.left + i * slot, h - 8);
      }

      if (crosshair) {
        const { x } = crosshair;
        ctx.save();
        ctx.strokeStyle = 'rgba(128,128,128,0.65)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, h - pad.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }

    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  `;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function showStockCompare(_quoteScheduler: QuoteScheduler, stocks: CompareStock[]): void {
  StockComparePanel.show(stocks);
}
