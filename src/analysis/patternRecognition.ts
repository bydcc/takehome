/**
 * K 线形态识别（Structure Engine）
 * 阶段一：Swing 强度、双层容差、S/R 区域、突破分级/假突破、结构评分。
 * 阶段二：MarketRegime、RANSAC、Lifecycle、评分重加权。
 * 修正：市态方向 / 倍率 0.8~1.15 / 时间覆盖 / invalidated / Retest / 视觉预算。
 * 收敛：Score Explain（几何·量·位·态，非回测概率）+ 波动率自适应容差。
 * 基于规则，不调用外部 AI。
 */

import { KlineBar } from '../api/klineApi';

export type PatternBias = 'bullish' | 'bearish' | 'neutral';
export type BreakoutQuality = 'weak' | 'normal' | 'strong' | 'false';
/** break 刚破；retest 回踩确认中；continue 二次上攻/下探 */
export type BreakoutPhase = 'break' | 'retest' | 'continue';
/**
 * forming 构筑；confirmed 确认；failed 短期失败（如跌回颈线）；
 * invalidated 结构彻底破坏（如跌破第二底）
 */
export type PatternStatus = 'forming' | 'confirmed' | 'failed' | 'invalidated';
export type SrFreshness = 'recent' | 'mid' | 'old';
export type MarketRegimeKind = 'trend' | 'range' | 'volatility';
export type TrendDirection = 'up' | 'down' | 'flat';

export interface MarketRegime {
  kind: MarketRegimeKind;
  /** 趋势方向（非 trend 时多为 flat） */
  direction: TrendDirection;
  /** 趋势/状态强度 0~100 */
  strength: number;
  /** 简易 ADX 0~100 */
  adx: number;
  /** MA20 相对斜率（%/bar 量级） */
  maSlopePct: number;
  /** 近段 ATR / 长段 ATR */
  atrRatio: number;
  /** 收盘相对 MA20 */
  aboveMa20: boolean;
  label: string;
  /** 判定清晰度 0~1 */
  clarity: number;
  focus: string;
}

export interface SRLevel {
  /** 区域中心价（兼容旧绘制逻辑） */
  price: number;
  upper: number;
  lower: number;
  type: 'support' | 'resistance' | 'pivot';
  /** 0~1 综合强度（含宽度惩罚后） */
  strength: number;
  /** 结构基础强度 0~1（重加权前） */
  baseStrength: number;
  touchCount: number;
  distancePct: number;
  /** 宽度相对价格 */
  widthPct: number;
  ageScore: number;
  freshness: SrFreshness;
  lastTouchAge: number;
  volumeBoosted: boolean;
  touchDates: string[];
}

export interface TrendLineResult {
  type: 'support' | 'resistance';
  startIndex: number;
  endIndex: number;
  startPrice: number;
  endPrice: number;
  touches: number;
  broken: boolean;
  breakIndex?: number;
  strength: number;
  /** 结构基础分 0~1 */
  baseStrength: number;
  /** 时间覆盖 0~1 */
  coverage: number;
}

export interface PatternKeyPoint {
  index: number;
  price: number;
  label?: string;
}

/** 可解释结构评分（非历史胜率、非回测概率） */
export interface StructureScoreBreakdown {
  /** 检测器几何/规则分 0~100 */
  geometric: number;
  /** 结构区间量能 0~100 */
  volume: number;
  /** 相对 S/R 位置语境 0~100 */
  location: number;
  /** 生命周期映射 0~100 */
  lifecycle: number;
  /** 四维加权混合，未乘 regime */
  blended: number;
  regimeFactor: number;
  weights: {
    geometric: number;
    volume: number;
    location: number;
    lifecycle: number;
  };
  reasons: string[];
}

export interface ChartPatternResult {
  id: string;
  name: string;
  bias: PatternBias;
  /** 最终结构评分 0~100（= blended × regime，非胜率） */
  confidence: number;
  score: number;
  /** 几何分（检测器输出） */
  baseScore: number;
  /** 可解释拆解 */
  breakdown?: StructureScoreBreakdown;
  regimeFactor?: number;
  status: PatternStatus;
  startIndex: number;
  endIndex: number;
  keyPoints: PatternKeyPoint[];
  description: string;
  targetPrice?: number;
  neckline?: number;
}

export interface BreakoutResult {
  index: number;
  direction: 'up' | 'down';
  kind: 'resistance' | 'support' | 'trendline';
  level: number;
  price: number;
  volumeConfirmed: boolean;
  quality: BreakoutQuality;
  phase: BreakoutPhase;
  volumeRatio: number;
  description: string;
  retestIndex?: number;
}

export interface PatternAnalysis {
  supportResistance: SRLevel[];
  trendLines: TrendLineResult[];
  patterns: ChartPatternResult[];
  breakouts: BreakoutResult[];
  summary: string;
  regime: MarketRegime;
  meta: {
    atr: number;
    levelTol: number;
    touchTol: number;
    breakTol: number;
    atrPeriod: number;
    period: 'daily' | 'weekly';
    falseWindow: number;
    /** ATR/Price，本序列波动分位代理 */
    volPct: number;
  };
}

export interface AnalyzeOptions {
  period?: 'daily' | 'weekly';
}

interface SwingPoint {
  index: number;
  price: number;
  kind: 'high' | 'low';
  strength: number;
  /** 与前一同向摆动点间距（根数），无则为 -1 */
  distanceFromPrev: number;
}

interface Tolerances {
  atr: number;
  levelTol: number;
  touchTol: number;
  breakTol: number;
  atrPeriod: number;
  period: 'daily' | 'weekly';
  falseWindow: number;
  volPct: number;
}

const SWING_LEFT = 3;
const SWING_RIGHT = 3;
/** 视觉 / 输出预算（认知负荷） */
const MAX_SR_LEVELS = 3;
const MAX_PATTERNS = 1;
const MAX_TRENDLINES = 2;
const MAX_BREAKOUTS = 3;
const TREND_END_MAX_AGE = 28;
const TREND_LOOKBACK = 70;
const PATTERN_MAX_AGE = 45;
/** 双顶底等统一分离度 */
const PATTERN_SEP_MIN = 5;
const PATTERN_SEP_MAX = 50;
/** Regime 修饰只允许小幅调整，避免打满 */
const REGIME_MATCH = 1.15;
const REGIME_NEUTRAL = 1.0;
const REGIME_MISMATCH = 0.8;

/** 对 K 线序列运行完整形态分析 */
export function analyzePatterns(
  bars: KlineBar[],
  options: AnalyzeOptions = {}
): PatternAnalysis | null {
  if (bars.length < 30) {
    return null;
  }

  const tols = computeTolerances(bars, options.period);
  const lastClose = bars[bars.length - 1].close;

  const highs = findSwings(bars, 'high', SWING_LEFT, SWING_RIGHT, tols.atr);
  const lows = findSwings(bars, 'low', SWING_LEFT, SWING_RIGHT, tols.atr);
  const regime = detectMarketRegime(bars, tols.atr);

  let supportResistance = detectSupportResistance(bars, highs, lows, tols, lastClose);
  let trendLines = detectTrendLines(bars, highs, lows, tols, lastClose);
  let patterns = detectChartPatterns(bars, highs, lows, tols, lastClose);
  let breakouts = detectBreakouts(bars, supportResistance, trendLines, tols);

  // Score Explain：几何 + 量能 + 位置 + 生命周期 × 市态（无回测概率）
  patterns = scorePatterns(patterns, bars, supportResistance, breakouts, regime, lastClose);

  ({ supportResistance, trendLines, patterns, breakouts } = applyRegimeWeights(
    regime,
    supportResistance,
    trendLines,
    patterns,
    breakouts
  ));

  // 视觉预算：硬裁
  supportResistance = supportResistance.slice(0, MAX_SR_LEVELS);
  trendLines = trendLines.slice(0, MAX_TRENDLINES);
  patterns = patterns.slice(0, MAX_PATTERNS);
  breakouts = breakouts.slice(0, MAX_BREAKOUTS);

  const summary = buildSummary(
    supportResistance,
    trendLines,
    patterns,
    breakouts,
    lastClose,
    regime
  );

  return {
    supportResistance,
    trendLines,
    patterns,
    breakouts,
    summary,
    regime,
    meta: {
      atr: tols.atr,
      levelTol: tols.levelTol,
      touchTol: tols.touchTol,
      breakTol: tols.breakTol,
      atrPeriod: tols.atrPeriod,
      period: tols.period,
      falseWindow: tols.falseWindow,
      volPct: tols.volPct,
    },
  };
}

function computeTolerances(bars: KlineBar[], period?: 'daily' | 'weekly'): Tolerances {
  const p: 'daily' | 'weekly' = period === 'weekly' ? 'weekly' : 'daily';
  let atrPeriod = p === 'weekly' ? 10 : 14;
  const byLen = Math.round(Math.sqrt(bars.length));
  atrPeriod = Math.min(Math.max(atrPeriod, Math.min(byLen, 20)), 20);
  atrPeriod = Math.min(atrPeriod, Math.max(5, bars.length - 1));

  const atr = computeATR(bars, atrPeriod);
  const lastClose = bars[bars.length - 1].close;
  const range = priceRange(bars);
  const volPct = lastClose > 0 ? atr / lastClose : 0.02;

  // 本序列波动自适应：低波动窄容差，高波动放宽容差（非股票标签分类）
  let scale = 1;
  if (volPct < 0.012) {
    scale = 0.85;
  } else if (volPct > 0.04) {
    scale = 1.22;
  } else if (volPct > 0.028) {
    scale = 1.1;
  }

  const levelTol = Math.max(atr * 0.5, lastClose * 0.008, range * 0.01) * scale;
  const touchTol = Math.max(atr * 0.35, lastClose * 0.004) * scale;
  const breakTol = Math.max(atr * 0.8, lastClose * 0.01) * scale;
  // 假突破确认窗口：日 3~5（取 4）；周 2；高波略加长
  let falseWindow = p === 'weekly' ? 2 : 4;
  if (volPct > 0.035 && p === 'daily') {
    falseWindow = 5;
  }

  return { atr, levelTol, touchTol, breakTol, atrPeriod, period: p, falseWindow, volPct };
}

function priceRange(bars: KlineBar[]): number {
  let hi = -Infinity;
  let lo = Infinity;
  for (const b of bars) {
    hi = Math.max(hi, b.high);
    lo = Math.min(lo, b.low);
  }
  return hi - lo || 1;
}

function computeATR(bars: KlineBar[], period: number): number {
  if (bars.length < 2) {
    return bars[0]?.close * 0.02 || 1;
  }
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    trs.push(
      Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close))
    );
  }
  const n = Math.min(period, trs.length);
  let sum = 0;
  for (let i = trs.length - n; i < trs.length; i++) {
    sum += trs[i];
  }
  return sum / n || bars[bars.length - 1].close * 0.02;
}

/**
 * 摆动点 + 强度过滤
 * 强度 = 距离邻居极值的高度 + 相对 ATR + 局部确认
 * 过严会导致 S/R、趋势线、形态全部为空 —— 用双档窗口并放宽突起门槛。
 */
function findSwings(
  bars: KlineBar[],
  kind: 'high' | 'low',
  left: number,
  right: number,
  atr: number
): SwingPoint[] {
  // 主档（更可靠）+ 次档（更密，保证结构引擎有原料）
  const primary = collectSwings(bars, kind, left, right, atr, atr * 0.14, 0);
  const secondary = collectSwings(bars, kind, 2, 2, atr, atr * 0.1, -0.06);
  const merged = mergeSwingsByIndex([...primary, ...secondary], 2);
  for (let i = 0; i < merged.length; i++) {
    merged[i].distanceFromPrev = i === 0 ? -1 : merged[i].index - merged[i - 1].index;
  }
  return merged;
}

