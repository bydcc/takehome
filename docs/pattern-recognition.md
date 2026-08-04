# 形态识别与叠加线说明

本文说明详情页 **日 K / 周 K**「形态识别」的完整算法口径、计算步骤与绘制规则。  
实现为本地 **Structure Engine**（纯规则系统），**不调用外部 AI**，**不输出历史胜率/回测概率**。

| 项 | 路径 / 约定 |
|----|-------------|
| 分析引擎 | `src/analysis/patternRecognition.ts` → `analyzePatterns(bars, { period })` |
| 绘制 / 面板 | `src/ui/stockDetailPanel.ts` |
| 入场数据 | 约 **150** 根 K 线（`KLINE_BARS_FOR_CHART`） |
| 最低长度 | **≥ 30** 根，否则 `analyzePatterns` 返回 `null` |
| 适用范围 | 仅日 K / 周 K；分时图不跑引擎 |
| 开关 | 工具栏「形态识别」（默认开启；再点一次关闭） |

> **当前能力**：Swing 双档 + S/R 区域 + RANSAC 趋势线 + 既有形态集 + 突破质量/回踩/假突破 + MarketRegime + Score Explain + 视觉预算。  
> **刻意不做**：杯柄/楔形等新形态、回测经验概率、行业标签分类。

---

## 0. 管线总览

```text
bars (≥30) + period(daily|weekly)
  │
  ├─ computeTolerances        → ATR / 三层容差 / volPct / falseWindow
  ├─ findSwings(high|low)     → 摆动点 strength, distanceFromPrev
  ├─ detectMarketRegime       → kind, direction, strength, adx, …
  │
  ├─ detectSupportResistance  → S/R 区域（最多 3）
  ├─ detectTrendLines         → 支撑/压力趋势线（最多 2）
  ├─ detectChartPatterns      → 形态几何分 + lifecycle
  ├─ detectBreakouts          → 质量 / phase / 假突破
  │
  ├─ scorePatterns            → Score Explain（几何·量·位·态 × regime）
  ├─ applyRegimeWeights       → 市态倍率过滤 + 门槛
  ├─ 视觉预算硬裁             → MAX: SR3 / TL2 / Pat1 / BO3
  └─ buildSummary             → 一行速览文案
        │
        ▼  PatternAnalysis → webview 画布叠加 + 下方面板
```

### 输出预算（常量）

| 常量 | 值 | 含义 |
|------|-----|------|
| `MAX_SR_LEVELS` | 3 | S/R 区域 |
| `MAX_TRENDLINES` | 2 | 趋势线 |
| `MAX_PATTERNS` | 1 | 主形态 |
| `MAX_BREAKOUTS` | 3 | 突破标记 |
| `TREND_LOOKBACK` | 70 | 趋势线向左看窗口 |
| `TREND_END_MAX_AGE` | 28 | 趋势线右端最大年龄（根） |
| `PATTERN_MAX_AGE` | 45 | 形态右端最大年龄 |
| `PATTERN_SEP_MIN/MAX` | 5 / 50 | 双顶底等时间分离度（根） |
| `REGIME_MATCH / NEUTRAL / MISMATCH` | 1.15 / 1.0 / 0.8 | 市态系数仅三档 |

---

## 1. 基础指标：ATR 与三层容差

入口：`computeTolerances(bars, period)` → 写入 `meta` 与全链路共用。

### 1.1 真波幅 TR 与 ATR

对每根 i = 1 .. n-1：

```text
TR[i] = max(
  High[i] - Low[i],
  abs(High[i] - Close[i-1]),
  abs(Low[i]  - Close[i-1])
)

ATR = mean( 末端 min(atrPeriod, |TR|) 根 TR )
```

**atrPeriod 自适应：**

1. 日 K 基准 **14**，周 K 基准 **10**  
2. 与 `sqrt(bars.length)` 夹在 **[5, 20]**，并受 `bars.length - 1` 限制 

