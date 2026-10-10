import { BillingCycle, NodeCoreConfig, NodeForecastData, ThresholdMode, TrafficRecord } from "./types";

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * 从 Komari 节点的 expired_at 字段中提取每月的账单重置日 (Day of Month: 1 - 31)
 */
export function formatDateToYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 从 Komari 节点的 expired_at 字段中提取每月的账单重置日 (Day of Month: 1 - 31)
 */
export function extractResetDayFromExpiredAt(
  expiredAt?: string | number | null,
  fallbackResetDay: number = 1
): {
  resetDay: number;
  hasExpiredAt: boolean;
  expiredAtStr?: string;
  desc: string;
} {
  if (!expiredAt) {
    return {
      resetDay: Math.max(1, Math.min(31, fallbackResetDay || 1)),
      hasExpiredAt: false,
      desc: "自然月 1 号 (未设置到期日)",
    };
  }

  try {
    let day = 0;
    let dateStr = "";

    // 优先从日期字符串中直接正则匹配 (YYYY-MM-DD 或 YYYY/MM/DD)，防止时区转换引起的日期 -1 偏移
    if (typeof expiredAt === "string") {
      const match = expiredAt.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
      if (match) {
        const y = match[1];
        const m = match[2].padStart(2, "0");
        const d = match[3].padStart(2, "0");
        day = parseInt(d, 10);
        dateStr = `${y}-${m}-${d}`;
      }
    }

    if (!day) {
      let dateObj: Date;
      if (typeof expiredAt === "number") {
        dateObj = expiredAt > 10000000000 ? new Date(expiredAt) : new Date(expiredAt * 1000);
      } else {
        dateObj = new Date(String(expiredAt));
      }

      if (isNaN(dateObj.getTime())) {
        return {
          resetDay: fallbackResetDay || 1,
          hasExpiredAt: false,
          desc: "自然月 1 号 (到期时间格式无效)",
        };
      }

      // 叠加配置时区偏移得到准确的到期日
      const tzDate = new Date(dateObj.getTime() + Number(tzOffsetHours) * 3600 * 1000);
      day = tzDate.getUTCDate();
      dateStr = tzDate.toISOString().split("T")[0];
    }

    if (day >= 1 && day <= 31) {
      return {
        resetDay: day,
        hasExpiredAt: true,
        expiredAtStr: dateStr,
        desc: `每月 ${day} 号 (同步自节点到期日: ${dateStr})`,
      };
    }

    return {
      resetDay: fallbackResetDay || 1,
      hasExpiredAt: false,
      desc: "自然月 1 号",
    };
  } catch (e) {
    return {
      resetDay: fallbackResetDay || 1,
      hasExpiredAt: false,
      desc: "自然月 1 号",
    };
  }
}

/**
 * 根据计费模式计算计费流量数值
 */
export function computeBillableAmount(inBytes: number, outBytes: number, mode: string = "sum"): number {
  const m = (mode || "sum").toLowerCase();
  switch (m) {
    case "upload":
    case "up":
      return outBytes;
    case "download":
    case "down":
      return inBytes;
    case "max":
      return Math.max(inBytes, outBytes);
    case "min":
      return Math.min(inBytes, outBytes);
    case "sum":
    default:
      return inBytes + outBytes;
  }
}

/**
 * 计算账单周期范围
 * @param resetDay 每月重置日 (1-31)
 * @param now 当前时间
 */
export function getTzDateParts(now: Date = new Date(), tzOffsetHours: number = 8) {
  const tzOffsetMs = Number(tzOffsetHours) * 3600 * 1000;
  const d = new Date(now.getTime() + tzOffsetMs);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    date: d.getUTCDate(),
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    seconds: d.getUTCSeconds(),
    dateStr: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
  };
}

/**
 * 计算账单周期范围 (支持用户自定义时区偏移，彻底规避宿主机/容器时区干扰)
 */