function collectSwings(
  bars: KlineBar[],
  kind: 'high' | 'low',
  left: number,
  right: number,
  atr: number,
  minProtrusion: number,
  strengthBias: number
): SwingPoint[] {
  const out: SwingPoint[] = [];
  const absFloor = bars.length ? bars[bars.length - 1].close * 0.0012 : 0;
  const minProt = Math.max(minProtrusion, absFloor);

  for (let i = left; i < bars.length - right; i++) {
    const price = kind === 'high' ? bars[i].high : bars[i].low;
    let isSwing = true;
    let neighborExtreme = kind === 'high' ? -Infinity : Infinity;

    for (let j = i - left; j <= i + right; j++) {
      if (j === i) {
        continue;
      }
      const cmp = kind === 'high' ? bars[j].high : bars[j].low;
      if (kind === 'high') {
        neighborExtreme = Math.max(neighborExtreme, cmp);
        if (cmp >= price) {
          isSwing = false;
          break;
        }
      } else {
        neighborExtreme = Math.min(neighborExtreme, cmp);
        if (cmp <= price) {
          isSwing = false;
          break;
        }
      }
    }
    if (!isSwing) {
      continue;
    }

    const protrusion =
      kind === 'high' ? price - neighborExtreme : neighborExtreme - price;
    if (protrusion < minProt) {
      continue;
    }

    const window = bars.slice(i - left, i + right + 1);
    const spanPrice =
      Math.max(...window.map((b) => b.high)) - Math.min(...window.map((b) => b.low));
    const volFactor = atr > 0 ? Math.min(1.5, spanPrice / atr) : 1;
    const raw =
      (protrusion / Math.max(atr, 1e-9)) * 0.55 + volFactor * 0.25 + 0.25 + strengthBias;
    const strength = Math.min(1, Math.max(0.2, raw));

    out.push({ index: i, price, kind, strength, distanceFromPrev: -1 });
  }
  return out;
}

function mergeSwingsByIndex(points: SwingPoint[], minGap: number): SwingPoint[] {
  const sorted = points.slice().sort((a, b) => a.index - b.index || b.strength - a.strength);
  const filtered: SwingPoint[] = [];
  for (const s of sorted) {
    const conflict = filtered.find((f) => Math.abs(f.index - s.index) <= minGap);
    if (conflict) {
      if (s.strength > conflict.strength) {
        filtered[filtered.indexOf(conflict)] = s;
      }
      continue;
    }
    filtered.push(s);
  }
  return filtered.sort((a, b) => a.index - b.index);
}

function detectSupportResistance(
  bars: KlineBar[],
  highs: SwingPoint[],
  lows: SwingPoint[],
  tols: Tolerances,
  lastClose: number
): SRLevel[] {
  const lastIdx = bars.length - 1;
  const windowStart = Math.max(0, lastIdx - 90);
  const levelTol = tols.levelTol;
  const avgVol = averageVolume(bars, 20);

  // 摆动点 + 次级局部极值（保证至少有价区可画）
  const pivotSeeds = collectMinorPivots(bars, windowStart, tols.atr);
  const recentSwings = [...highs, ...lows, ...pivotSeeds].filter((s) => s.index >= windowStart);
  if (recentSwings.length === 0) {
    return ensureBaselineSr(bars, [], tols, lastClose);
  }

  // 按强度加权的种子
  const seeds = recentSwings
    .slice()
    .sort((a, b) => a.price - b.price)
    .map((s) => ({ price: s.price, strength: s.strength, index: s.index }));

  const clusters: {
    prices: number[];
    strengths: number[];
    indices: number[];
  }[] = [];

  for (const s of seeds) {
    const lastCl = clusters[clusters.length - 1];
    if (lastCl && Math.abs(mean(lastCl.prices) - s.price) <= levelTol) {
      lastCl.prices.push(s.price);
      lastCl.strengths.push(s.strength);
      lastCl.indices.push(s.index);
    } else {
      clusters.push({
        prices: [s.price],
        strengths: [s.strength],
        indices: [s.index],
      });
    }
  }

  const levels: SRLevel[] = [];
  for (const cl of clusters) {
    // 中心：按摆动强度加权均值
    let wSum = 0;
    let pSum = 0;
    for (let i = 0; i < cl.prices.length; i++) {
      const w = 0.5 + cl.strengths[i];
      wSum += w;
      pSum += cl.prices[i] * w;
    }
    const center = pSum / (wSum || 1);
    const lower = Math.min(...cl.prices);
    const upper = Math.max(...cl.prices);
    // 至少有一点区域厚度
    const half = Math.max((upper - lower) / 2, tols.touchTol * 0.8, tols.atr * 0.15);
    const zoneLower = center - half;
    const zoneUpper = center + half;

    let touchCount = 0;
    let recentTouchScore = 0;
    let volumeHits = 0;
    let lastTouch = -1;
    const touchDates: string[] = [];

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const hit =
        (b.low <= zoneUpper && b.high >= zoneLower) ||
        Math.abs(b.close - center) <= levelTol ||
        Math.abs(b.high - center) <= levelTol ||
        Math.abs(b.low - center) <= levelTol;
      if (!hit) {
        continue;
      }
      touchCount++;
      lastTouch = i;
      const age = lastIdx - i;
      recentTouchScore += 1 / (1 + age / 12);
      if (avgVol > 0 && b.volume >= avgVol * 1.5) {
        volumeHits++;
        recentTouchScore += 0.15;
      }
      if (touchDates.length < 4 && age <= 90) {
        touchDates.push(b.date);
      }
    }
    if (touchCount < 2) {
      continue;
    }

    const dist = ((center - lastClose) / lastClose) * 100;
    // 略放宽可见距离：过严时现价附近结构被清空
    if (Math.abs(dist) > 18) {
      continue;
    }

    let type: SRLevel['type'] = 'pivot';
    if (center > lastClose + tols.touchTol * 0.5) {
      type = 'resistance';
    } else if (center < lastClose - tols.touchTol * 0.5) {
      type = 'support';
    }

    const lastTouchAge = lastTouch >= 0 ? lastIdx - lastTouch : 999;
    let ageScore = 0.3;
    let freshness: SrFreshness = 'old';
    if (lastTouchAge <= 30) {
      ageScore = 1;
      freshness = 'recent';
    } else if (lastTouchAge <= 90) {
      ageScore = 0.6;
      freshness = 'mid';
    }

    const proximity = 1 / (1 + Math.abs(dist) / 2.5);
    const volumeBoosted = volumeHits > 0;
    const width = zoneUpper - zoneLower;
    const widthPct = lastClose > 0 ? width / lastClose : 0;
    // 过宽区域降权（> ATR×3）
    let widthFactor = 1;
    if (width > tols.atr * 3) {
      widthFactor = 0.7;
    } else if (width > tols.atr * 2) {
      widthFactor = 0.85;
    } else if (width > 0 && width < tols.atr * 0.4) {
      widthFactor = 1.05;
    }
    const baseStrength = Math.min(
      1,
      (recentTouchScore * 0.1 +
        proximity * 0.32 +
        ageScore * 0.28 +
        Math.min(0.15, cl.prices.length * 0.04) +
        (volumeBoosted ? 0.1 : 0)) *
        widthFactor
    );
    const strength = baseStrength;

    levels.push({
      price: center,
      upper: zoneUpper,
      lower: zoneLower,
      type,
      strength,
      baseStrength,
      touchCount,
      distancePct: dist,
      widthPct,
      ageScore,
      freshness,
      lastTouchAge,
      volumeBoosted,
      touchDates: touchDates.slice(-4).reverse(),
    });
  }

  levels.sort((a, b) => {
    const sa = a.strength * (0.5 + a.ageScore * 0.5) * (1 / (1 + Math.abs(a.distancePct) * 0.7));
    const sb = b.strength * (0.5 + b.ageScore * 0.5) * (1 / (1 + Math.abs(b.distancePct) * 0.7));
    return sb - sa;
  });

  const filtered: SRLevel[] = [];
  for (const lv of levels) {
    if (filtered.some((f) => Math.abs(f.price - lv.price) <= levelTol * 1.1)) {
      continue;
    }
    // 弱历史水平降权重已体现在 sort；过弱不入榜
    if (lv.strength < 0.22 && lv.freshness === 'old') {
      continue;
    }
    filtered.push(lv);
    if (filtered.length >= MAX_SR_LEVELS) {
      break;
    }
  }
  return ensureBaselineSr(bars, filtered, tols, lastClose);
}

/** 次级局部极值：左右 1 根，作 S/R 种子补充 */
function collectMinorPivots(bars: KlineBar[], windowStart: number, atr: number): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = Math.max(1, windowStart); i < bars.length - 1; i++) {
    const hi = bars[i].high;
    const lo = bars[i].low;
    if (hi >= bars[i - 1].high && hi >= bars[i + 1].high) {
      out.push({
        index: i,
        price: hi,
        kind: 'high',
        strength: 0.32,
        distanceFromPrev: -1,
      });
    }
    if (lo <= bars[i - 1].low && lo <= bars[i + 1].low) {
      out.push({
        index: i,
        price: lo,
        kind: 'low',
        strength: 0.32,
        distanceFromPrev: -1,
      });
    }
  }
  // 过密压缩
  return mergeSwingsByIndex(out, 1).filter((s) => {
    // 极微噪声丢弃
    if (atr <= 0) {
      return true;
    }
    return true;
  });
}

/**
 * 若聚类仍为空：用近窗高低点兜底（保证图表有可画结构线）
 */
function ensureBaselineSr(
  bars: KlineBar[],
  levels: SRLevel[],
  tols: Tolerances,
  lastClose: number
): SRLevel[] {
  if (levels.length >= 1) {
    return levels;
  }
  const lastIdx = bars.length - 1;
  const windows = [20, 40, 60];
  const out: SRLevel[] = [];
  for (const w of windows) {
    const from = Math.max(0, lastIdx - w + 1);
    let hi = -Infinity;
    let lo = Infinity;
    let hiI = from;
    let loI = from;
    for (let i = from; i <= lastIdx; i++) {
      if (bars[i].high > hi) {
        hi = bars[i].high;
        hiI = i;
      }
      if (bars[i].low < lo) {
        lo = bars[i].low;
        loI = i;
      }
    }
    const half = Math.max(tols.touchTol * 0.8, tols.atr * 0.12);
    const mk = (
      price: number,
      type: SRLevel['type'],
      idx: number,
      strength: number
    ): SRLevel => ({
      price,
      upper: price + half,
      lower: price - half,
      type,
      strength,
      baseStrength: strength,
      touchCount: 2,
      distancePct: ((price - lastClose) / lastClose) * 100,
      widthPct: (half * 2) / lastClose,
      ageScore: lastIdx - idx <= 30 ? 1 : 0.6,
      freshness: lastIdx - idx <= 30 ? 'recent' : 'mid',
      lastTouchAge: lastIdx - idx,
      volumeBoosted: false,
      touchDates: [bars[idx]?.date].filter(Boolean) as string[],
    });
    if (hi > lastClose && Math.abs(hi - lastClose) / lastClose <= 0.18) {
      out.push(mk(hi, 'resistance', hiI, w <= 20 ? 0.55 : 0.42));
    }
    if (lo < lastClose && Math.abs(lo - lastClose) / lastClose <= 0.18) {
      out.push(mk(lo, 'support', loI, w <= 20 ? 0.55 : 0.42));
    }
  }
  // 去重
  const uniq: SRLevel[] = [];
  for (const lv of out.sort((a, b) => b.strength - a.strength)) {
    if (uniq.some((f) => Math.abs(f.price - lv.price) <= tols.levelTol)) {
      continue;
    }
    uniq.push(lv);
    if (uniq.length >= MAX_SR_LEVELS) {
      break;
    }
  }
  return uniq;
}