空序列回退：`close × 0.02`。

### 1.2 波动率代理 volPct

```text
volPct = ATR / Close_last
```

面板展示为「波动 x.xx%」。用于**本序列**容差缩放（非股票行业标签）。

| volPct | scale |
|--------|-------|
| `< 0.012`（低波） | **0.85** 收窄 |
| `0.012 ~ 0.028` | **1.0** |
| `> 0.028` | **1.1** |
| `> 0.04`（高波） | **1.22** 放宽 |

### 1.3 三层容差（全部 × scale）

先算全样本价格跨度：

```text
range = max(High) - min(Low)   // 全样本
```

| 名称 | 公式 | 用途 |
|------|------|------|
| **levelTol** | `max(ATR×0.5, C×0.008, range×0.01) × scale` | S/R 聚类合并、触碰判据、形态峰谷公差 |
| **touchTol** | `max(ATR×0.35, C×0.004) × scale` | 贴线、贴区、回踩容差 |
| **breakTol** | `max(ATR×0.8, C×0.01) × scale` | 突破 / 跌破（更严） |

### 1.4 假突破时间窗 falseWindow

| 条件 | falseWindow |
|------|-------------|
| 周 K | 2 |
| 日 K 默认 | 4 |
| 日 K 且 volPct > 0.035 | 5 |

含义：突破后 **N 根内**收盘重新穿越回结构另一侧 → 标 `quality='false'`（见 §7）。

---

## 2. Swing Engine（摆动点）

入口：`findSwings(bars, 'high'|'low', left=3, right=3, atr)`。

### 2.1 双档采集 `collectSwings`

| 档 | left/right | minProtrusion | strengthBias |
|----|------------|---------------|--------------|
| 主档 | 3 / 3 | `ATR × 0.14` | 0 |
| 次档 | 2 / 2 | `ATR × 0.10` | −0.06（强度略降） |

另设绝对底限：`minProt = max(minProtrusion, C_last × 0.0012)`。

**局部极值条件（以高点为例）：**

在索引窗口 `[i−L, i+R]` 内，`High[i]` **严格高于**其余所有 bar 的 high（`cmp >= price` 则否）。

**突起 protrusion：**

```text
protrusion_high = High[i] - max(邻域内其余 High)   // 邻域“次高”
// 低点：protrusion_low = min(邻域其余 Low) - Low[i]
```

要求 `protrusion ≥ minProt`。

**强度 strength ∈ [0.2, 1]：**

```text
spanPrice = max(High) - min(Low)     // 同窗
volFactor = min(1.5, spanPrice / ATR)
raw = (protrusion / ATR)×0.55 + volFactor×0.25 + 0.25 + strengthBias
strength = clamp(0.2, 1, raw)
```

### 2.2 合并与时间间距

`mergeSwingsByIndex(points, minGap=2)`：索引差 ≤ 2 只保留更强者。

```text
distanceFromPrev = -1                      // 首个
distanceFromPrev = index[i] - index[i-1]  // 否则
```

用于形态侧时间结构约束（双顶底等用分离度 `sep`）。

---

## 3. MarketRegime（市场状态）

入口：`detectMarketRegime(bars, atr)`。

### 3.1 子指标

#### 简易 ADX（`computePseudoAdx`，period=14，**非 Wilder 平滑**）

对末端 14 根累计：

- `+DM`：up 动量为主时累加 `(H - H_prev)`  
- `-DM`：down 为主时累加 `(L_prev - L)`  
- `TR` 同 §1.1  

```text
+DI = 100 × (+DM) / TR_sum
-DI = 100 × (-DM) / TR_sum
DX  = 100 × abs(+DI - -DI) / (+DI + -DI)
```

输出：`adx = clamp(5, 60, DX)`。默认不足数据返回 15。

> **ADX 只表强度，不表方向。**

#### MA20 斜率（`computeMaSlopePct(bars, 20, 10)`）