export function calculateBillingCycle(resetDay: number = 1, now: Date = new Date(), tzOffsetHours: number = 8): BillingCycle {
  const tzParts = getTzDateParts(now, tzOffsetHours);
  const currentYear = tzParts.year;
  const currentMonth = tzParts.month;
  const currentDate = tzParts.date;

  const safeResetDay = Math.max(1, Math.min(31, Math.floor(resetDay || 1)));
  const maxDayThisMonth = getDaysInMonth(currentYear, currentMonth);
  const actualResetDayThisMonth = Math.min(safeResetDay, maxDayThisMonth);

  let cycleStartYear: number, cycleStartMonth: number, cycleStartDay: number;
  let cycleEndYear: number, cycleEndMonth: number, cycleEndDay: number;

  if (currentDate >= actualResetDayThisMonth) {
    cycleStartYear = currentYear;
    cycleStartMonth = currentMonth;
    cycleStartDay = actualResetDayThisMonth;

    const nextMonthYear = currentMonth === 11 ? currentYear + 1 : currentYear;
    const nextMonth = currentMonth === 11 ? 0 : currentMonth + 1;
    const maxDayNextMonth = getDaysInMonth(nextMonthYear, nextMonth);
    cycleEndYear = nextMonthYear;
    cycleEndMonth = nextMonth;
    cycleEndDay = Math.min(safeResetDay, maxDayNextMonth);
  } else {
    const prevMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;
    const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const maxDayPrevMonth = getDaysInMonth(prevMonthYear, prevMonth);
    cycleStartYear = prevMonthYear;
    cycleStartMonth = prevMonth;
    cycleStartDay = Math.min(safeResetDay, maxDayPrevMonth);

    cycleEndYear = currentYear;
    cycleEndMonth = currentMonth;
    cycleEndDay = actualResetDayThisMonth;
  }

  const tzMs = Number(tzOffsetHours) * 3600 * 1000;
  const cycleStartUtcMs = Date.UTC(cycleStartYear, cycleStartMonth, cycleStartDay, 0, 0, 0, 0) - tzMs;
  const cycleEndUtcMs = Date.UTC(cycleEndYear, cycleEndMonth, cycleEndDay, 0, 0, 0, 0) - tzMs;

  const cycleStartDate = new Date(cycleStartUtcMs);
  const cycleEndDate = new Date(cycleEndUtcMs);

  const oneDayMs = 24 * 60 * 60 * 1000;
  const daysTotal = Math.max(1, Math.round((cycleEndUtcMs - cycleStartUtcMs) / oneDayMs));
  const daysElapsed = Math.max(1, Math.min(daysTotal, Math.ceil((now.getTime() - cycleStartUtcMs) / oneDayMs)));
  const daysRemaining = Math.max(0, daysTotal - daysElapsed);

  const pad2 = (n: number) => String(n).padStart(2, "0");
  const cycleStartStr = `${cycleStartYear}-${pad2(cycleStartMonth + 1)}-${pad2(cycleStartDay)}`;
  const cycleEndStr = `${cycleEndYear}-${pad2(cycleEndMonth + 1)}-${pad2(cycleEndDay)}`;

  return {
    cycleStart: cycleStartStr,
    cycleEnd: cycleEndStr,
    cycleStartDate,
    cycleEndDate,
    daysTotal,
    daysElapsed,
    daysRemaining,
  };
}

/**
 * 格式化字节大小为可读字符串
 */
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  const idx = Math.min(i, sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, idx)).toFixed(dm)) + " " + sizes[idx];
}

/**
 * 计费模式简要名称映射
 */
export function getThresholdModeLabel(mode: string = "sum"): string {
  const m = (mode || "sum").toLowerCase();
  switch (m) {
    case "upload":
    case "up":
      return "仅出站 (Upload)";
    case "download":
    case "down":
      return "仅入站 (Download)";
    case "max":
      return "双向取大 (MAX)";
    case "min":
      return "双向取小 (MIN)";
    case "sum":
    default:
      return "双向求和 (SUM)";
  }
}

/**
 * 计算单个节点的流量预测与预警信息（严格采用真实数据）
 */