function detectTrendLines(
  bars: KlineBar[],
  highs: SwingPoint[],
  lows: SwingPoint[],
  tols: Tolerances,
  lastClose: number
): TrendLineResult[] {
  const support = pickBestTrendLine(bars, lows, 'support', tols, lastClose);
  const resistance = pickBestTrendLine(bars, highs, 'resistance', tols, lastClose);

  const combined = [support, resistance]
    .filter((t): t is TrendLineResult => t !== null)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MAX_TRENDLINES);

  for (const tl of combined) {
    markTrendBreak(bars, tl, tols.breakTol);
  }
  return combined;
}

/**
 * 优先 RANSAC 抗异常点；失败时回退到两点枚举 + 多点确认。
 */
function pickBestTrendLine(
  bars: KlineBar[],
  swings: SwingPoint[],
  type: 'support' | 'resistance',
  tols: Tolerances,
  lastClose: number
): TrendLineResult | null {
  const lastIdx = bars.length - 1;
  const minIdx = Math.max(0, lastIdx - TREND_LOOKBACK);
  const pool = swings.filter((s) => s.index >= minIdx && s.strength >= 0.28);
  if (pool.length < 2) {
    return null;
  }

  const ransac = ransacTrendLine(bars, pool, type, tols, lastClose);
  if (ransac) {
    return ransac;
  }
  return enumerateTrendLine(bars, pool, type, tols, lastClose);
}

function ransacTrendLine(
  bars: KlineBar[],
  pool: SwingPoint[],
  type: 'support' | 'resistance',
  tols: Tolerances,
  lastClose: number
): TrendLineResult | null {
  if (pool.length < 3) {
    return null;
  }
  const lastIdx = bars.length - 1;
  const touchTol = tols.touchTol;
  const n = pool.length;
  // 确定性子采样：所有跨度合格的点对，最多 60 组（按强度优先）
  const pairs: [SwingPoint, SwingPoint][] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = pool[i];
      const b = pool[j];
      const span = b.index - a.index;
      if (span < 6 || span > 55) {
        continue;
      }
      if (lastIdx - b.index > TREND_END_MAX_AGE) {
        continue;
      }
      pairs.push([a, b]);
    }
  }
  pairs.sort((p, q) => {
    const sp = p[0].strength + p[1].strength;
    const sq = q[0].strength + q[1].strength;
    return sq - sp;
  });
  const samples = pairs.slice(0, 60);

  let best: TrendLineResult | null = null;
  let bestInliers = 0;

  for (const [a, b] of samples) {
    const span = b.index - a.index;
    const slope = (b.price - a.price) / span;
    if (!isSlopeOk(type, slope, tols.atr)) {
      continue;
    }
    const lineAt = (idx: number) => a.price + slope * (idx - a.index);

    // inliers：整段 pool 中相对线的贴合点（可延伸到 b 之后未严重穿破的点）
    const inliers: SwingPoint[] = [];
    let violations = 0;
    for (const s of pool) {
      if (s.index < a.index) {
        continue;
      }
      const expected = lineAt(s.index);
      const dist = s.price - expected;
      if (Math.abs(dist) <= touchTol) {
        inliers.push(s);
      } else if (type === 'support' && dist < -touchTol * 1.2) {
        if (s.index <= b.index) {
          violations++;
        }
      } else if (type === 'resistance' && dist > touchTol * 1.2) {
        if (s.index <= b.index) {
          violations++;
        }
      }
    }
    if (inliers.length < 2 || violations > 0) {
      continue;
    }

    // 用 inliers 最小二乘精炼
    const xs = inliers.map((s) => s.index);
    const ys = inliers.map((s) => s.price);
    const fit = linearFit(xs, ys);
    if (!fit) {
      continue;
    }
    if (!isSlopeOk(type, fit.slope, tols.atr)) {
      continue;
    }

    // 精炼后重算 inliers
    const refined: SwingPoint[] = [];
    for (const s of pool) {
      if (s.index < Math.min(...xs)) {
        continue;
      }
      const expected = fit.y(s.index);
      const dist = s.price - expected;
      if (Math.abs(dist) <= touchTol) {
        refined.push(s);
      } else if (type === 'support' && s.index <= Math.max(...xs) && dist < -touchTol) {
        violations++;
      } else if (type === 'resistance' && s.index <= Math.max(...xs) && dist > touchTol) {
        violations++;
      }
    }
    if (violations > 0 || refined.length < 2) {
      continue;
    }

    refined.sort((u, v) => u.index - v.index);
    const r0 = refined[0];
    const r1 = refined[refined.length - 1];
    if (lastIdx - r1.index > TREND_END_MAX_AGE) {
      continue;
    }

    const scored = scoreTrendCandidate(
      bars,
      type,
      r0.index,
      r1.index,
      fit.y(r0.index),
      fit.y(r1.index),
      refined.length,
      tols,
      lastClose,
      pool
    );
    if (!scored) {
      continue;
    }

    // 优先 inlier 多 + 强度
    if (
      refined.length > bestInliers ||
      (refined.length === bestInliers && (!best || scored.strength > best.strength))
    ) {
      bestInliers = refined.length;
      best = scored;
    }
  }

  // RANSAC 至少要 3 个内点才值得采用（抗噪）
  if (best && bestInliers >= 3) {
    return best;
  }
  return best;
}