```text
MA_end  = mean(Close[end-19 .. end])            // MA20 在末端
MA_prev = mean(Close[end-lookback-19 .. end-lookback])

maSlopePct = ((MA_end - MA_prev) / MA_prev) × 100 / lookback
```

单位：约「每根相对 %」。

#### ATR 比

```text
atrShort = ATR(近最多 20 根, period≈10)
atrRatio = atrShort / atrLong
```

其中 `atrLong` 为全序列主 ATR。

#### 收盘 vs MA20

`aboveMa20 = C_last ≥ MA20`（可算时）。

### 3.2 方向 direction

| 条件 | direction |
|------|-----------|
| maSlopePct > 0.04 且 aboveMa20 | `up` |
| maSlopePct < −0.04 且 !aboveMa20 | `down` |
| 否则 maSlopePct > 0.08 | `up` |
| 否则 maSlopePct < −0.08 | `down` |
| 否则 | `flat` |

高波动市态会把 direction **强制 flat**。

### 3.3 箱体/震荡启发式 isBoxing

看末端最多 40 根：

```text
netMove    = abs(Close_last - Close_look) / Close_last
localRange = (High_max - Low_min) / Close_last
```

方向翻转次数 `flips`：相邻 close 增量符号相反计数。

```text
isBoxing =
  (localRange > 0.02 且 netMove < localRange×0.55)
  或 (flips ≥ look×0.32)
```

### 3.4 kind 判定顺序（互斥 if/else）

| 次序 | 条件（摘要） | kind | strength / clarity 要点 |
|------|--------------|------|-------------------------|
| 1 | atrRatio≥1.45 且 adx<30 | `volatility` | strength≈40+atrRatio×25；direction=flat |
| 2 | !boxing 且 adx≥22 且 \|slope\|≥0.08 | `trend` | strength≈adx+\|slope\|×80；清晰度与 adx/斜率有关 |
| 3 | boxing 或 adx<18 或 \|slope\|<0.05 | `range` | strength≈55−adx×0.5；direction=flat |
| 4 | adx≥20 且 !boxing | 弱 `trend` | strength≈adx |
| 5 | 否则 | 弱 `range` | strength=40 |

`strength` 最终取整 0–100；`label` / `focus` 为人读文案（上升/下降趋势、侧重 S/R 等）。

---

## 4. S/R Zone（支撑阻力区域）

入口：`detectSupportResistance`。**不是单价格线，而是 center + [lower, upper] 区间。**

### 4.1 种子

1. 近 **90 根** 内的 swing 高/低  
2. `collectMinorPivots`：左右 1 根局部高低（固定 strength **0.32**）  
3. 仍无种子 → `ensureBaselineSr` 兜底（见 4.6）

### 4.2 聚类

按 price 排序后顺序聚类：若点与当前簇均价差 ≤ **levelTol**，并入同簇。

### 4.3 区域几何

对每个簇：

```text
// s_i 为 swing strength
center   = sum( p_i × (0.5 + s_i) ) / sum(0.5 + s_i)
half     = max( (max_p - min_p)/2, touchTol×0.8, ATR×0.15 )
lower    = center - half
upper    = center + half
widthPct = (upper - lower) / Close_last
```

### 4.4 触及统计

对每根 K：若影线与 `[lower, upper]` 相交，或 high/low/close 距 center ≤ levelTol，计一次 touch。

```text
recentTouchScore += 1 / (1 + age/12)
```

放量：`volume ≥ avgVol20 × 1.5` 时 `volumeHits++`，并 `recentTouchScore += 0.15`。

过滤：

- `touchCount < 2` 丢弃  
- `|distancePct| > 18%` 丢弃，其中

```text
distancePct = (center - Close_last) / Close_last × 100
```

### 4.5 类型 / 新鲜度 / 强度

**type：**

| 条件 | type |
|------|------|
| center > C + touchTol×0.5 | resistance |
| center < C − touchTol×0.5 | support |
| 否则 | pivot |