export function calculateNodeForecast(
  history: TrafficRecord[],
  node: NodeCoreConfig,
  warningThresholdPercent: number = 90,
  now: Date = new Date(),
  tzOffsetHours: number = 8
): NodeForecastData {
  // 从核心节点的 expired_at 提取账单重置日（若未设置则按自然月 1 号）
  const extracted = extractResetDayFromExpiredAt(node.expired_at, Number(node.traffic_reset_day) || 1, tzOffsetHours);
  const resetDay = extracted.resetDay;
  const cycle = calculateBillingCycle(resetDay, now, tzOffsetHours);
  const cycleStartMs = cycle.cycleStartDate.getTime();

  const mode = (node.traffic_limit_type || "sum") as ThresholdMode;

  // 1. 获取当月真实的累计流量：优先使用 Komari 原生上报的真实累计计数器（保证与 Komari 实例页 100% 对齐）
  const rawTotalUp = Number(
    node.net_total_up ?? 
    node.network?.totalUp ?? 
    node.total_up ?? 
    node.totalUp ?? 
    0
  );
  const rawTotalDown = Number(
    node.net_total_down ?? 
    node.network?.totalDown ?? 
    node.total_down ?? 
    node.totalDown ?? 
    0
  );

  let cumulativeIn = 0;
  let cumulativeOut = 0;

  if (rawTotalUp > 0 || rawTotalDown > 0) {
    // 真实累计计数器存在，直接采用真实数据
    cumulativeIn = rawTotalDown;
    cumulativeOut = rawTotalUp;
  } else {
    // 仅在核心未上报累计计数器时，按本周期实际采样累加（无数据则保持为 0）
    for (const r of history || []) {
      if (r.timestamp >= cycleStartMs && r.timestamp <= now.getTime()) {
        cumulativeIn += r.in_bytes || 0;
        cumulativeOut += r.out_bytes || 0;
      }
    }
  }

  const cumulativePhysicalTotal = cumulativeIn + cumulativeOut;
  const cumulativeBillable = computeBillableAmount(cumulativeIn, cumulativeOut, mode);

  // 2. 计算日均增量：优先参考近 7 天真实打点增量；若无历史打点记录，根据本周期真实已用流量和已过天数推算均速
  let dailyAvgIn = 0;
  let dailyAvgOut = 0;

  // 2. 计算日均增量：优先参考过去（不包含尚未完整的今日）真实打点增量；
  // 若无过去历史打点记录（如插件安装首日），严格根据本周期真实已用流量和已过天数推算均速
  const validPastDays = (history || []).filter(r => !r.is_today && (r.in_bytes || 0) + (r.out_bytes || 0) > 0).slice(-7);

  if (validPastDays.length > 0) {
    let weightSum = 0;
    let weightedInSum = 0;
    let weightedOutSum = 0;

    validPastDays.forEach((record, index) => {
      const weight = 1 + (index / validPastDays.length) * 1.2;
      weightedInSum += (record.in_bytes || 0) * weight;
      weightedOutSum += (record.out_bytes || 0) * weight;
      weightSum += weight;
    });

    dailyAvgIn = Math.round(weightedInSum / weightSum);
    dailyAvgOut = Math.round(weightedOutSum / weightSum);
  } else if (cycle.daysElapsed > 0 && cumulativePhysicalTotal > 0) {
    // 严格按真实累计值与已过天数求均速，绝无随机数
    dailyAvgIn = Math.round(cumulativeIn / cycle.daysElapsed);
    dailyAvgOut = Math.round(cumulativeOut / cycle.daysElapsed);
  } else {
    const todayRec = (history || []).find(r => r.is_today);
    dailyAvgIn = todayRec ? (todayRec.in_bytes || 0) : 0;
    dailyAvgOut = todayRec ? (todayRec.out_bytes || 0) : 0;
  }

  const dailyAvgTotal = dailyAvgIn + dailyAvgOut;
  const dailyAvgBillable = computeBillableAmount(dailyAvgIn, dailyAvgOut, mode);

  // 3. 周期末预测到达量
  const projectedIn = cumulativeIn + dailyAvgIn * cycle.daysRemaining;
  const projectedOut = cumulativeOut + dailyAvgOut * cycle.daysRemaining;
  const projectedPhysicalTotal = cumulativePhysicalTotal + dailyAvgTotal * cycle.daysRemaining;
  const projectedBillable = computeBillableAmount(projectedIn, projectedOut, mode);

  // 4. 配额与状态评估
  const rawQuota = Number(node.traffic_limit) || 0;
  const hasQuota = rawQuota > 0;

  let status: "SAFE" | "WARNING" | "CRITICAL" | "NO_QUOTA" = "NO_QUOTA";
  let usageRatio = 0;
  let daysUntilExhaustion: number | undefined;
  let exhaustionDate: string | undefined;
  let warningMessage: string | undefined;

  if (!hasQuota) {
    status = "NO_QUOTA";
  } else {
    usageRatio = projectedBillable / rawQuota;
    const modeBadge = getThresholdModeLabel(mode);

    if (cumulativeBillable >= rawQuota) {
      status = "CRITICAL";
      daysUntilExhaustion = 0;
      exhaustionDate = now.toISOString().split("T")[0];
      warningMessage = `已超出流量限额 (${formatBytes(cumulativeBillable)} / ${formatBytes(rawQuota)})，超额 ${formatBytes(cumulativeBillable - rawQuota)}！`;
    } else if (projectedBillable >= rawQuota) {
      status = "CRITICAL";
      const remainingQuota = rawQuota - cumulativeBillable;
      daysUntilExhaustion = dailyAvgBillable > 0 ? Math.max(1, Math.floor(remainingQuota / dailyAvgBillable)) : 999;
      const exDateObj = new Date(now.getTime() + daysUntilExhaustion * 24 * 60 * 60 * 1000);
      exhaustionDate = exDateObj.toISOString().split("T")[0];
      const overage = projectedBillable - rawQuota;
      warningMessage = `预计将在 ${daysUntilExhaustion} 天后（${exhaustionDate}）耗尽限额（按 ${modeBadge} 计费），重置日前预计超标 ${formatBytes(overage)}！`;
    } else if (usageRatio >= warningThresholdPercent / 100) {
      status = "WARNING";
      warningMessage = `预计在重置日将消耗 ${(usageRatio * 100).toFixed(1)}% 的计费流量，接近告警阈值 (${warningThresholdPercent}%)。`;
    } else {
      status = "SAFE";
      warningMessage = `流量在安全预算内，预计重置日使用率为 ${(usageRatio * 100).toFixed(1)}%，剩余可用计费流量约 ${formatBytes(rawQuota - projectedBillable)}。`;
    }
  }

  // 5. 构建账单周期时间序列与预测序列 (以 [cycleStart, cycleEnd] 为严格左右边界)
  const chartSeries = buildCycleSeries(history, mode, cycle, dailyAvgIn, dailyAvgOut, cumulativeBillable, cumulativeIn, cumulativeOut, now, tzOffsetHours);

  return {
    node_id: node.uuid,
    node_name: node.name || node.uuid,
    tags: node.tags,
    group: node.group,
    has_quota: hasQuota,
    traffic_limit_bytes: rawQuota,
    traffic_limit_formatted: hasQuota ? formatBytes(rawQuota) : "未设置限额",
    traffic_limit_type: mode,
    has_expired_at: extracted.hasExpiredAt,
    expired_at_raw: node.expired_at,
    expired_at_str: extracted.expiredAtStr,
    traffic_reset_day: resetDay,
    reset_day_desc: extracted.desc,
    cycle,
    cumulative: {
      in_bytes: cumulativeIn,
      out_bytes: cumulativeOut,
      physical_total: cumulativePhysicalTotal,
      billable_bytes: cumulativeBillable,
      in_formatted: formatBytes(cumulativeIn),
      out_formatted: formatBytes(cumulativeOut),
      physical_formatted: formatBytes(cumulativePhysicalTotal),
      billable_formatted: formatBytes(cumulativeBillable),
    },
    daily_avg: {
      in_bytes: dailyAvgIn,
      out_bytes: dailyAvgOut,
      total_bytes: dailyAvgTotal,
      billable_bytes: dailyAvgBillable,
      total_formatted: formatBytes(dailyAvgTotal),
      billable_formatted: formatBytes(dailyAvgBillable),
    },
    projected: {
      in_bytes: projectedIn,
      out_bytes: projectedOut,
      physical_total: projectedPhysicalTotal,
      billable_bytes: projectedBillable,
      physical_formatted: formatBytes(projectedPhysicalTotal),
      billable_formatted: formatBytes(projectedBillable),
    },
    usage_ratio: usageRatio,
    status,
    days_until_exhaustion: daysUntilExhaustion,
    exhaustion_date: exhaustionDate,
    warning_message: warningMessage,
    chart_series: chartSeries,
  };
}