function enumerateTrendLine(
  bars: KlineBar[],
  pool: SwingPoint[],
  type: 'support' | 'resistance',
  tols: Tolerances,
  lastClose: number
): TrendLineResult | null {
  const lastIdx = bars.length - 1;
  const candidates: TrendLineResult[] = [];

  for (let i = 0; i < pool.length - 1; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i];
      const b = pool[j];
      const span = b.index - a.index;
      if (span < 6 || span > 55) {
        continue;
      }
      if (lastIdx - b.index > TREND_END_MAX_AGE) {
        continue;
      }
      const slope = (b.price - a.price) / span;
      if (!isSlopeOk(type, slope, tols.atr)) {
        continue;
      }

      // 粗触点计数
      let touches = 0;
      let swingViolations = 0;
      const lineAt = (idx: number) => a.price + slope * (idx - a.index);
      for (const s of pool) {
        if (s.index < a.index || s.index > b.index) {
          continue;
        }
        const dist = s.price - lineAt(s.index);
        if (Math.abs(dist) <= tols.touchTol) {
          touches++;
        } else if (type === 'support' && dist < -tols.touchTol) {
          swingViolations++;
        } else if (type === 'resistance' && dist > tols.touchTol) {
          swingViolations++;
        }
      }
      if (touches < 2 || swingViolations > 0) {
        continue;
      }

      const scored = scoreTrendCandidate(
        bars,
        type,
        a.index,
        b.index,
        a.price,
        b.price,
        touches,
        tols,
        lastClose,
        pool
      );
      if (scored) {
        candidates.push(scored);
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((x, y) => {
    const ageX = lastIdx - x.endIndex;
    const ageY = lastIdx - y.endIndex;
    if (ageX !== ageY) {
      return ageX - ageY;
    }
    if (y.touches !== x.touches) {
      return y.touches - x.touches;
    }
    return y.strength - x.strength;
  });
  return candidates[0];
}

function isSlopeOk(type: 'support' | 'resistance', slope: number, atr: number): boolean {
  if (Math.abs(slope) > atr * 0.55) {
    return false;
  }
  if (type === 'support' && slope < -atr * 0.35) {
    return false;
  }
  if (type === 'resistance' && slope > atr * 0.35) {
    return false;
  }
  return true;
}

function scoreTrendCandidate(
  bars: KlineBar[],
  type: 'support' | 'resistance',
  startIndex: number,
  endIndex: number,
  startPrice: number,
  endPrice: number,
  touches: number,
  tols: Tolerances,
  lastClose: number,
  pool: SwingPoint[]
): TrendLineResult | null {
  const lastIdx = bars.length - 1;
  const span = Math.max(1, endIndex - startIndex);
  const slope = (endPrice - startPrice) / span;
  if (!isSlopeOk(type, slope, tols.atr)) {
    return null;
  }
  const lineAt = (idx: number) => startPrice + slope * (idx - startIndex);
  const touchTol = tols.touchTol;

  let residualSum = 0;
  let residualN = 0;
  for (const s of pool) {
    if (s.index < startIndex || s.index > endIndex) {
      continue;
    }
    residualSum += Math.abs(s.price - lineAt(s.index));
    residualN++;
  }

  let hardPen = 0;
  let softPenBars = 0;
  for (let k = startIndex; k <= lastIdx; k++) {
    const expected = lineAt(k);
    if (type === 'support') {
      if (expected - bars[k].low > touchTol * 1.8) {
        softPenBars++;
      }
      if (bars[k].close < expected - tols.breakTol * 0.6) {
        hardPen++;
      }
    } else {
      if (bars[k].high - expected > touchTol * 1.8) {
        softPenBars++;
      }
      if (bars[k].close > expected + tols.breakTol * 0.6) {
        hardPen++;
      }
    }
  }
  if (hardPen > Math.max(1, Math.floor(span * 0.08))) {
    return null;
  }
  if (softPenBars > Math.max(3, Math.floor((lastIdx - startIndex) * 0.28))) {
    return null;
  }

  const lineNow = lineAt(lastIdx);
  if (type === 'support') {
    if (lineNow > lastClose + touchTol * 2.5) {
      return null;
    }
    if (lineNow < lastClose - lastClose * 0.16) {
      return null;
    }
  } else {
    if (lineNow < lastClose - touchTol * 2.5) {
      return null;
    }
    if (lineNow > lastClose + lastClose * 0.16) {
      return null;
    }
  }

  const avgResidual = residualN > 0 ? residualSum / residualN : tols.atr;
  const fitScore = 1 / (1 + avgResidual / (touchTol + 1e-9));
  const recencyScore = 1 - (lastIdx - endIndex) / (TREND_END_MAX_AGE + 1);
  const touchScore = Math.min(1, touches / 4);
  // 时间覆盖：覆盖 lookback 的比例（抗「短漂亮线」）
  const coverage = Math.min(1, span / TREND_LOOKBACK);
  // 0.35 fit + 0.25 touch + 0.20 recency + 0.20 coverage（规范化后）
  const baseStrength = Math.min(
    1,
    fitScore * 0.35 +
      touchScore * 0.25 +
      recencyScore * 0.2 +
      coverage * 0.2 +
      (touches >= 3 ? 0.05 : 0)
  );
  const strength = baseStrength;

  if (fitScore < 0.38 || baseStrength < 0.36) {
    return null;
  }
  // coverage 过短且只有两点 → 不要
  if (coverage < 0.12 && touches < 2) {
    return null;
  }

  return {
    type,
    startIndex,
    endIndex,
    startPrice,
    endPrice,
    touches,
    broken: false,
    strength,
    baseStrength,
    coverage,
  };
}

function markTrendBreak(bars: KlineBar[], tl: TrendLineResult, breakTol: number): void {
  const slope = (tl.endPrice - tl.startPrice) / Math.max(1, tl.endIndex - tl.startIndex);
  const lineAt = (i: number) => tl.startPrice + slope * (i - tl.startIndex);

  for (let i = tl.endIndex + 1; i < bars.length; i++) {
    const line = lineAt(i);
    const broke =
      tl.type === 'support'
        ? bars[i].close < line - breakTol
        : bars[i].close > line + breakTol;
    if (!broke) {
      continue;
    }
    const ni = Math.min(i + 1, bars.length - 1);
    const confirm =
      i + 1 >= bars.length ||
      (tl.type === 'support' ? bars[ni].close < lineAt(ni) : bars[ni].close > lineAt(ni));
    if (confirm) {
      tl.broken = true;
      tl.breakIndex = i;
      break;
    }
  }
}

function withScore(
  p: Omit<ChartPatternResult, 'score' | 'baseScore' | 'confidence'> & {
    score?: number;
    baseScore?: number;
    confidence?: number;
  }
): ChartPatternResult {
  const baseScore = p.baseScore ?? p.score ?? p.confidence ?? 50;
  const score = p.score ?? baseScore;
  return { ...p, baseScore, score, confidence: score };
}

function detectChartPatterns(
  bars: KlineBar[],
  highs: SwingPoint[],
  lows: SwingPoint[],
  tols: Tolerances,
  lastClose: number
): ChartPatternResult[] {
  const patterns: ChartPatternResult[] = [];
  const lastIdx = bars.length - 1;
  const tol = tols.levelTol;
  const atr = tols.atr;
  const breakTol = tols.breakTol;

  const dt = detectDoubleTop(bars, highs, lows, tol, breakTol, lastClose);
  if (dt) {
    patterns.push(dt);
  }
  const db = detectDoubleBottom(bars, highs, lows, tol, breakTol, lastClose);
  if (db) {
    patterns.push(db);
  }
  const hs = detectHeadAndShoulders(bars, highs, lows, tol, breakTol, lastClose);
  if (hs) {
    patterns.push(hs);
  }
  const ihs = detectInverseHeadAndShoulders(bars, highs, lows, tol, breakTol, lastClose);
  if (ihs) {
    patterns.push(ihs);
  }
  const tri = detectTriangle(bars, highs, lows, tol, atr, breakTol, lastClose);
  if (tri) {
    patterns.push(tri);
  }
  const rect = detectRectangle(bars, highs, lows, tol, atr, breakTol, lastClose);
  if (rect) {
    patterns.push(rect);
  }
  const flag = detectFlag(bars, highs, lows, tol, atr);
  if (flag) {
    patterns.push(flag);
  }

  const recent = patterns.filter((p) => lastIdx - p.endIndex <= PATTERN_MAX_AGE);
  recent.sort((a, b) => {
    // confirmed 优先
    const st = statusRank(b.status) - statusRank(a.status);
    if (st !== 0) {
      return st;
    }
    const ageA = lastIdx - a.endIndex;
    const ageB = lastIdx - b.endIndex;
    if (ageA !== ageB) {
      return ageA - ageB;
    }
    return b.score - a.score;
  });
  return recent.slice(0, MAX_PATTERNS);
}

function statusRank(s: PatternStatus): number {
  if (s === 'confirmed') {
    return 4;
  }
  if (s === 'forming') {
    return 3;
  }
  if (s === 'failed') {
    return 2;
  }
  return 1; // invalidated
}

function detectDoubleTop(
  bars: KlineBar[],
  highs: SwingPoint[],
  lows: SwingPoint[],
  tol: number,
  breakTol: number,
  lastClose: number
): ChartPatternResult | null {
  if (highs.length < 2) {
    return null;
  }
  const lastIdx = bars.length - 1;
  const recent = highs.filter((h) => lastIdx - h.index <= 70 && h.strength >= 0.35).slice(-8);
  for (let i = recent.length - 1; i >= 1; i--) {
    for (let j = i - 1; j >= 0; j--) {
      const h2 = recent[i];
      const h1 = recent[j];
      if (lastIdx - h2.index > PATTERN_MAX_AGE) {
        continue;
      }
      const sep = h2.index - h1.index;
      if (sep < PATTERN_SEP_MIN || sep > PATTERN_SEP_MAX) {
        continue;
      }
      if (Math.abs(h1.price - h2.price) > tol * 1.1) {
        continue;
      }
      const valley = lows
        .filter((l) => l.index > h1.index && l.index < h2.index)
        .sort((a, b) => a.price - b.price)[0];
      if (!valley) {
        continue;
      }
      const peak = Math.max(h1.price, h2.price);
      const depth = peak - valley.price;
      if (depth < tol * 1.5) {
        continue;
      }

      const neckline = valley.price;
      // confirmed: 跌破颈线；failed: 已破颈后又收回；invalidated: 重回两顶之上
      const broken = lastClose < neckline - breakTol * 0.5;
      const everBroken = bars.slice(h2.index).some((b) => b.close < neckline - breakTol * 0.5);
      const invalidated = lastClose > peak + breakTol * 0.3;
      const failed = everBroken && !broken && !invalidated && lastClose > neckline - breakTol * 0.2;
      const approaching = lastClose < peak - depth * 0.35;
      if (!invalidated && !failed && !broken && !approaching) {
        continue;
      }
      if ((invalidated || failed) && lastIdx - h2.index > 25) {
        continue;
      }

      const status: PatternStatus = invalidated
        ? 'invalidated'
        : failed
          ? 'failed'
          : broken
            ? 'confirmed'
            : 'forming';
      const conf = Math.min(
        92,
        52 +
          (1 - Math.abs(h1.price - h2.price) / (tol * 2)) * 15 +
          (depth / peak) * 100 * 0.7 +
          (broken ? 14 : 0) +
          (failed ? -12 : 0) +
          (invalidated ? -22 : 0) +
          ((h1.strength + h2.strength) / 2) * 8 +
          Math.max(0, 6 - (lastIdx - h2.index) * 0.2)
      );

      return withScore({
        id: 'double-top',
        name: '双顶',
        bias: 'bearish',
        confidence: Math.max(20, Math.round(conf)),
        baseScore: Math.max(20, Math.round(conf)),
        status,
        startIndex: h1.index,
        endIndex: h2.index,
        keyPoints: [
          { index: h1.index, price: h1.price, label: '顶1' },
          { index: valley.index, price: valley.price, label: '颈线' },
          { index: h2.index, price: h2.price, label: '顶2' },
        ],
        description: invalidated
          ? `双顶作废：价格重回两顶上方 ${fmt(peak)}`
          : failed
            ? `双顶短期失败：曾破颈线但收回 ${fmt(neckline)} 上方`
            : broken
              ? `双顶已确认跌破颈线 ${fmt(neckline)}，测量目标约 ${fmt(neckline - depth)}`
              : `双顶构筑中，两高点约 ${fmt(peak)}，颈线 ${fmt(neckline)}`,
        targetPrice: neckline - depth,
        neckline,
      });
    }
  }
  return null;
}

function detectDoubleBottom(
  bars: KlineBar[],
  highs: SwingPoint[],
  lows: SwingPoint[],
  tol: number,
  breakTol: number,
  lastClose: number
): ChartPatternResult | null {
  if (lows.length < 2) {
    return null;
  }
  const lastIdx = bars.length - 1;
  const recent = lows.filter((l) => lastIdx - l.index <= 70 && l.strength >= 0.35).slice(-8);
  for (let i = recent.length - 1; i >= 1; i--) {
    for (let j = i - 1; j >= 0; j--) {
      const l2 = recent[i];
      const l1 = recent[j];
      if (lastIdx - l2.index > PATTERN_MAX_AGE) {
        continue;
      }
      const sep = l2.index - l1.index;
      if (sep < PATTERN_SEP_MIN || sep > PATTERN_SEP_MAX) {
        continue;
      }
      if (Math.abs(l1.price - l2.price) > tol * 1.1) {
        continue;
      }
      const peak = highs
        .filter((h) => h.index > l1.index && h.index < l2.index)
        .sort((a, b) => b.price - a.price)[0];
      if (!peak) {
        continue;
      }
      const bottom = Math.min(l1.price, l2.price);
      const height = peak.price - bottom;
      if (height < tol * 1.5) {
        continue;
      }

      const neckline = peak.price;
      const broken = lastClose > neckline + breakTol * 0.5;
      const everBroken = bars.slice(l2.index).some((b) => b.close > neckline + breakTol * 0.5);
      const invalidated = lastClose < bottom - breakTol * 0.3;
      const failed = everBroken && !broken && !invalidated && lastClose < neckline + breakTol * 0.2;
      const approaching = lastClose > bottom + height * 0.4;
      if (!invalidated && !failed && !broken && !approaching) {
        continue;
      }
      if ((invalidated || failed) && lastIdx - l2.index > 25) {
        continue;
      }

      const status: PatternStatus = invalidated
        ? 'invalidated'
        : failed
          ? 'failed'
          : broken
            ? 'confirmed'
            : 'forming';
      const conf = Math.min(
        92,
        52 +
          (1 - Math.abs(l1.price - l2.price) / (tol * 2)) * 15 +
          (height / neckline) * 100 * 0.7 +
          (broken ? 14 : 0) +
          (failed ? -12 : 0) +
          (invalidated ? -22 : 0) +
          ((l1.strength + l2.strength) / 2) * 8
      );

      return withScore({
        id: 'double-bottom',
        name: '双底',
        bias: 'bullish',
        confidence: Math.max(20, Math.round(conf)),
        baseScore: Math.max(20, Math.round(conf)),
        status,
        startIndex: l1.index,
        endIndex: l2.index,
        keyPoints: [
          { index: l1.index, price: l1.price, label: '底1' },
          { index: peak.index, price: peak.price, label: '颈线' },
          { index: l2.index, price: l2.price, label: '底2' },
        ],
        description: invalidated
          ? `双底作废：价格跌破第二底 ${fmt(bottom)}`
          : failed
            ? `双底短期失败：曾破颈线但回落 ${fmt(neckline)} 下方`
            : broken
              ? `双底已确认突破颈线 ${fmt(neckline)}，测量目标约 ${fmt(neckline + height)}`
              : `双底构筑中，两低点约 ${fmt(bottom)}，颈线 ${fmt(neckline)}`,
        targetPrice: neckline + height,
        neckline,
      });
    }
  }
  return null;
}

function detectHeadAndShoulders(
  bars: KlineBar[],
  highs: SwingPoint[],
  lows: SwingPoint[],
  tol: number,
  breakTol: number,
  lastClose: number
): ChartPatternResult | null {
  if (highs.length < 3) {
    return null;
  }
  const hs = highs.filter((h) => h.strength >= 0.35).slice(-8);
  for (let i = 0; i < hs.length - 2; i++) {
    const ls = hs[i];
    const head = hs[i + 1];
    const rs = hs[i + 2];
    if (head.index - ls.index < 3 || rs.index - head.index < 3) {
      continue;
    }
    if (head.price <= ls.price + tol * 0.5 || head.price <= rs.price + tol * 0.5) {
      continue;
    }
    if (Math.abs(ls.price - rs.price) > tol * 1.8) {
      continue;
    }
    if (head.price - Math.max(ls.price, rs.price) < tol * 0.8) {
      continue;
    }

    const leftValley = lows
      .filter((l) => l.index > ls.index && l.index < head.index)
      .sort((a, b) => a.price - b.price)[0];
    const rightValley = lows
      .filter((l) => l.index > head.index && l.index < rs.index)
      .sort((a, b) => a.price - b.price)[0];
    if (!leftValley || !rightValley) {
      continue;
    }

    const neckline = (leftValley.price + rightValley.price) / 2;
    const height = head.price - neckline;
    if (height < tol * 2) {
      continue;
    }

    const broken = lastClose < neckline - breakTol * 0.5;
    // 收盘重回右肩以上：结构作废
    const invalidated = lastClose > rs.price + breakTol * 0.3;
    let everBroken = broken;
    for (let k = rs.index; k < bars.length; k++) {
      if (bars[k].close < neckline - breakTol * 0.5) {
        everBroken = true;
        break;
      }
    }
    const failed = everBroken && !broken && !invalidated && lastClose > neckline - breakTol * 0.2;
    const approaching = lastClose < Math.min(ls.price, rs.price) - height * 0.15;
    if (!invalidated && !failed && !broken && !approaching) {
      continue;
    }
    if ((invalidated || failed) && bars.length - 1 - rs.index > 25) {
      continue;
    }
    const status: PatternStatus = invalidated
      ? 'invalidated'
      : failed
        ? 'failed'
        : broken
          ? 'confirmed'
          : 'forming';
    const conf =
      Math.min(90, 55 + (height / head.price) * 180 + (broken ? 15 : 5)) +
      (invalidated ? -22 : 0) +
      (failed ? -12 : 0);

    return withScore({
      id: 'head-shoulders',
      name: '头肩顶',
      bias: 'bearish',
      confidence: Math.max(20, Math.round(conf)),
      status,
      startIndex: ls.index,
      endIndex: rs.index,
      keyPoints: [
        { index: ls.index, price: ls.price, label: '左肩' },
        { index: head.index, price: head.price, label: '头' },
        { index: rs.index, price: rs.price, label: '右肩' },
        { index: leftValley.index, price: leftValley.price, label: '颈线' },
        { index: rightValley.index, price: rightValley.price, label: '颈线' },
      ],
      description: invalidated
        ? `头肩顶结构失效（重回右肩上方）`
        : failed
          ? `头肩顶突破后收回，短期失败`
          : broken
            ? `头肩顶确认跌破颈线 ${fmt(neckline)}，目标约 ${fmt(neckline - height)}`
            : `头肩顶构筑中，颈部约 ${fmt(neckline)}`,
      targetPrice: neckline - height,
      neckline,
    });
  }
  return null;
}

function detectInverseHeadAndShoulders(
  bars: KlineBar[],
  highs: SwingPoint[],
  lows: SwingPoint[],
  tol: number,
  breakTol: number,
  lastClose: number
): ChartPatternResult | null {
  if (lows.length < 3) {
    return null;
  }
  const ls = lows.filter((l) => l.strength >= 0.35).slice(-8);
  for (let i = 0; i < ls.length - 2; i++) {
    const left = ls[i];
    const head = ls[i + 1];
    const right = ls[i + 2];
    if (head.index - left.index < 3 || right.index - head.index < 3) {
      continue;
    }
    if (head.price >= left.price - tol * 0.5 || head.price >= right.price - tol * 0.5) {
      continue;
    }
    if (Math.abs(left.price - right.price) > tol * 1.8) {
      continue;
    }
    if (Math.min(left.price, right.price) - head.price < tol * 0.8) {
      continue;
    }

    const leftPeak = highs
      .filter((h) => h.index > left.index && h.index < head.index)
      .sort((a, b) => b.price - a.price)[0];
    const rightPeak = highs
      .filter((h) => h.index > head.index && h.index < right.index)
      .sort((a, b) => b.price - a.price)[0];
    if (!leftPeak || !rightPeak) {
      continue;
    }

    const neckline = (leftPeak.price + rightPeak.price) / 2;
    const height = neckline - head.price;
    if (height < tol * 2) {
      continue;
    }

    const broken = lastClose > neckline + breakTol * 0.5;
    const invalidated = lastClose < right.price - breakTol * 0.3;
    let everBroken = broken;
    for (let k = right.index; k < bars.length; k++) {
      if (bars[k].close > neckline + breakTol * 0.5) {
        everBroken = true;
        break;
      }
    }
    const failed = everBroken && !broken && !invalidated && lastClose < neckline + breakTol * 0.2;
    const approaching = lastClose > Math.max(left.price, right.price) + height * 0.15;
    if (!invalidated && !failed && !broken && !approaching) {
      continue;
    }
    if ((invalidated || failed) && bars.length - 1 - right.index > 25) {
      continue;
    }
    const status: PatternStatus = invalidated
      ? 'invalidated'
      : failed
        ? 'failed'
        : broken
          ? 'confirmed'
          : 'forming';
    const conf =
      Math.min(90, 55 + (height / neckline) * 180 + (broken ? 15 : 5)) +
      (invalidated ? -22 : 0) +
      (failed ? -12 : 0);

    return withScore({
      id: 'inv-head-shoulders',
      name: '头肩底',
      bias: 'bullish',
      confidence: Math.max(20, Math.round(conf)),
      status,
      startIndex: left.index,
      endIndex: right.index,
      keyPoints: [
        { index: left.index, price: left.price, label: '左肩' },
        { index: head.index, price: head.price, label: '头' },
        { index: right.index, price: right.price, label: '右肩' },
        { index: leftPeak.index, price: leftPeak.price, label: '颈线' },
        { index: rightPeak.index, price: rightPeak.price, label: '颈线' },
      ],
      description: invalidated
        ? `头肩底结构失效（跌破右肩）`
        : failed
          ? `头肩底突破后跌回，短期失败`
          : broken
            ? `头肩底确认突破颈线 ${fmt(neckline)}，目标约 ${fmt(neckline + height)}`
            : `头肩底构筑中，颈部约 ${fmt(neckline)}`,
      targetPrice: neckline + height,
      neckline,
    });
  }
  return null;
}

function detectTriangle(
  bars: KlineBar[],
  highs: SwingPoint[],
  lows: SwingPoint[],
  tol: number,
  atr: number,
  breakTol: number,
  lastClose: number
): ChartPatternResult | null {
  const window = Math.min(50, bars.length);
  const start = bars.length - window;
  const recentHighs = highs.filter((h) => h.index >= start && h.strength >= 0.3).slice(-5);
  const recentLows = lows.filter((l) => l.index >= start && l.strength >= 0.3).slice(-5);
  if (recentHighs.length < 2 || recentLows.length < 2) {
    return null;
  }

  const hiFit = linearFit(
    recentHighs.map((h) => h.index),
    recentHighs.map((h) => h.price)
  );
  const loFit = linearFit(
    recentLows.map((l) => l.index),
    recentLows.map((l) => l.price)
  );
  if (!hiFit || !loFit) {
    return null;
  }

  const endIdx = bars.length - 1;
  const mid = start + Math.floor(window / 2);
  const widthEarly = hiFit.y(mid) - loFit.y(mid);
  const widthLate = hiFit.y(endIdx) - loFit.y(endIdx);
  if (widthEarly < atr * 2 || widthLate >= widthEarly * 0.85 || widthLate < 0) {
    return null;
  }

  const hiSlope = hiFit.slope;
  const loSlope = loFit.slope;
  let name = '对称三角';
  let bias: PatternBias = 'neutral';
  let id = 'triangle-sym';

  if (Math.abs(hiSlope) < atr * 0.02 && loSlope > atr * 0.015) {
    name = '上升三角';
    bias = 'bullish';
    id = 'triangle-asc';
  } else if (Math.abs(loSlope) < atr * 0.02 && hiSlope < -atr * 0.015) {
    name = '下降三角';
    bias = 'bearish';
    id = 'triangle-desc';
  } else if (hiSlope < -atr * 0.01 && loSlope > atr * 0.01) {
    name = '对称三角';
  } else {
    return null;
  }

  const startIdx = Math.min(recentHighs[0].index, recentLows[0].index);
  const span = endIdx - startIdx;
  // 统一时间结构：过短噪声、过长失效
  if (span < 12 || span > 55) {
    return null;
  }

  const resistance = hiFit.y(endIdx);
  const support = loFit.y(endIdx);
  const height = widthEarly;
  // 几何分：收敛度 + 时间适中
  const shrink = (widthEarly - widthLate) / widthEarly;
  let conf = Math.min(82, 48 + shrink * 38 + Math.min(6, span / 10));
  let description = `${name}收敛中，上沿 ${fmt(resistance)} / 下沿 ${fmt(support)}`;
  let targetPrice: number | undefined;
  let status: PatternStatus = 'forming';

  const brokeUp = lastClose > resistance + breakTol * 0.4;
  const brokeDown = lastClose < support - breakTol * 0.4;
  // 破后收回入内 → failed；反向穿越对侧 → invalidated
  const midBand = (resistance + support) / 2;
  if (brokeUp) {
    conf = Math.min(88, conf + 8);
    bias = 'bullish';
    status = 'confirmed';
    targetPrice = lastClose + height * 0.7;
    description = `${name}向上确认突破，目标约 ${fmt(targetPrice)}`;
  } else if (brokeDown) {
    conf = Math.min(88, conf + 8);
    bias = 'bearish';
    status = 'confirmed';
    targetPrice = lastClose - height * 0.7;
    description = `${name}向下确认跌破，目标约 ${fmt(targetPrice)}`;
  } else {
    // 在区间外又回到中带附近 → 短期失败信号（若曾穿出）
    const everUp = bars.slice(startIdx).some((b) => b.close > resistance + breakTol * 0.4);
    const everDown = bars.slice(startIdx).some((b) => b.close < support - breakTol * 0.4);
    if ((everUp || everDown) && lastClose < resistance - breakTol * 0.2 && lastClose > support + breakTol * 0.2) {
      status = 'failed';
      conf -= 10;
      description = `${name}突破后收回区间，短期失败`;
    } else if (everUp && lastClose < support - breakTol * 0.5) {
      status = 'invalidated';
      conf -= 18;
      description = `${name}上破后反向破下，结构失效`;
    } else if (everDown && lastClose > resistance + breakTol * 0.5) {
      status = 'invalidated';
      conf -= 18;
      description = `${name}下破后反向上破，结构失效`;
    }
  }
  void midBand;

  const hi0 = recentHighs[0];
  const hi1 = recentHighs[recentHighs.length - 1];
  const lo0 = recentLows[0];
  const lo1 = recentLows[recentLows.length - 1];
  return withScore({
    id,
    name,
    bias,
    confidence: Math.max(20, Math.round(conf)),
    status,
    startIndex: startIdx,
    endIndex: endIdx,
    keyPoints: [
      { index: hi0.index, price: hi0.price },
      { index: hi1.index, price: hi1.price },
      { index: lo0.index, price: lo0.price },
      { index: lo1.index, price: lo1.price },
    ],
    description,
    targetPrice,
  });
}

function detectRectangle(
  bars: KlineBar[],
  highs: SwingPoint[],
  lows: SwingPoint[],
  tol: number,
  atr: number,
  breakTol: number,
  lastClose: number
): ChartPatternResult | null {
  const window = Math.min(40, bars.length);
  const start = bars.length - window;
  const rh = highs.filter((h) => h.index >= start);
  const rl = lows.filter((l) => l.index >= start);
  if (rh.length < 2 || rl.length < 2) {
    return null;
  }

  const avgHigh = mean(rh.map((h) => h.price));
  const avgLow = mean(rl.map((l) => l.price));
  const highVar = Math.max(...rh.map((h) => Math.abs(h.price - avgHigh)));
  const lowVar = Math.max(...rl.map((l) => Math.abs(l.price - avgLow)));
  if (highVar > tol * 1.2 || lowVar > tol * 1.2) {
    return null;
  }
  const height = avgHigh - avgLow;
  if (height < atr * 1.5 || height > atr * 8) {
    return null;
  }

  const brokenUp = lastClose > avgHigh + breakTol * 0.4;
  const brokenDown = lastClose < avgLow - breakTol * 0.4;
  const everUp = bars.slice(start).some((b) => b.close > avgHigh + breakTol * 0.4);
  const everDown = bars.slice(start).some((b) => b.close < avgLow - breakTol * 0.4);
  let conf = 55 + Math.min(18, (rh.length + rl.length) * 2.5);
  // 时间跨度适中
  const boxSpan = bars.length - 1 - start;
  if (boxSpan < 10 || boxSpan > 48) {
    conf -= 6;
  }
  let bias: PatternBias = 'neutral';
  let description = `箱体整理 ${fmt(avgLow)} – ${fmt(avgHigh)}`;
  let targetPrice: number | undefined;
  let status: PatternStatus = 'forming';

  if (brokenUp) {
    bias = 'bullish';
    conf += 8;
    status = 'confirmed';
    targetPrice = avgHigh + height;
    description = `突破箱体上沿 ${fmt(avgHigh)}，测量目标 ${fmt(targetPrice)}`;
  } else if (brokenDown) {
    bias = 'bearish';
    conf += 8;
    status = 'confirmed';
    targetPrice = avgLow - height;
    description = `跌破箱体下沿 ${fmt(avgLow)}，测量目标 ${fmt(targetPrice)}`;
  } else if ((everUp || everDown) && lastClose <= avgHigh - breakTol * 0.1 && lastClose >= avgLow + breakTol * 0.1) {
    status = 'failed';
    conf -= 12;
    description = `箱体突破后收回，短期失败（${fmt(avgLow)} – ${fmt(avgHigh)}）`;
  } else if (everUp && lastClose < avgLow - breakTol * 0.5) {
    status = 'invalidated';
    conf -= 20;
    description = `箱体上破后反向跌破下沿，结构失效`;
  } else if (everDown && lastClose > avgHigh + breakTol * 0.5) {
    status = 'invalidated';
    conf -= 20;
    description = `箱体下破后反向突破上沿，结构失效`;
  }

  return withScore({
    id: 'rectangle',
    name: '箱体/矩形',
    bias,
    confidence: Math.max(20, Math.round(Math.min(86, conf))),
    status,
    startIndex: start,
    endIndex: bars.length - 1,
    keyPoints: [
      { index: rh[0].index, price: avgHigh, label: '上沿' },
      { index: rl[0].index, price: avgLow, label: '下沿' },
    ],
    description,
    targetPrice,
    neckline: brokenUp ? avgHigh : brokenDown ? avgLow : undefined,
  });
}

function detectFlag(
  bars: KlineBar[],
  highs: SwingPoint[],
  lows: SwingPoint[],
  tol: number,
  atr: number
): ChartPatternResult | null {
  if (bars.length < 25) {
    return null;
  }
  const end = bars.length - 1;
  const poleStart = end - 20;
  const mid = end - 8;
  const poleMove = bars[mid].close - bars[Math.max(0, poleStart)].close;
  if (Math.abs(poleMove) < atr * 3) {
    return null;
  }

  const flagBars = bars.slice(mid);
  let maxH = -Infinity;
  let minL = Infinity;
  for (const b of flagBars) {
    maxH = Math.max(maxH, b.high);
    minL = Math.min(minL, b.low);
  }
  const flagRange = maxH - minL;
  if (flagRange > Math.abs(poleMove) * 0.55 || flagRange < tol) {
    return null;
  }

  const flagMove = bars[end].close - bars[mid].close;
  const isBullFlag = poleMove > 0 && flagMove < atr * 0.5;
  const isBearFlag = poleMove < 0 && flagMove > -atr * 0.5;
  if (!isBullFlag && !isBearFlag) {
    return null;
  }

  const name = isBullFlag ? '上升旗形' : '下降旗形';
  let bias: PatternBias = isBullFlag ? 'bullish' : 'bearish';
  const targetPrice = isBullFlag
    ? bars[end].close + Math.abs(poleMove) * 0.85
    : bars[end].close - Math.abs(poleMove) * 0.85;

  // 旗面时间：约 5~14 根
  const flagLen = end - mid;
  if (flagLen < 4 || flagLen > 16) {
    return null;
  }

  let status: PatternStatus = 'forming';
  let conf = 56 + Math.min(12, Math.abs(poleMove) / atr);
  let description = `${name}构筑中，测量目标约 ${fmt(targetPrice)}`;
  const last = bars[end].close;
  if (isBullFlag) {
    if (last > maxH + atr * 0.15) {
      status = 'confirmed';
      conf += 10;
      description = `${name}确认向上突破旗面，目标约 ${fmt(targetPrice)}`;
    } else if (last < minL - atr * 0.35) {
      status = 'invalidated';
      conf -= 18;
      description = `${name}跌破旗面下方，结构失效`;
    } else if (flagLen >= 14 && Math.abs(flagMove) < atr * 0.1) {
      status = 'failed';
      conf -= 8;
      description = `${name}横盘过久，旗形转弱`;
    }
  } else if (isBearFlag) {
    if (last < minL - atr * 0.15) {
      status = 'confirmed';
      conf += 10;
      description = `${name}确认向下跌破旗面，目标约 ${fmt(targetPrice)}`;
    } else if (last > maxH + atr * 0.35) {
      status = 'invalidated';
      conf -= 18;
      description = `${name}上破旗面，结构失效`;
    } else if (flagLen >= 14 && Math.abs(flagMove) < atr * 0.1) {
      status = 'failed';
      conf -= 8;
      description = `${name}横盘过久，旗形转弱`;
    }
  }

  return withScore({
    id: isBullFlag ? 'bull-flag' : 'bear-flag',
    name,
    bias,
    confidence: Math.max(20, Math.min(86, Math.round(conf))),
    status,
    startIndex: Math.max(0, poleStart),
    endIndex: end,
    keyPoints: [
      { index: Math.max(0, poleStart), price: bars[Math.max(0, poleStart)].close, label: '旗杆起' },
      { index: mid, price: bars[mid].close, label: '旗面起' },
      { index: end, price: bars[end].close, label: '当前' },
    ],
    description,
    targetPrice,
  });
}

function detectBreakouts(
  bars: KlineBar[],
  levels: SRLevel[],
  trendLines: TrendLineResult[],
  tols: Tolerances
): BreakoutResult[] {
  const out: BreakoutResult[] = [];
  const lookback = Math.min(12, bars.length - 2);
  const avgVol = averageVolume(bars, 20);
  const breakTol = tols.breakTol;

  for (let i = bars.length - lookback; i < bars.length; i++) {
    if (i < 1) {
      continue;
    }
    const b = bars[i];
    const prev = bars[i - 1];
    const volRatio = avgVol > 0 ? b.volume / avgVol : 1;

    for (const lv of levels) {
      const upper = lv.upper ?? lv.price;
      const lower = lv.lower ?? lv.price;

      if (
        (lv.type === 'resistance' || lv.type === 'pivot') &&
        prev.close <= upper + breakTol * 0.15 &&
        b.close > upper + breakTol * 0.35 &&
        b.close > prev.close
      ) {
        out.push(
          gradeBreakout({
            index: i,
            direction: 'up',
            kind: 'resistance',
            level: upper,
            price: b.close,
            volRatio,
            date: b.date,
            bars,
            tols,
          })
        );
      }
      if (
        (lv.type === 'support' || lv.type === 'pivot') &&
        prev.close >= lower - breakTol * 0.15 &&
        b.close < lower - breakTol * 0.35 &&
        b.close < prev.close
      ) {
        out.push(
          gradeBreakout({
            index: i,
            direction: 'down',
            kind: 'support',
            level: lower,
            price: b.close,
            volRatio,
            date: b.date,
            bars,
            tols,
          })
        );
      }
    }
  }

  for (const tl of trendLines) {
    if (tl.broken && tl.breakIndex != null) {
      const bi = tl.breakIndex;
      const b = bars[bi];
      const volRatio = avgVol > 0 ? b.volume / avgVol : 1;
      out.push(
        gradeBreakout({
          index: bi,
          direction: tl.type === 'resistance' ? 'up' : 'down',
          kind: 'trendline',
          level: b.close,
          price: b.close,
          volRatio,
          date: b.date,
          bars,
          tols,
          label: tl.type === 'support' ? '支撑趋势线' : '压力趋势线',
        })
      );
    }
  }

  // 假突破复核：突破后 N 日内收回到区间一侧
  for (const br of out) {
    if (br.quality === 'false') {
      continue;
    }
    if (isFalseBreakout(bars, br, tols)) {
      br.quality = 'false';
      br.volumeConfirmed = false;
      br.phase = 'break';
      br.description = br.description.replace(/（.*?）$/, '') + ' · 疑似假突破';
    }
  }

  out.sort((a, b) => {
    const q = qualityRank(b.quality) - qualityRank(a.quality);
    if (q !== 0) {
      return q;
    }
    return b.index - a.index;
  });

  const filtered: BreakoutResult[] = [];
  for (const br of out) {
    const near = filtered.some(
      (f) => f.direction === br.direction && Math.abs(f.index - br.index) <= 2
    );
    if (!near) {
      filtered.push(br);
    }
  }
  return filtered.slice(0, MAX_BREAKOUTS);
}

function qualityRank(q: BreakoutQuality): number {
  if (q === 'strong') {
    return 4;
  }
  if (q === 'normal') {
    return 3;
  }
  if (q === 'weak') {
    return 2;
  }
  return 1;
}

function gradeBreakout(args: {
  index: number;
  direction: 'up' | 'down';
  kind: BreakoutResult['kind'];
  level: number;
  price: number;
  volRatio: number;
  date: string;
  bars: KlineBar[];
  tols: Tolerances;
  label?: string;
}): BreakoutResult {
  const { index, direction, kind, level, price, volRatio, date, bars, tols, label } = args;
  let quality: BreakoutQuality = 'weak';
  const next = index + 1 < bars.length ? bars[index + 1] : null;
  const dual =
    next != null &&
    (direction === 'up' ? next.close > level : next.close < level);

  if (volRatio >= 1.5 && (dual || volRatio >= 2)) {
    quality = 'strong';
  } else if (volRatio >= 1.15) {
    quality = 'normal';
  } else {
    quality = 'weak';
  }

  let phase: BreakoutPhase = 'break';
  let retestIndex: number | undefined;
  const resolved = resolveBreakoutPhase(bars, index, direction, level, tols);
  phase = resolved.phase;
  retestIndex = resolved.retestIndex;

  const side =
    label ??
    (kind === 'trendline' ? '趋势线' : kind === 'resistance' ? `阻力 ${fmt(level)}` : `支撑 ${fmt(level)}`);
  const dirText = direction === 'up' ? '上破' : '下破';
  const qText =
    quality === 'strong' ? '强突破' : quality === 'normal' ? '放量突破' : '弱突破';
  const phaseText =
    phase === 'continue' ? '·已回踩延续' : phase === 'retest' ? '·等待回踩/回踩中' : '';

  return {
    index,
    direction,
    kind,
    level,
    price,
    volumeConfirmed: volRatio >= 1.15,
    quality,
    phase,
    volumeRatio: volRatio,
    retestIndex,
    description: `${date} ${dirText}${side}（${qText}${volRatio > 0 ? ' ×' + volRatio.toFixed(1) + '量' : ''}${phaseText}）`,
  };
}

function resolveBreakoutPhase(
  bars: KlineBar[],
  breakIdx: number,
  direction: 'up' | 'down',
  level: number,
  tols: Tolerances
): { phase: BreakoutPhase; retestIndex?: number } {
  const last = bars.length - 1;
  if (breakIdx >= last) {
    return { phase: 'break' };
  }
  const retestWindow = Math.min(tols.falseWindow + 3, last - breakIdx);
  let retestIndex: number | undefined;
  for (let i = breakIdx + 1; i <= breakIdx + retestWindow; i++) {
    const b = bars[i];
    if (direction === 'up') {
      // 回踩：低点触及突破位附近，收盘仍在上方
      if (b.low <= level + tols.touchTol && b.close >= level - tols.touchTol * 0.5) {
        retestIndex = i;
        break;
      }
    } else if (b.high >= level - tols.touchTol && b.close <= level + tols.touchTol * 0.5) {
      retestIndex = i;
      break;
    }
  }
  if (retestIndex == null) {
    return { phase: 'break' };
  }
  // 回踩后是否延续
  for (let i = retestIndex + 1; i <= last; i++) {
    if (direction === 'up' && bars[i].close > level + tols.breakTol * 0.3) {
      return { phase: 'continue', retestIndex };
    }
    if (direction === 'down' && bars[i].close < level - tols.breakTol * 0.3) {
      return { phase: 'continue', retestIndex };
    }
  }
  return { phase: 'retest', retestIndex };
}

function isFalseBreakout(bars: KlineBar[], br: BreakoutResult, tols: Tolerances): boolean {
  const n = tols.falseWindow;
  const end = Math.min(bars.length - 1, br.index + n);
  if (end <= br.index) {
    return false;
  }
  // 至少有 1 根后继，且窗口内收盘重新站回区间错误一侧
  for (let i = br.index + 1; i <= end; i++) {
    if (br.direction === 'up' && bars[i].close < br.level - tols.touchTol * 0.5) {
      return true;
    }
    if (br.direction === 'down' && bars[i].close > br.level + tols.touchTol * 0.5) {
      return true;
    }
  }
  return false;
}

/** 市场状态：趋势 / 震荡 / 高波动 + 方向 */
function detectMarketRegime(bars: KlineBar[], atr: number): MarketRegime {
  const lastIdx = bars.length - 1;
  const adx = computePseudoAdx(bars, 14);
  const maSlopePct = computeMaSlopePct(bars, 20, 10);
  const atrShort = computeATR(bars.slice(-Math.min(20, bars.length)), Math.min(10, bars.length - 1));
  const atrLong = atr > 0 ? atr : atrShort;
  const atrRatio = atrLong > 0 ? atrShort / atrLong : 1;

  // MA20 与收盘关系
  let ma20 = 0;
  if (bars.length >= 20) {
    let s = 0;
    for (let i = bars.length - 20; i < bars.length; i++) {
      s += bars[i].close;
    }
    ma20 = s / 20;
  }
  const lastClose = bars[lastIdx].close;
  const aboveMa20 = ma20 > 0 ? lastClose >= ma20 : maSlopePct >= 0;

  let direction: TrendDirection = 'flat';
  if (maSlopePct > 0.04 && aboveMa20) {
    direction = 'up';
  } else if (maSlopePct < -0.04 && !aboveMa20) {
    direction = 'down';
  } else if (maSlopePct > 0.08) {
    direction = 'up';
  } else if (maSlopePct < -0.08) {
    direction = 'down';
  }

  const look = Math.min(40, bars.length - 1);
  const netMove =
    Math.abs(bars[lastIdx].close - bars[lastIdx - look].close) / bars[lastIdx].close;
  let hi = -Infinity;
  let lo = Infinity;
  let flips = 0;
  for (let i = lastIdx - look; i <= lastIdx; i++) {
    hi = Math.max(hi, bars[i].high);
    lo = Math.min(lo, bars[i].low);
    if (i >= lastIdx - look + 2) {
      const d1 = bars[i].close - bars[i - 1].close;
      const d0 = bars[i - 1].close - bars[i - 2].close;
      if (d1 * d0 < 0) {
        flips++;
      }
    }
  }
  const localRange = (hi - lo) / bars[lastIdx].close;
  const isBoxing =
    (localRange > 0.02 && netMove < localRange * 0.55) || flips >= look * 0.32;

  let kind: MarketRegimeKind = 'range';
  let label = '震荡';
  let focus = '侧重 S/R 与反转结构';
  let clarity = 0.5;
  let strength = Math.min(100, Math.max(10, adx));

  if (atrRatio >= 1.45 && adx < 30) {
    kind = 'volatility';
    label = '高波动';
    focus = '侧重突破质量、回踩与假突破';
    clarity = Math.min(1, (atrRatio - 1) * 0.8 + 0.3);
    strength = Math.min(100, 40 + atrRatio * 25);
    direction = 'flat';
  } else if (!isBoxing && adx >= 22 && Math.abs(maSlopePct) >= 0.08) {
    kind = 'trend';
    label = direction === 'up' ? '上升趋势' : direction === 'down' ? '下降趋势' : '趋势';
    focus =
      direction === 'up'
        ? '侧重上升沿趋势线与多头顺势'
        : direction === 'down'
          ? '侧重下降沿趋势线与空头顺势'
          : '侧重趋势线';
    clarity = Math.min(1, (adx - 18) / 35 + Math.min(0.3, Math.abs(maSlopePct) / 0.4));
    strength = Math.min(100, adx + Math.abs(maSlopePct) * 80);
  } else if (isBoxing || adx < 18 || Math.abs(maSlopePct) < 0.05) {
    kind = 'range';
    label = '震荡';
    focus = '侧重支撑阻力与箱体/双顶底';
    clarity = Math.min(1, (isBoxing ? 0.4 : 0) + (20 - Math.min(adx, 20)) / 20 + 0.25);
    strength = Math.min(100, 55 - adx * 0.5);
    direction = 'flat';
  } else if (adx >= 20 && !isBoxing) {
    kind = 'trend';
    label =
      direction === 'up' ? '弱上升趋势' : direction === 'down' ? '弱下降趋势' : '弱趋势';
    focus = '趋势线优先，S/R 次之';
    clarity = 0.45;
    strength = Math.min(100, adx);
  } else {
    kind = 'range';
    label = '弱震荡';
    focus = 'S/R 与结构形态';
    clarity = 0.45;
    strength = 40;
    direction = 'flat';
  }

  return {
    kind,
    direction,
    strength: Math.round(strength),
    adx,
    maSlopePct,
    atrRatio,
    aboveMa20,
    label,
    clarity,
    focus,
  };
}

function computeMaSlopePct(bars: KlineBar[], maPeriod: number, lookback: number): number {
  if (bars.length < maPeriod + lookback) {
    return 0;
  }
  const maAt = (end: number) => {
    let s = 0;
    for (let i = end - maPeriod + 1; i <= end; i++) {
      s += bars[i].close;
    }
    return s / maPeriod;
  };
  const end = bars.length - 1;
  const now = maAt(end);
  const prev = maAt(end - lookback);
  if (prev <= 0) {
    return 0;
  }
  // 换算成大约每根相对变化 %
  return ((now - prev) / prev) * 100 / lookback;
}

/** 简化 ADX（无平滑 Wilder，速度优先） */
function computePseudoAdx(bars: KlineBar[], period: number): number {
  if (bars.length < period + 2) {
    return 15;
  }
  let plusDM = 0;
  let minusDM = 0;
  let trSum = 0;
  const start = bars.length - period;
  for (let i = start; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const up = cur.high - prev.high;
    const down = prev.low - cur.low;
    if (up > down && up > 0) {
      plusDM += up;
    }
    if (down > up && down > 0) {
      minusDM += down;
    }
    trSum += Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
  }
  if (trSum <= 0) {
    return 15;
  }
  const plusDI = (plusDM / trSum) * 100;
  const minusDI = (minusDM / trSum) * 100;
  const sum = plusDI + minusDI;
  if (sum <= 0) {
    return 15;
  }
  const dx = (Math.abs(plusDI - minusDI) / sum) * 100;
  return Math.min(60, Math.max(5, dx));
}

/** —— Score Explain Engine（无回测概率）—— */

const SCORE_W = {
  geometric: 0.55,
  volume: 0.12,
  location: 0.13,
  lifecycle: 0.2,
} as const;

function lifecycleScore(status: PatternStatus): number {
  switch (status) {
    case 'confirmed':
      return 88;
    case 'forming':
      return 62;
    case 'failed':
      return 34;
    case 'invalidated':
      return 18;
    default:
      return 50;
  }
}

function volumeQuality(bars: KlineBar[], startIndex: number, endIndex: number): number {
  const avg = averageVolume(bars, 20);
  if (avg <= 0 || bars.length === 0) {
    return 50;
  }
  const from = Math.max(0, Math.min(startIndex, endIndex));
  const to = Math.min(bars.length - 1, Math.max(startIndex, endIndex));
  // 形态尾段量能（近 5 根优先）
  const tailFrom = Math.max(from, to - 4);
  let sum = 0;
  let n = 0;
  for (let i = tailFrom; i <= to; i++) {
    sum += bars[i].volume;
    n++;
  }
  if (n === 0) {
    return 50;
  }
  const ratio = sum / n / avg;
  // 0.6x→35, 1x→55, 1.5x→72, 2.2x→88
  return Math.max(20, Math.min(94, Math.round(28 + ratio * 28)));
}

function locationQuality(
  p: ChartPatternResult,
  lastClose: number,
  levels: SRLevel[]
): number {
  if (!levels.length || lastClose <= 0) {
    return 50;
  }
  let bestDist = Infinity;
  let bestLv: SRLevel | null = null;
  const ref =
    p.neckline != null
      ? p.neckline
      : p.keyPoints.length
        ? p.keyPoints[p.keyPoints.length - 1].price
        : lastClose;

  for (const lv of levels) {
    const lo = lv.lower ?? lv.price;
    const hi = lv.upper ?? lv.price;
    let d: number;
    if (ref >= lo && ref <= hi) {
      d = 0;
    } else {
      d = Math.min(Math.abs(ref - lo), Math.abs(ref - hi), Math.abs(ref - lv.price));
    }
    const dPct = (d / lastClose) * 100;
    if (dPct < bestDist) {
      bestDist = dPct;
      bestLv = lv;
    }
  }

  // 形态与价区：越接近关键结构越好（可解释语境，非预测）
  let score = 48;
  if (bestDist <= 0.4) {
    score = 86;
  } else if (bestDist <= 1.2) {
    score = 76;
  } else if (bestDist <= 2.5) {
    score = 66;
  } else if (bestDist <= 5) {
    score = 52;
  } else if (bestDist <= 9) {
    score = 40;
  } else {
    score = 30;
  }

  // 顺结构：支撑区偏多 / 阻力区偏空略加分
  if (bestLv) {
    if (p.bias === 'bullish' && bestLv.type === 'support') {
      score = Math.min(94, score + 6);
    }
    if (p.bias === 'bearish' && bestLv.type === 'resistance') {
      score = Math.min(94, score + 6);
    }
    if (bestLv.freshness === 'recent') {
      score = Math.min(94, score + 3);
    }
  }
  return score;
}

function breakoutCoherenceBonus(
  p: ChartPatternResult,
  breakouts: BreakoutResult[]
): { bonus: number; note?: string } {
  if (!breakouts.length) {
    return { bonus: 0 };
  }
  const wantUp = p.bias === 'bullish';
  const wantDown = p.bias === 'bearish';
  const windowFrom = Math.max(0, p.endIndex - 2);
  const related = breakouts.filter((b) => {
    if (b.quality === 'false') {
      return false;
    }
    if (b.index < windowFrom) {
      return false;
    }
    if (wantUp && b.direction !== 'up') {
      return false;
    }
    if (wantDown && b.direction !== 'down') {
      return false;
    }
    return true;
  });
  if (!related.length) {
    return { bonus: 0 };
  }
  const best = related.sort(
    (a, b) => phaseRank(b.phase) - phaseRank(a.phase) || qualityRank(b.quality) - qualityRank(a.quality)
  )[0];
  if (best.phase === 'continue' && best.quality === 'strong') {
    return { bonus: 5, note: '突破回踩延续共振' };
  }
  if (best.phase === 'retest' || best.quality === 'strong') {
    return { bonus: 3, note: best.phase === 'retest' ? '突破回踩中' : '强突破共振' };
  }
  if (best.phase === 'break') {
    return { bonus: 2, note: '近期同向突破' };
  }
  return { bonus: 0 };
}

/**
 * 统一评分：可复核、可展示；不产生“未来 N 日胜率”。
 * final = clamp( (0.55G+0.12V+0.13L+0.20C) * regimeFactor )
 */
function scorePatterns(
  patterns: ChartPatternResult[],
  bars: KlineBar[],
  levels: SRLevel[],
  breakouts: BreakoutResult[],
  regime: MarketRegime,
  lastClose: number
): ChartPatternResult[] {
  return patterns.map((p) => {
    const geometric = Math.max(1, Math.min(100, p.baseScore ?? p.score ?? 50));
    const volume = volumeQuality(bars, p.startIndex, p.endIndex);
    const location = locationQuality(p, lastClose, levels);
    const lifecycle = lifecycleScore(p.status);
    const regimeFactor = clampRegimeFactor(regimeFactorForPattern(regime, p));
    const coh = breakoutCoherenceBonus(p, breakouts);

    let blended =
      geometric * SCORE_W.geometric +
      volume * SCORE_W.volume +
      location * SCORE_W.location +
      lifecycle * SCORE_W.lifecycle;
    blended = Math.max(1, Math.min(100, blended + coh.bonus));

    const score = Math.max(1, Math.min(99, Math.round(blended * regimeFactor)));

    const reasons: string[] = [
      `几何 ${geometric}`,
      `量能 ${volume}`,
      `位置 ${location}`,
      `状态 ${statusLabel(p.status)}(${lifecycle})`,
    ];
    if (coh.note) {
      reasons.push(coh.note);
    }
    if (regimeFactor >= REGIME_MATCH) {
      reasons.push(`市态匹配 ×${regimeFactor.toFixed(2)}`);
    } else if (regimeFactor <= REGIME_MISMATCH) {
      reasons.push(`市态不匹配 ×${regimeFactor.toFixed(2)}`);
    } else {
      reasons.push(`市态中性 ×${regimeFactor.toFixed(2)}`);
    }

    const breakdown: StructureScoreBreakdown = {
      geometric,
      volume,
      location,
      lifecycle,
      blended: Math.round(blended),
      regimeFactor,
      weights: { ...SCORE_W },
      reasons,
    };

    return {
      ...p,
      baseScore: geometric,
      score,
      confidence: score,
      regimeFactor,
      breakdown,
    };
  });
}

function statusLabel(status: PatternStatus): string {
  switch (status) {
    case 'confirmed':
      return '已确认';
    case 'forming':
      return '构筑中';
    case 'failed':
      return '短期失败';
    case 'invalidated':
      return '结构失效';
    default:
      return status;
  }
}

function clampRegimeFactor(f: number): number {
  return Math.min(REGIME_MATCH, Math.max(REGIME_MISMATCH, f));
}

/** 结构匹配度：只给 0.8 / 1 / 1.15 三档 */
function regimeFactorForPattern(regime: MarketRegime, p: ChartPatternResult): number {
  const id = p.id;
  const rangeIds = ['double-top', 'double-bottom', 'rectangle', 'head-shoulders', 'inv-head-shoulders'];
  const bullish = p.bias === 'bullish' || id === 'bull-flag' || id === 'triangle-asc' || id === 'inv-head-shoulders';
  const bearish = p.bias === 'bearish' || id === 'bear-flag' || id === 'triangle-desc' || id === 'head-shoulders';

  if (regime.kind === 'range') {
    if (rangeIds.includes(id)) {
      return REGIME_MATCH;
    }
    if (id.includes('flag') || id.includes('triangle')) {
      return REGIME_MISMATCH;
    }
    return REGIME_NEUTRAL;
  }
  if (regime.kind === 'trend') {
    // 方向匹配的顺势才 boost
    if (regime.direction === 'up' && bullish) {
      return REGIME_MATCH;
    }
    if (regime.direction === 'down' && bearish) {
      return REGIME_MATCH;
    }
    if (rangeIds.includes(id)) {
      return REGIME_MISMATCH;
    }
    if (id.includes('triangle') || id.includes('flag')) {
      return REGIME_NEUTRAL;
    }
    return REGIME_NEUTRAL;
  }
  // volatility：突破向形态略匹配
  if (id.includes('flag') || id.includes('triangle') || id === 'rectangle') {
    return REGIME_MATCH;
  }
  if (rangeIds.includes(id)) {
    return REGIME_MISMATCH;
  }
  return REGIME_NEUTRAL;
}

function applyRegimeWeights(
  regime: MarketRegime,
  levels: SRLevel[],
  trendLines: TrendLineResult[],
  patterns: ChartPatternResult[],
  breakouts: BreakoutResult[]
): {
  supportResistance: SRLevel[];
  trendLines: TrendLineResult[];
  patterns: ChartPatternResult[];
  breakouts: BreakoutResult[];
} {
  const srMul = clampRegimeFactor(
    regime.kind === 'range' ? REGIME_MATCH : regime.kind === 'trend' ? REGIME_MISMATCH : REGIME_NEUTRAL
  );
  const tlMul = clampRegimeFactor(
    regime.kind === 'trend' ? REGIME_MATCH : regime.kind === 'range' ? REGIME_MISMATCH : REGIME_NEUTRAL
  );

  const supportResistance = levels
    .map((lv) => {
      const base = lv.baseStrength ?? lv.strength;
      return {
        ...lv,
        baseStrength: base,
        strength: Math.min(1, base * srMul),
      };
    })
    .filter((lv) => {
      if (regime.kind === 'trend') {
        return lv.strength >= 0.24 || lv.freshness === 'recent';
      }
      return lv.strength >= 0.22;
    })
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MAX_SR_LEVELS);

  const tls = trendLines
    .map((tl) => {
      const base = tl.baseStrength ?? tl.strength;
      return {
        ...tl,
        baseStrength: base,
        strength: Math.min(1, base * tlMul),
      };
    })
    .filter((tl) => {
      // 方向过滤：仅丢极弱逆势线
      if (regime.kind === 'trend' && regime.direction === 'up' && tl.type === 'resistance' && tl.strength < 0.42) {
        return false;
      }
      if (regime.kind === 'trend' && regime.direction === 'down' && tl.type === 'support' && tl.strength < 0.42) {
        return false;
      }
      // 震荡市不再要求必须 3 触点（swing 稀时几乎全灭）
      if (regime.kind === 'range') {
        return tl.strength >= 0.34 && tl.touches >= 2 && (tl.coverage == null || tl.coverage >= 0.1);
      }
      return tl.strength >= 0.34;
    })
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MAX_TRENDLINES);

  // 形态分已由 scorePatterns 完成；此处仅按可验证门槛过滤
  const pats = patterns
    .filter((p) => {
      // 彻底失效默认不展示（避免噪声），除非混合分仍高
      if (p.status === 'invalidated') {
        return (p.breakdown?.blended ?? p.score) >= 55;
      }
      if (p.status === 'failed' && p.score < 52) {
        return false;
      }
      if (regime.kind === 'range' && p.score < 54 && (p.id.includes('flag') || p.id.includes('triangle'))) {
        return false;
      }
      if (
        regime.kind === 'trend' &&
        p.score < 54 &&
        (p.id === 'double-top' || p.id === 'double-bottom' || p.id.includes('head'))
      ) {
        if (regime.direction === 'up' && p.bias === 'bearish') {
          return false;
        }
        if (regime.direction === 'down' && p.bias === 'bullish') {
          return false;
        }
      }
      // 几何分过低的 forming 不展示
      if (p.status === 'forming' && (p.baseScore ?? 0) < 50 && p.score < 56) {
        return false;
      }
      return p.score >= 50 || p.status === 'confirmed';
    })
    .sort((a, b) => {
      const st = statusRank(b.status) - statusRank(a.status);
      if (st !== 0) {
        return st;
      }
      return b.score - a.score;
    })
    .slice(0, MAX_PATTERNS);

  const bos = breakouts
    .map((b) => {
      if (regime.kind === 'volatility' && b.quality === 'weak') {
        return { ...b, description: b.description + ' · 高波慎用' };
      }
      return b;
    })
    .filter((b) => {
      if (regime.kind === 'range' && b.quality === 'weak') {
        return false;
      }
      return true;
    })
    // 优先 continue > retest > break；同档看质量
    .sort((a, b) => {
      const pr = phaseRank(b.phase) - phaseRank(a.phase);
      if (pr !== 0) {
        return pr;
      }
      return qualityRank(b.quality) - qualityRank(a.quality) || b.index - a.index;
    })
    .slice(0, MAX_BREAKOUTS);

  return {
    supportResistance,
    trendLines: tls,
    patterns: pats,
    breakouts: bos,
  };
}