**freshness / ageScore（lastTouchAge 根）：**

| lastTouchAge | freshness | ageScore |
|--------------|-----------|----------|
| ≤30 | recent | 1.0 |
| ≤90 | mid | 0.6 |
| 其他 | old | 0.3 |

**宽度因子 widthFactor：**

| width | factor |
|-------|--------|
| > ATR×3 | 0.70 |
| > ATR×2 | 0.85 |
| < ATR×0.4 | 1.05 |
| 其他 | 1.0 |

**baseStrength ∈ [0, 1]：**

```text
proximity = 1 / (1 + abs(distancePct) / 2.5)

baseStrength = min(1, (
    recentTouchScore × 0.1
  + proximity × 0.32
  + ageScore × 0.28
  + min(0.15, clusterSize × 0.04)
  + (volumeHits > 0 ? 0.1 : 0)
) × widthFactor )
```

排序分：

```text
sort = strength × (0.5 + ageScore×0.5) × 1 / (1 + abs(distancePct)×0.7)
```

去近重（价差 ≤ levelTol×1.1）；`old` 且 strength < 0.22 剔除；最多 3。

### 4.6 兜底 ensureBaselineSr

仅当上一步结果为空：用近 20/40/60 根最高价/最低价，距现价 ≤18% 时生成 R/S，  
half=`max(touchTol×0.8, ATR×0.12)`，strength 约 0.55（20 窗）或 0.42。

### 4.7 市态重加权（S/R）

```text
srMul = range → 1.15 | trend → 0.8 | volatility → 1.0
strength = min(1, baseStrength × srMul)
```

过滤：trend 下 strength≥0.24 或 freshness=recent；否则 ≥0.22。

### 4.8 绘制

- 淡色带 fill `[y(upper), y(lower)]` + 中心虚线  
- 右侧价签 S / R / P  
- 悬停接近区域：tooltip 强度、触及、日期  
- 画布可见门槛：strength ≥ **0.20**

---

## 5. 趋势线（RANSAC + 回退）

入口：`detectTrendLines` → 支撑用 **lows**，压力用 **highs**；各至多 1 条，合计 ≤2。

### 5.1 候选池

```text
pool = { swing | index ≥ last-70 且 strength ≥ 0.28 }
```

至少 2 点，否则无趋势线。

### 5.2 RANSAC 风格路径（确定性）

前提 pool ≥ 3：

1. 枚举点对：跨度在 `[6, 55]`，右端年龄 ≤ 28  
2. 最多取强度最高的 60 对  
3. 斜率斜率合法（`isSlopeOk`，见下）  
4. 内点：距模型线 ≤ touchTol；禁止区间内严重反向穿透  
5. 内点最小二乘精炼  
6. 再计分 `scoreTrendCandidate`  
7. 优先更多 inlier  

### 5.3 两点枚举回退

任意合法两点 + 区间触点数 ≥2 + 无严重违反 → 计分排序（更近 / 更多触 / 更高 strength）。

### 5.4 斜率合法性 isSlopeOk

| 约束 | 条件 |
|------|------|
| 过陡拒绝 | `|slope| > ATR×0.55` |
| 支撑不能过猛向下 | `support` 且 `slope < −ATR×0.35` |
| 压力不能过猛向上 | `resistance` 且 `slope > ATR×0.35` |

### 5.5 质量分 scoreTrendCandidate

线模型：`line(i) = P0 + slope×(i−i0)`。

**穿透惩罚：**

- soft：低/高价远离线超过 touchTol×1.8  
- hard：收盘穿越线超过 breakTol×0.6  

过阈剔除：

- hardPen > max(1, floor(span×0.08))  
- softPen > max(3, floor((last−start)×0.28))  

**相对现价：** 投影线须在现价 ±16%（及 touchTol×2.5）合理域。

**子分：**