/**
 * 构建以当前账单周期为时间域的时间序列 (X 轴以 [cycleStart, cycleEnd] 为严格左右边界)
 * - X 轴左侧：上个重置日 (cycleStart)，理论累计从 0 开始
 * - X 轴右侧：下个重置日 (cycleEnd)，预测折线平滑延伸至此
 * - 过去无数据天：cumulative_billable 为 null，不画 0 贴地折线
 * - 未来推算天：in_bytes / out_bytes 严格为 0，坚决不画任何柱体！
 */
export function buildCycleSeries(
  history: TrafficRecord[],
  mode: ThresholdMode,
  cycle: BillingCycle,
  dailyAvgIn: number,
  dailyAvgOut: number,
  currentCycleBillable: number,
  cumulativeIn: number = 0,
  cumulativeOut: number = 0,
  now: Date = new Date()
): TrafficRecord[] {
  const historyMap = new Map<string, TrafficRecord>();
  for (const item of history || []) {
    if (item.date) {
      historyMap.set(item.date, item);
    }
  }

  const points: TrafficRecord[] = [];
  const cycleStart = cycle.cycleStartDate;
  const daysTotal = cycle.daysTotal;
  const todayStr = formatDateToYMD(now);
  const nowMs = now.getTime();

  let runningIn = 0;
  let runningOut = 0;
  let todayIndex = -1;

  for (let i = 0; i <= daysTotal; i++) {
    const d = new Date(cycleStart.getTime() + i * 24 * 3600 * 1000);
    const dateStr = formatDateToYMD(d);
    const isToday = (dateStr === todayStr);
    const isPast = (d.getTime() < nowMs) && !isToday;

    if (isToday) {
      todayIndex = i;
    }

    const rec = historyMap.get(dateStr);

    if (isPast) {
      if (rec && ((rec.in_bytes || 0) + (rec.out_bytes || 0) > 0)) {
        runningIn += (rec.in_bytes || 0);
        runningOut += (rec.out_bytes || 0);
        const cumBillable = computeBillableAmount(runningIn, runningOut, mode);
        points.push({
          date: dateStr,
          timestamp: d.getTime(),
          has_data: true,
          in_bytes: rec.in_bytes || 0,
          out_bytes: rec.out_bytes || 0,
          total_bytes: (rec.in_bytes || 0) + (rec.out_bytes || 0),
          cumulative_bytes: runningIn + runningOut,
          cumulative_billable: cumBillable,
          is_today: false,
          is_forecast: false,
        });
      } else {
        // 过去无打点数据（如冷启动安装前）：绝不输出 0 贴地折线，cumulative_billable 为 null
        points.push({
          date: dateStr,
          timestamp: d.getTime(),
          has_data: false,
          in_bytes: 0,
          out_bytes: 0,
          total_bytes: 0,
          cumulative_bytes: 0,
          cumulative_billable: null,
          is_today: false,
          is_forecast: false,
        });
      }
    } else if (isToday) {
      const inB = rec ? (rec.in_bytes || 0) : 0;
      const outB = rec ? (rec.out_bytes || 0) : 0;
      points.push({
        date: dateStr,
        timestamp: d.getTime(),
        has_data: true,
        in_bytes: inB,
        out_bytes: outB,
        total_bytes: inB + outB,
        cumulative_bytes: cumulativeIn + cumulativeOut,
        cumulative_billable: currentCycleBillable,
        is_today: true,
        is_forecast: false,
      });
    } else {
      // 未来推算点：严格不画柱体 (in_bytes=0, out_bytes=0)，虚线平滑延伸至周期结束日
      const dailyForecastBillable = computeBillableAmount(dailyAvgIn, dailyAvgOut, mode);
      const futureStep = i - (todayIndex >= 0 ? todayIndex : cycle.daysElapsed);
      const fCumBillable = currentCycleBillable + dailyForecastBillable * Math.max(0, futureStep);

      points.push({
        date: dateStr,
        timestamp: d.getTime(),
        has_data: false,
        in_bytes: 0,
        out_bytes: 0,
        total_bytes: 0,
        cumulative_bytes: fCumBillable,
        cumulative_billable: fCumBillable,
        is_today: false,
        is_forecast: true,
      });
    }
  }

  return points;
}

// 保持向下兼容导出
export const build30DaySeries = buildCycleSeries;