function phaseRank(p: BreakoutPhase | undefined): number {
  if (p === 'continue') {
    return 3;
  }
  if (p === 'retest') {
    return 2;
  }
  return 1;
}

function buildSummary(
  levels: SRLevel[],
  trendLines: TrendLineResult[],
  patterns: ChartPatternResult[],
  breakouts: BreakoutResult[],
  lastClose: number,
  regime?: MarketRegime
): string {
  const parts: string[] = [];
  if (regime) {
    const dir =
      regime.direction === 'up' ? '↑' : regime.direction === 'down' ? '↓' : '';
    parts.push(`市态 ${regime.label}${dir ? dir : ''}(${regime.strength})`);
  }

  const topPattern = patterns[0];
  if (topPattern) {
    const biasText =
      topPattern.bias === 'bullish' ? '偏多' : topPattern.bias === 'bearish' ? '偏空' : '中性';
    const st = statusLabel(topPattern.status);
    const geom = topPattern.baseScore != null ? `几何${topPattern.baseScore}` : '';
    parts.push(
      `${topPattern.name}（${st} ${biasText} 评分${topPattern.score}${geom ? ' ' + geom : ''}）`
    );
  }

  const supports = levels.filter((l) => l.type === 'support').slice(0, 2);
  const resistances = levels.filter((l) => l.type === 'resistance').slice(0, 2);
  if (supports.length) {
    parts.push(`支撑 ${supports.map((s) => fmt(s.price)).join(' / ')}`);
  }
  if (resistances.length) {
    parts.push(`阻力 ${resistances.map((r) => fmt(r.price)).join(' / ')}`);
  }

  if (trendLines.length) {
    const active = trendLines.filter((t) => !t.broken);
    if (active.length) {
      parts.push(`${active.length} 条有效趋势线`);
    }
  }

  const recentBreak = breakouts.find((b) => b.quality !== 'false');
  if (recentBreak) {
    const q =
      recentBreak.quality === 'strong'
        ? '强'
        : recentBreak.quality === 'normal'
          ? ''
          : '弱';
    parts.push(recentBreak.direction === 'up' ? `近期${q}上破` : `近期${q}下破`);
  } else if (breakouts.some((b) => b.quality === 'false')) {
    parts.push('存在假突破痕迹');
  }

  if (parts.length === 0) {
    return `现价 ${fmt(lastClose)}，暂无明显结构，关注附近支撑阻力区`;
  }
  return parts.join(' · ');
}

function averageVolume(bars: KlineBar[], period: number): number {
  const n = Math.min(period, bars.length);
  if (n === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    sum += bars[i].volume || 0;
  }
  return sum / n;
}

function mean(xs: number[]): number {
  if (xs.length === 0) {
    return 0;
  }
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function linearFit(
  xs: number[],
  ys: number[]
): { slope: number; intercept: number; y: (x: number) => number } | null {
  if (xs.length < 2 || xs.length !== ys.length) {
    return null;
  }
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumXX += xs[i] * xs[i];
  }
  const den = n * sumXX - sumX * sumX;
  if (Math.abs(den) < 1e-12) {
    return null;
  }
  const slope = (n * sumXY - sumX * sumY) / den;
  const intercept = (sumY - slope * sumX) / n;
  return {
    slope,
    intercept,
    y: (x: number) => slope * x + intercept,
  };
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) {
    return '--';
  }
  if (n >= 1000) {
    return n.toFixed(1);
  }
  if (n >= 100) {
    return n.toFixed(2);
  }
  if (n >= 10) {
    return n.toFixed(2);
  }
  return n.toFixed(3);
}