```text
fitScore     = 1 / (1 + avgResidual / touchTol)
recencyScore = 1 - (last - endIndex) / (TREND_END_MAX_AGE + 1)
touchScore   = min(1, touches / 4)
coverage     = min(1, span / TREND_LOOKBACK)

baseStrength = min(1,
    fitScore     × 0.35
  + touchScore   × 0.25
  + recencyScore × 0.20
  + coverage     × 0.20
  + (touches ≥ 3 ? 0.05 : 0)
)
```

入选门槛：`fitScore ≥ 0.38` 且 `baseStrength ≥ 0.36`；  
`coverage < 0.12` 且 `touches < 2` 丢弃。

### 5.6 突破标记 markTrendBreak

从 endIndex+1 起：收盘越过线 ± breakTol，且下一根仍确认 → `broken=true`，`breakIndex=i`。  
绘制时实线段画到 break 点，其后虚线延长/截断。

### 5.7 市态重加权（趋势线）

```text
tlMul = trend → 1.15 | range → 0.8 | volatility → 1.0
```

过滤摘要：

- 升势弱压力 / 降势弱支撑：strength < 0.42 丢弃  
- range：strength≥0.34 且 touches≥2 且 coverage≥0.1  
- 其他：strength≥0.34  

绘制门槛 strength ≥ **0.32**。

---

## 6. 图表形态

入口：`detectChartPatterns`。形态集（**不加新形态**）：

| id | 名称 |
|----|------|
| double-top / double-bottom | 双顶 / 双底 |
| head-shoulders / inv-head-shoulders | 头肩顶 / 头肩底 |
| triangle-sym / triangle-asc / triangle-desc | 对称 / 上升 / 下降三角 |
| rectangle | 箱体 |
| bull-flag / bear-flag | 旗形 |

检出后：右端年龄 ≤ 45 → 按 status 优先级 + 新近度 + 分排序 → 最多 **1** 个。

检测器输出的分为 **几何 baseScore**；最终展示分由 §8 Score Explain 再算。

### 6.1 生命周期 status（统一语义）

| status | 含义 |
|--------|------|
| `forming` | 结构在，未确认突破 |
| `confirmed` | 有效突破/确认 |
| `failed` | 短期失败（破后收回等） |
| `invalidated` | 结构彻底破坏 |

status 排序权：confirmed(4) > forming(3) > failed(2) > invalidated(1)。

### 6.2 双顶（双底对称）

**候选高点：** 近 70 根、strength≥0.35，取末 8 个；从新到旧配对。

**几何条件：**

| 条件 | 计算 |
|------|------|
| 分离度 | `5 ≤ h2.index−h1.index ≤ 50` |
| 等高 | `|H1−H2| ≤ levelTol×1.1` |
| 中间谷 | lows 中 (h1,h2) 最低 |
| 深度 | `depth = max(H)−valley ≥ levelTol×1.5` |
| 颈线 | `neckline = valley.price` |
| 右端年龄 | ≤45；失败态若距今 >25 丢弃 |

**状态：**

| 状态 | 条件 |
|------|------|
| confirmed | `C < neckline − breakTol×0.5` |
| everBroken | 第二顶后曾破颈线 |
| invalidated | `C > peak + breakTol×0.3` |
| failed | everBroken 且未 confirmed 且未 invalid 且在颈线上方附近 |
| forming | approaching：`C < peak − depth×0.35` 且非上述失败态 |

**几何分 conf（截断 20–92）：**

```text
conf ≈ 52
  + 等高项 ×15
  + (depth/peak)×100×0.7
  + confirmed? +14 : 0
  + failed? −12 : 0
  + invalidated? −22 : 0
  + 两峰 strength 均值 ×8
  + 新近度 max(0, 6 − age×0.2)
```

目标价：双顶 `neckline − depth`；双底 `neckline + height`。

### 6.3 头肩顶 / 头肩底

- 三高/三低 strength≥0.35，头显著高于/低于肩，两肩高差 ≤ levelTol×1.8  
- 颈线 = 两肩间谷/峰均值  
- 高度 ≥ levelTol×2  

