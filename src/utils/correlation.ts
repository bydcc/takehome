/** Pearson 相关系数；样本不足或方差为 0 时返回 null */
export function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const pairs: [number, number][] = [];
  const len = Math.min(xs.length, ys.length);
  for (let i = 0; i < len; i++) {
    const x = xs[i];
    const y = ys[i];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      pairs.push([x, y]);
    }
  }
  if (pairs.length < 2) {
    return null;
  }
  const n = pairs.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
    sumY2 += y * y;
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (den === 0) {
    return null;
  }
  return num / den;
}

export interface PairwiseCorrelation {
  a: string;
  b: string;
  r: number;
}

/** 计算多序列两两 Pearson 相关系数 */
export function pairwiseCorrelations(
  names: string[],
  aligned: number[][]
): PairwiseCorrelation[] {
  const result: PairwiseCorrelation[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const r = pearsonCorrelation(aligned[i], aligned[j]);
      if (r !== null) {
        result.push({ a: names[i], b: names[j], r });
      }
    }
  }
  return result;
}