**状态（顶为例）：**

| 状态 | 条件 |
|------|------|
| confirmed | 收破颈线 |
| invalidated | 重回右肩上方 |
| failed | 曾破颈又收回 |
| forming | approaching 近右肩高度区域 |

几何分约：`55 + (height/head)×180 + 确认加成 − 失效惩罚`。

### 6.4 三角

近窗 swing 高低做线性拟合；要求整体跨度 **12–55** 根；必须 **收敛**（早期宽度 > 后期 ×0.85 等）。

| 子类 | 条件近似 |
|------|----------|
| 上升三角 | 上沿近似平坦 + 下沿上升 |
| 下降三角 | 下沿平坦 + 上沿下降 |
| 对称三角 | 上降下升 |

```text
conf ≈ 48 + shrink×38 + min(6, span/10)
```

突破加 8；破后收回 → failed；反向贯穿对侧 → invalidated。

### 6.5 箱体

近 40 根：上下沿方差 ≤ levelTol×1.2，高度在 `(ATR×1.5, ATR×8)` 之间。

破上下沿 → confirmed；破后收回区间 → failed；反向穿越全箱 → invalidated。

### 6.6 旗形

- 旗杆：约 20→8 根前 close 变化幅度 ≥ ATR×3  
- 旗面：末端约 8 根振幅 < |旗杆|×0.55 且 > levelTol  
- 旗面长度 **4–16** 根  

多头旗：杆上涨 + 旗面不猛涨；空头相反。  
上破/下破旗面 → confirmed；反向破旗 → invalidated；旗面横盘过久 → failed。

---

## 7. 突破 Breakout

入口：`detectBreakouts`；再 `gradeBreakout` + 假突破复核。

### 7.1 触发（近 12 根）

对每根 i，量比 `volRatio = V_i / avgVol20`。

**上破阻力/枢纽：**

```text
prev.close ≤ upper + breakTol×0.15
C_i > upper + breakTol×0.35
C_i > prev.close
```

**下破支撑/枢纽：** 符号对称。

**趋势线：** 使用 `markTrendBreak` 的 breakIndex 直接记一条。

### 7.2 质量 quality

| quality | 条件 |
|---------|------|
| **strong** | volRatio≥1.5 且（次日仍在突破侧 **或** volRatio≥2） |
| **normal** | volRatio≥1.15 |
| **weak** | 否则 |
| **false** | 见 7.4（覆盖前三类） |

`volumeConfirmed = volRatio ≥ 1.15`。

### 7.3 阶段 phase（回踩）

窗口：`retestWindow = min(falseWindow+3, 剩余根数)`。

**上破后回踩：** 某根 `low ≤ level+touchTol` 且 `close ≥ level−touchTol×0.5` → 记 `retestIndex`。

- 之后再出现 `close > level + breakTol×0.3` → **continue**  
- 仅回踩未延续 → **retest**  
- 无回踩 → **break**  

### 7.4 假突破

在 `falseWindow` 内：

- 上破后 `close < level − touchTol×0.5`  
- 或下破后 `close > level + touchTol×0.5`  

→ quality=`false`，phase 重置为 `break`。

### 7.5 去重与排序

同向且 index 差 ≤2 合并；排序 quality strong>normal>weak>false，再按时间。

市态过滤：range 丢 weak；volatility 弱突破加「高波慎用」文案。最终按 phase continue>retest>break，最多 3。

### 7.6 画布标记含义

| 图元 | 含义 |
|------|------|
| × 灰叉 | 假突破 |
| 空心三角 | 弱突破 |
| 实心三角 | 普通/强突破（强破稍大） |
| 空心圆 | 回踩日（retest） |
| 实心圆 | 回踩后延续（continue） |
| 金色小圆 | 主形态关键点（非突破） |

---

## 8. Score Explain（可解释结构分 · **非胜率**）

入口：`scorePatterns`。  
**禁止**把 `score` 理解成胜率或「未来 N 日突破概率」。

### 8.1 四维 0–100

| 维 | 权重 | 计算 |
|----|------|------|
| **geometric** | 0.55 | 检测器 baseScore（截断 1–100） |
| **volume** | 0.12 | 形态末端最多 5 根均量 / 20 日均量 → `28 + ratio×28`，截断 20–94 |
| **location** | 0.13 | 颈线或关键点相对最近 S/R 距离（%）：≤0.4→86 … >9→30；顺结构 +6；recent 区 +3 |
| **lifecycle** | 0.20 | confirmed 88 / forming 62 / failed 34 / invalidated 18 |

### 8.2 突破共振 bonus（0/2/3/5）

形态结束附近同向非假突破：

| 情景 | bonus |
|------|-------|
| continue + strong | +5 |
| retest 或 strong | +3 |
| 一般 break | +2 |

### 8.3 最终分

```text
blended = 0.55G + 0.12V + 0.13L + 0.20C  + bonus
blended = clamp(1, 100, blended)

regimeFactor ∈ {0.8, 1.0, 1.15}   # 见 8.4
score = clamp(1, 99, round(blended × regimeFactor))
confidence === score
```

面板示意：

```text
结构评分 72 = 几何64·量58·位70·态62 ×1.15
几何 64 · 量能 58 · 位置 70 · 状态 已确认(88) · 市态匹配 ×1.15
```

### 8.4 形态的 regimeFactor

| 市态 | 1.15（match） | 0.8（mismatch） |
|------|---------------|-----------------|
| range | 双顶底/箱体/头肩 | 旗/三角 |
| trend | **方向一致**的顺势形态 | 反转类（双顶底/头肩）等 |
| volatility | 旗/三角/箱体 | 反转类 |

### 8.5 形态展示过滤（applyRegimeWeights）

| 规则 | 行为 |
|------|------|
| invalidated | 仅当 blended≥55 才保留 |
| failed 且 score<52 | 丢弃 |
| range 下弱旗/三角 score<54 | 丢弃 |
| trend 下弱逆势反转 | 丢弃 |
| forming 且 base<50 且 score<56 | 丢弃 |
| 其余 | score≥50 或 confirmed |

最终最多 **1** 个形态。

---

## 9. 汇总文案与 meta

### 9.1 buildSummary

拼接（有则加）：

1. `市态 {label}{↑/↓}({strength})`  
2. 主形态：名 + 状态 + 偏多空 + 评分 + 几何  
3. 最近 1–2 支撑 / 阻力中心价  
4. 有效趋势线条数  
5. 近期上破/下破或假突破痕迹  

全空时：`现价 … 暂无明显结构，关注附近支撑阻力区`。

### 9.2 meta 字段

| 字段 | 含义 |
|------|------|
| atr / atrPeriod | 见 §1 |
| levelTol / touchTol / breakTol | 见 §1 |
| period | daily \| weekly |
| falseWindow | 见 §1.4 |
| volPct | ATR/Price |

---

## 10. 可视化优先级（`stockDetailPanel`）

```text
S/R 色带与中心线（底层）
  → 趋势线（中层）
    → K 线 / MA
      → 形态关键点圆 / 颈线 / 左上角结构评分 chip
        → 突破三角 / 叉 / 回踩圆（顶层）
```

量程：仅把「靠近当前高低下跌」的少量 S/R / 颈线纳入 scale，避免远端价位压扁图。

---

## 11. 刻意未做 / 后续

1. **回测校准** score 阈值与经验概率（概率只能来自统计，禁止规则硬算）  
2. 行业/标签股票类型（当前仅 **本序列 volPct**）  
3. 点击固定详情面板等交互增强  

---

仅供参考，不构成投资建议。阈值与权重以 `src/analysis/patternRecognition.ts` 源码为准；若文档与代码冲突，以代码为准。
