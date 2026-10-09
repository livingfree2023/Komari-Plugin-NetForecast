/**
 * Komari Plugin: NetForecast (网络流量预测与限额预警)
 * Entry script for Komari Goja JS runtime (严格真实数据模式，杜绝假数据)
 */

const server = require("server");
let fs;
let path;
try {
  fs = require("fs");
  path = require("path");
} catch (e) {
  // node compat module fallback
}

function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  const idx = Math.min(i, sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, idx)).toFixed(dm)) + " " + sizes[idx];
}

function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * 计费模式简要名称映射
 */
function getThresholdModeLabel(mode) {
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
 * 根据计费模式计算计费流量数值
 */
function computeBillableAmount(inBytes, outBytes, mode = "sum") {
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

function formatDateToYMD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 计算账单周期范围
 */
function calculateBillingCycle(resetDay = 1, now = new Date()) {
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentDate = now.getDate();

  const safeResetDay = Math.max(1, Math.min(31, Math.floor(Number(resetDay) || 1)));

  // 当前月的实际月末重置日（例如 4 月是 30，2 月是 28 或 29，防止设置 31 号的节点在小月末无法进入新周期）
  const maxDayThisMonth = getDaysInMonth(currentYear, currentMonth);
  const actualResetDayThisMonth = Math.min(safeResetDay, maxDayThisMonth);

  let cycleStartDate;
  let cycleEndDate;

  if (currentDate >= actualResetDayThisMonth) {
    cycleStartDate = new Date(currentYear, currentMonth, actualResetDayThisMonth, 0, 0, 0, 0);

    const nextMonthYear = currentMonth === 11 ? currentYear + 1 : currentYear;
    const nextMonth = currentMonth === 11 ? 0 : currentMonth + 1;
    const maxDayNextMonth = getDaysInMonth(nextMonthYear, nextMonth);
    const actualEndDay = Math.min(safeResetDay, maxDayNextMonth);
    cycleEndDate = new Date(nextMonthYear, nextMonth, actualEndDay, 0, 0, 0, 0);
  } else {
    const prevMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;
    const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const maxDayPrevMonth = getDaysInMonth(prevMonthYear, prevMonth);
    const actualStartDay = Math.min(safeResetDay, maxDayPrevMonth);
    cycleStartDate = new Date(prevMonthYear, prevMonth, actualStartDay, 0, 0, 0, 0);

    cycleEndDate = new Date(currentYear, currentMonth, actualResetDayThisMonth, 0, 0, 0, 0);
  }

  const oneDayMs = 24 * 60 * 60 * 1000;
  const daysTotal = Math.max(1, Math.round((cycleEndDate.getTime() - cycleStartDate.getTime()) / oneDayMs));
  const daysElapsed = Math.max(1, Math.min(daysTotal, Math.ceil((now.getTime() - cycleStartDate.getTime()) / oneDayMs)));
  const daysRemaining = Math.max(0, daysTotal - daysElapsed);

  return {
    cycleStart: formatDateToYMD(cycleStartDate),
    cycleEnd: formatDateToYMD(cycleEndDate),
    cycleStartDate,
    cycleEndDate,
    daysTotal,
    daysElapsed,
    daysRemaining,
  };
}

/**
 * 历史与预测时间序列构建（真实按日打点，无数据即为 0，绝不伪造）
 */
/**
 * 构建以当前账单周期为时间域的时间序列 (X 轴以 [cycleStart, cycleEnd] 为严格左右边界)
 * - X 轴左侧：上个重置日 (cycleStart)，理论累计从 0 开始
 * - X 轴右侧：下个重置日 (cycleEnd)，预测折线平滑延伸至此
 * - 过去无数据天：cumulative_billable 为 null，不画 0 贴地折线
 * - 未来推算天：in_bytes / out_bytes 严格为 0，坚决不画任何柱体！
 */
function buildCycleSeries(history, mode, cycle, dailyAvgIn, dailyAvgOut, currentCycleBillable, cumulativeIn = 0, cumulativeOut = 0, now = new Date()) {
  const historyMap = {};
  (history || []).forEach((item) => {
    if (item.date) {
      historyMap[item.date] = item;
    }
  });

  const points = [];
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
    const isFuture = (d.getTime() > nowMs) && !isToday;

    if (isToday) {
      todayIndex = i;
    }

    const rec = historyMap[dateStr];

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

const build30DaySeries = buildCycleSeries;

/**
 * 从 Komari 节点的 expired_at 字段中提取每月的账单重置日 (Day of Month: 1 - 31)
 */
function extractResetDayFromExpiredAt(expiredAt, fallbackResetDay = 1) {
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
      let dateObj;
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

      // 如果时间戳接近 UTC 零点，在西区使用 UTC 日期能更忠实还原配置日
      day = dateObj.getUTCDate();
      dateStr = dateObj.toISOString().split("T")[0];
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
 * 核心预测与状态推算（严格使用真实数据，绝不构造假数据）
 */
function calculateNodeForecast(history, node, warningThresholdPercent = 90, now = new Date()) {
  const extracted = extractResetDayFromExpiredAt(node.expired_at, Number(node.traffic_reset_day) || 1);
  const resetDay = extracted.resetDay;
  const cycle = calculateBillingCycle(resetDay, now);
  const cycleStartMs = cycle.cycleStartDate.getTime();

  const mode = (node.traffic_limit_type || "sum");

  // 1. 获取当月真实的累计流量：优先使用 Komari 原生上报的真实累计计数器（保证与 Komari 实例页完全对齐）
  const rawTotalUp = Number(
    node.net_total_up !== undefined ? node.net_total_up :
    (node.network && node.network.totalUp !== undefined ? node.network.totalUp :
    (node.total_up !== undefined ? node.total_up :
    (node.totalUp !== undefined ? node.totalUp : 0)))
  );
  const rawTotalDown = Number(
    node.net_total_down !== undefined ? node.net_total_down :
    (node.network && node.network.totalDown !== undefined ? node.network.totalDown :
    (node.total_down !== undefined ? node.total_down :
    (node.totalDown !== undefined ? node.totalDown : 0)))
  );

  let cumulativeIn = 0;
  let cumulativeOut = 0;

  if (rawTotalUp > 0 || rawTotalDown > 0) {
    cumulativeIn = rawTotalDown;
    cumulativeOut = rawTotalUp;
  } else {
    (history || []).forEach((r) => {
      if (r.timestamp >= cycleStartMs && r.timestamp <= now.getTime()) {
        cumulativeIn += r.in_bytes || 0;
        cumulativeOut += r.out_bytes || 0;
      }
    });
  }

  const cumulativePhysicalTotal = cumulativeIn + cumulativeOut;
  const cumulativeBillable = computeBillableAmount(cumulativeIn, cumulativeOut, mode);

  // 2. 7 天移动平均日均增量（优先使用过去已完整天数的真实打点增量，无记录时根据真实累计和已过天数推算均速）
  const validPastDays = (history || []).filter((r) => !r.is_today && (r.in_bytes || 0) + (r.out_bytes || 0) > 0).slice(-7);
  let dailyAvgIn = 0;
  let dailyAvgOut = 0;

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
    dailyAvgIn = Math.round(cumulativeIn / cycle.daysElapsed);
    dailyAvgOut = Math.round(cumulativeOut / cycle.daysElapsed);
  } else {
    const todayRec = (history || []).find((r) => r.is_today);
    dailyAvgIn = todayRec ? (todayRec.in_bytes || 0) : 0;
    dailyAvgOut = todayRec ? (todayRec.out_bytes || 0) : 0;
  }

  const dailyAvgTotal = dailyAvgIn + dailyAvgOut;
  const dailyAvgBillable = computeBillableAmount(dailyAvgIn, dailyAvgOut, mode);

  const projectedIn = cumulativeIn + dailyAvgIn * cycle.daysRemaining;
  const projectedOut = cumulativeOut + dailyAvgOut * cycle.daysRemaining;
  const projectedPhysicalTotal = cumulativePhysicalTotal + dailyAvgTotal * cycle.daysRemaining;
  const projectedBillable = computeBillableAmount(projectedIn, projectedOut, mode);

  const rawQuota = Number(node.traffic_limit) || 0;
  const hasQuota = rawQuota > 0;

  let status = "NO_QUOTA";
  let usageRatio = 0;
  let daysUntilExhaustion = undefined;
  let exhaustionDate = undefined;
  let warningMessage = undefined;

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

  const chartSeries = buildCycleSeries(history, mode, cycle, dailyAvgIn, dailyAvgOut, cumulativeBillable, cumulativeIn, cumulativeOut, now);

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

// 纯时序流量存储（只存流量采样统计，无数据就返回空，绝不伪造种子数据）
class TrafficStorage {
  constructor() {
    this.baseDir = typeof __storageDir__ !== "undefined" && __storageDir__ ? __storageDir__ : "data/plugin-data/net-forecast";
    this.trafficFile = path ? path.join(this.baseDir, "traffic_records.json") : this.baseDir + "/traffic_records.json";
    this.trafficCache = {};
    this.lastCounters = {};
    this.load();
  }

  load() {
    if (!fs) return;
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
      if (fs.existsSync(this.trafficFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.trafficFile, "utf-8"));
        const records = parsed.records || {};
        this.trafficCache = {};
        for (const id in records) {
          const list = records[id] || [];
          const isLegacySeed = list.length === 31 && list.every(r => r.total_bytes >= 10 * 1024 * 1024 * 1024 && r.total_bytes <= 35 * 1024 * 1024 * 1024);
          if (!isLegacySeed) {
            this.trafficCache[id] = list;
          }
        }
        this.lastCounters = parsed.last_counters || {};
      }
    } catch (e) {
      console.warn("[NetForecast] Storage load notice:", e);
    }
  }

  save() {
    if (!fs) return;
    try {
      if (!fs.existsSync(this.baseDir)) {
        fs.mkdirSync(this.baseDir, { recursive: true });
      }
      fs.writeFileSync(
        this.trafficFile,
        JSON.stringify(
          {
            records: this.trafficCache,
            last_counters: this.lastCounters,
            updated_at: new Date().toISOString(),
          },
          null,
          2
        ),
        "utf-8"
      );
    } catch (e) {
      console.error("[NetForecast] Storage save error:", e);
    }
  }

  getNodeHistory(nodeId) {
    return this.trafficCache[nodeId] || [];
  }

  recordSample(nodeId, currentIn, currentOut, now = new Date()) {
    const last = this.lastCounters[nodeId];
    this.lastCounters[nodeId] = {
      in: currentIn,
      out: currentOut,
      time: now.getTime(),
    };

    if (!last) {
      this.save();
      return;
    }

    let deltaIn = currentIn >= last.in ? currentIn - last.in : currentIn;
    let deltaOut = currentOut >= last.out ? currentOut - last.out : currentOut;

    if (deltaIn > 500 * 1024 * 1024 * 1024) deltaIn = 0;
    if (deltaOut > 500 * 1024 * 1024 * 1024) deltaOut = 0;

    if (deltaIn === 0 && deltaOut === 0) {
      return;
    }

    const todayStr = now.toISOString().split("T")[0];
    const history = this.trafficCache[nodeId] || [];
    let record = history.find((r) => r.date === todayStr);

    if (record) {
      record.in_bytes += deltaIn;
      record.out_bytes += deltaOut;
      record.total_bytes = record.in_bytes + record.out_bytes;
      record.timestamp = now.getTime();
    } else {
      record = {
        date: todayStr,
        timestamp: now.getTime(),
        in_bytes: deltaIn,
        out_bytes: deltaOut,
        total_bytes: deltaIn + deltaOut,
      };
      history.push(record);
    }

    if (history.length > 90) {
      history.splice(0, history.length - 90);
    }
    this.trafficCache[nodeId] = history;
    this.save();
  }
}

function sendJSON(res, data, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

const WIDGET_HEAD_HTML = `<style id="netforecast-widget-style">
#nf-floating-widget {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #f8fafc;
  position: fixed;
  bottom: 24px;
  right: 28px;
  z-index: 99999;
}
#nf-floating-widget * {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}
.nf-trigger-pill {
  background: rgba(15, 23, 42, 0.92);
  border: 1px solid rgba(99, 102, 241, 0.45);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  color: #fff;
  padding: 9px 16px;
  border-radius: 40px;
  display: flex;
  align-items: center;
  gap: 9px;
  cursor: pointer;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 0 20px rgba(99, 102, 241, 0.25);
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  user-select: none;
}
.nf-trigger-pill:hover {
  background: rgba(30, 41, 59, 0.95);
  border-color: #6366f1;
  transform: translateY(-2px) scale(1.02);
  box-shadow: 0 14px 35px rgba(0, 0, 0, 0.6), 0 0 25px rgba(99, 102, 241, 0.4);
}
.nf-pulse-dot {
  width: 9px;
  height: 9px;
  background: #10b981;
  border-radius: 50%;
  box-shadow: 0 0 8px #10b981;
}
.nf-pulse-dot.alert {
  background: #ef4444;
  box-shadow: 0 0 10px #ef4444;
  animation: nfPulse 1.6s infinite;
}
@keyframes nfPulse {
  0% { transform: scale(0.95); opacity: 0.85; }
  50% { transform: scale(1.25); opacity: 1; box-shadow: 0 0 14px #ef4444; }
  100% { transform: scale(0.95); opacity: 0.85; }
}
.nf-trigger-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.nf-trigger-badge {
  font-size: 11px;
  background: rgba(239, 68, 68, 0.2);
  border: 1px solid rgba(239, 68, 68, 0.5);
  color: #fca5a5;
  padding: 2px 7px;
  border-radius: 12px;
  font-weight: 700;
}
.nf-widget-card {
  position: absolute;
  bottom: 56px;
  right: 0;
  width: 440px;
  max-width: calc(100vw - 32px);
  max-height: 80vh;
  background: rgba(15, 23, 42, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border-radius: 20px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.75), 0 0 40px rgba(99, 102, 241, 0.15);
  display: flex;
  flex-direction: column;
  animation: nfSlideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  overflow: hidden;
}
@keyframes nfSlideUp {
  from { opacity: 0; transform: translateY(12px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.nf-header {
  padding: 14px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: rgba(30, 41, 59, 0.4);
}
.nf-header-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  font-weight: 700;
  color: #fff;
}
.nf-close-btn {
  background: transparent;
  border: none;
  color: #94a3b8;
  font-size: 18px;
  cursor: pointer;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: all 0.2s;
}
.nf-close-btn:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.1);
}
.nf-kpi-bar {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  padding: 10px 18px;
  background: rgba(15, 23, 42, 0.6);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.nf-kpi-item {
  background: rgba(30, 41, 59, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.05);
  padding: 6px 10px;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nf-kpi-lbl {
  font-size: 10px;
  color: #94a3b8;
  text-transform: uppercase;
}
.nf-kpi-val {
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nf-filter-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  background: rgba(15, 23, 42, 0.3);
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  overflow-x: auto;
}
.nf-filter-btn {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid transparent;
  color: #94a3b8;
  padding: 3px 9px;
  border-radius: 20px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}
.nf-filter-btn:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.1);
}
.nf-filter-btn.active {
  background: rgba(99, 102, 241, 0.25);
  border-color: rgba(99, 102, 241, 0.5);
  color: #a5b4fc;
  font-weight: 700;
}
.nf-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.nf-list::-webkit-scrollbar {
  width: 4px;
}
.nf-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 4px;
}
.nf-node-card {
  background: rgba(30, 41, 59, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.nf-node-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.nf-node-title {
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  display: flex;
  align-items: center;
  gap: 6px;
}
.nf-mode-badge {
  font-size: 10px;
  background: rgba(99, 102, 241, 0.15);
  border: 1px solid rgba(99, 102, 241, 0.35);
  color: #a5b4fc;
  padding: 1px 5px;
  border-radius: 4px;
  font-weight: 600;
}
.nf-badge {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.nf-badge.critical {
  background: rgba(239, 68, 68, 0.18);
  color: #fca5a5;
  border: 1px solid rgba(239, 68, 68, 0.4);
}
.nf-badge.warning {
  background: rgba(245, 158, 11, 0.18);
  color: #fde68a;
  border: 1px solid rgba(245, 158, 11, 0.4);
}
.nf-badge.safe {
  background: rgba(16, 185, 129, 0.18);
  color: #a7f3d0;
  border: 1px solid rgba(16, 185, 129, 0.3);
}
.nf-badge.no-quota {
  background: rgba(148, 163, 184, 0.15);
  color: #cbd5e1;
  border: 1px solid rgba(148, 163, 184, 0.25);
}
.nf-progress-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: #94a3b8;
}
.nf-progress-meta strong {
  color: #fff;
}
.nf-bar-bg {
  width: 100%;
  height: 6px;
  background: rgba(15, 23, 42, 0.8);
  border-radius: 3px;
  overflow: hidden;
  position: relative;
  display: flex;
}
.nf-bar-used {
  height: 100%;
  background: #6366f1;
}
.nf-bar-projected {
  height: 100%;
  background: repeating-linear-gradient(45deg, rgba(251, 146, 60, 0.5), rgba(251, 146, 60, 0.5) 4px, rgba(251, 146, 60, 0.85) 4px, rgba(251, 146, 60, 0.85) 8px);
}
.nf-bar-projected.critical {
  background: repeating-linear-gradient(45deg, rgba(239, 68, 68, 0.55), rgba(239, 68, 68, 0.55) 4px, rgba(239, 68, 68, 0.9) 4px, rgba(239, 68, 68, 0.9) 8px);
}
.nf-node-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  color: #94a3b8;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  padding-top: 6px;
}
.nf-footer {
  padding: 10px 18px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(15, 23, 42, 0.8);
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.nf-footer-status {
  font-size: 11px;
  color: #94a3b8;
  display: flex;
  align-items: center;
  gap: 5px;
}
.nf-live-dot {
  width: 6px;
  height: 6px;
  background: #10b981;
  border-radius: 50%;
}
.nf-btn-full {
  font-size: 12px;
  color: #fff;
  background: linear-gradient(135deg, #4f46e5 0%, #06b6d4 100%);
  padding: 5px 12px;
  border-radius: 7px;
  text-decoration: none;
  font-weight: 600;
  transition: all 0.2s;
  box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);
}
.nf-btn-full:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(79, 70, 229, 0.45);
}
</style>`;

const WIDGET_BODY_HTML = `
<div id="nf-floating-widget">
  <div class="nf-trigger-pill" id="nfTriggerPill">
    <div class="nf-pulse-dot" id="nfPulseDot"></div>
    <span class="nf-trigger-title" id="nfTriggerTitle">流量预测</span>
    <span class="nf-trigger-badge" id="nfTriggerBadge" style="display:none;"></span>
  </div>
  <div class="nf-widget-card" id="nfWidgetCard" style="display:none;">
    <div class="nf-header">
      <div class="nf-header-title"><span>📊</span><span id="nfWhTitle">节点流量预测与预算</span></div>
      <button class="nf-close-btn" id="nfCloseBtn" title="关闭">✕</button>
    </div>
    <div class="nf-kpi-bar">
      <div class="nf-kpi-item"><span class="nf-kpi-lbl" id="nfKpiUsedLbl">配额总已用</span><span class="nf-kpi-val" id="nfKpiUsedVal">-</span></div>
      <div class="nf-kpi-item"><span class="nf-kpi-lbl" id="nfKpiRiskLbl">超限风险</span><span class="nf-kpi-val" id="nfKpiRiskVal" style="color:#fca5a5;">-</span></div>
      <div class="nf-kpi-item"><span class="nf-kpi-lbl" id="nfKpiResetLbl">最近重置</span><span class="nf-kpi-val" id="nfKpiResetVal" style="color:#38bdf8;">-</span></div>
    </div>
    <div class="nf-filter-bar" id="nfFilterBar">
      <button class="nf-filter-btn active" data-filter="ALL" id="nfBtnAll">全部 (0)</button>
      <button class="nf-filter-btn" data-filter="ALERT" id="nfBtnAlert">🚨 预警 (0)</button>
      <button class="nf-filter-btn" data-filter="SAFE" id="nfBtnSafe">✅ 安全 (0)</button>
      <button class="nf-filter-btn" data-filter="NO_QUOTA" id="nfBtnNoQuota">⚪ 免额 (0)</button>
    </div>
    <div class="nf-list" id="nfNodeList">
      <div style="text-align:center; padding:20px; color:#94a3b8; font-size:12px;">正在加载流量预测数据...</div>
    </div>
    <div class="nf-footer">
      <div class="nf-footer-status"><div class="nf-live-dot"></div><span id="nfFooterStatus">实时监测中</span></div>
      <a href="/api/plugin/net-forecast/pages/public.html" target="_blank" class="nf-btn-full" id="nfFooterFullBtn">查看完整图表 ↗</a>
    </div>
  </div>
</div>
<script>
(function() {
  if (window.self !== window.top) {
    var root = document.getElementById("nf-floating-widget");
    if (root) root.remove();
    return;
  }

  var isEn = (navigator.language || "").toLowerCase().startsWith("en");
  var pill = document.getElementById("nfTriggerPill");
  var card = document.getElementById("nfWidgetCard");
  var closeBtn = document.getElementById("nfCloseBtn");
  var pulseDot = document.getElementById("nfPulseDot");
  var triggerTitle = document.getElementById("nfTriggerTitle");
  var triggerBadge = document.getElementById("nfTriggerBadge");
  var whTitle = document.getElementById("nfWhTitle");
  var kpiUsedLbl = document.getElementById("nfKpiUsedLbl");
  var kpiRiskLbl = document.getElementById("nfKpiRiskLbl");
  var kpiResetLbl = document.getElementById("nfKpiResetLbl");
  var kpiUsedVal = document.getElementById("nfKpiUsedVal");
  var kpiRiskVal = document.getElementById("nfKpiRiskVal");
  var kpiResetVal = document.getElementById("nfKpiResetVal");
  var btnAll = document.getElementById("nfBtnAll");
  var btnAlert = document.getElementById("nfBtnAlert");
  var btnSafe = document.getElementById("nfBtnSafe");
  var btnNoQuota = document.getElementById("nfBtnNoQuota");
  var nodeList = document.getElementById("nfNodeList");
  var footerStatus = document.getElementById("nfFooterStatus");
  var footerFullBtn = document.getElementById("nfFooterFullBtn");

  if (isEn) {
    if (triggerTitle) triggerTitle.textContent = "NetForecast";
    if (whTitle) whTitle.textContent = "Node Traffic Forecast";
    if (kpiUsedLbl) kpiUsedLbl.textContent = "TOTAL USED";
    if (kpiRiskLbl) kpiRiskLbl.textContent = "AT RISK";
    if (kpiResetLbl) kpiResetLbl.textContent = "NEXT RESET";
    if (footerStatus) footerStatus.textContent = "Live Monitoring";
    if (footerFullBtn) footerFullBtn.textContent = "View Full Chart ↗";
  }

  var isOpen = false;
  var currentFilter = "ALL";
  var cachedData = null;

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    var k = 1024;
    var sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    var idx = Math.min(i, sizes.length - 1);
    return (bytes / Math.pow(k, idx)).toFixed(idx === 0 ? 0 : 1) + " " + sizes[idx];
  }

  function toggle() {
    isOpen = !isOpen;
    card.style.display = isOpen ? "flex" : "none";
    if (isOpen && !cachedData) {
      fetchData();
    }
  }

  if (pill) pill.onclick = toggle;
  if (closeBtn) closeBtn.onclick = toggle;

  function setupFilters() {
    var btns = [btnAll, btnAlert, btnSafe, btnNoQuota];
    btns.forEach(function(b) {
      if (!b) return;
      b.onclick = function() {
        btns.forEach(function(x) { if (x) x.classList.remove("active"); });
        b.classList.add("active");
        currentFilter = b.getAttribute("data-filter") || "ALL";
        renderList();
      };
    });
  }
  setupFilters();

  function renderList() {
    if (!cachedData || !cachedData.nodes) return;
    var nodes = cachedData.nodes;
    var html = "";

    var filtered = nodes.filter(function(n) {
      var cat = (n.status === "CRITICAL" || n.status === "WARNING") ? "ALERT" : n.status;
      if (currentFilter === "ALL") return true;
      return cat === currentFilter;
    });

    if (filtered.length === 0) {
      nodeList.innerHTML = '<div style="text-align:center; padding:24px; color:#94a3b8; font-size:12px;">' + (isEn ? "No matching nodes" : "无符合当前筛选的节点") + '</div>';
      return;
    }

    filtered.forEach(function(n) {
      var hasQuota = Boolean(n.has_quota);
      var status = n.status || "NO_QUOTA";
      var usedBytes = (n.cumulative && n.cumulative.billable_bytes) || 0;
      var quotaBytes = n.traffic_limit_bytes || 0;
      var dailyAvg = (n.daily_avg && n.daily_avg.billable_formatted) || "0 B";
      var daysRemaining = (n.cycle && n.cycle.daysRemaining !== undefined) ? n.cycle.daysRemaining : 0;
      var resetDay = n.traffic_reset_day || 1;

      var mode = (n.traffic_limit_type || "sum").toLowerCase();
      var modeLabel = mode === "sum" ? "双向求和" : (mode === "max" ? "双向取大" : (mode === "min" ? "双向取小" : (mode === "upload" ? "仅出站" : "仅入站")));
      if (isEn) modeLabel = mode.toUpperCase();

      var badgeClass = "safe";
      var badgeText = isEn ? "✅ Safe" : "✅ 预算充足";
      if (status === "CRITICAL") {
        badgeClass = "critical";
        badgeText = isEn ? "🚨 Over Quota" : "🚨 超额预警";
      } else if (status === "WARNING") {
        badgeClass = "warning";
        badgeText = isEn ? "⚡ Warning" : "⚡ 接近限额";
      } else if (status === "NO_QUOTA") {
        badgeClass = "no-quota";
        badgeText = isEn ? "⚪ No Quota" : "⚪ 免额预测";
      }

      var barHtml = "";
      var metaHtml = "";
      if (hasQuota && quotaBytes > 0) {
        var usedRatio = usedBytes / quotaBytes;
        var usedPct = Math.min(100, Math.round(usedRatio * 100));
        var projBytes = (n.projected && n.projected.billable_bytes) || usedBytes;
        var projPct = 0;
        if (projBytes > usedBytes) {
          projPct = Math.min(100 - usedPct, Math.max(0, Math.round((projBytes - usedBytes) / quotaBytes * 100)));
        }
        var isCrit = status === "CRITICAL";
        var usedColor = isCrit ? "#ef4444" : "#6366f1";
        var projClass = isCrit ? "critical" : "";
        barHtml = '<div class="nf-bar-used" style="width:' + usedPct + '%; background:' + usedColor + ';"></div>' +
                  '<div class="nf-bar-projected ' + projClass + '" style="width:' + projPct + '%;"></div>';
        metaHtml = '<span>' + (isEn ? "Used: " : "已用: ") + '<strong>' + formatBytes(usedBytes) + '</strong> / ' + (isEn ? "Quota: " : "限额: ") + formatBytes(quotaBytes) + '</span>' +
                   '<span style="font-weight:700; color:' + (isCrit ? '#ef4444' : '#fff') + ';">' + usedPct + '%</span>';
      } else {
        barHtml = '<div class="nf-bar-used" style="width:100%; opacity:0.3; background:#94a3b8;"></div>';
        metaHtml = '<span>' + (isEn ? "Used: " : "已用: ") + '<strong>' + formatBytes(usedBytes) + '</strong> · ' + (isEn ? "Projected: " : "预测: ") + formatBytes((n.projected && n.projected.billable_bytes) || 0) + '</span>' +
                   '<span style="opacity:0.6;">' + (isEn ? "Uncapped" : "免额度") + '</span>';
      }

      var resetText = isEn ? ("Reset day: " + resetDay + " (" + daysRemaining + "d left)") : ("每月 " + resetDay + " 号重置 (倒计时 " + daysRemaining + " 天)");
      var speedText = isEn ? ("Avg: " + dailyAvg + "/d") : ("均速: " + dailyAvg + "/天");

      html += '<div class="nf-node-card">' +
        '<div class="nf-node-header">' +
          '<div class="nf-node-title"><span>' + (n.node_name || n.node_id) + '</span><span class="nf-mode-badge">' + modeLabel + '</span></div>' +
          '<span class="nf-badge ' + badgeClass + '">' + badgeText + '</span>' +
        '</div>' +
        '<div style="display:flex; flex-direction:column; gap:4px;">' +
          '<div class="nf-progress-meta">' + metaHtml + '</div>' +
          '<div class="nf-bar-bg">' + barHtml + '</div>' +
        '</div>' +
        '<div class="nf-node-footer">' +
          '<span>' + speedText + '</span>' +
          '<span>' + resetText + '</span>' +
        '</div>' +
      '</div>';
    });

    nodeList.innerHTML = html;
  }

  function renderData(data) {
    cachedData = data;
    var summary = data.summary || {};
    var nodes = data.nodes || [];
    var crit = summary.critical_count || 0;
    var warn = summary.warning_count || 0;
    var safe = summary.safe_count || 0;
    var noQuota = summary.no_quota_count || 0;
    var totalAlerts = crit + warn;

    if (totalAlerts > 0) {
      triggerBadge.style.display = "inline-flex";
      triggerBadge.textContent = totalAlerts + (isEn ? " Alerts" : " 节点预警");
      pulseDot.className = "nf-pulse-dot alert";
    } else {
      triggerBadge.style.display = "none";
      pulseDot.className = "nf-pulse-dot";
    }

    var totalUsedBillable = 0;
    var minDays = 999;
    var minNode = null;

    nodes.forEach(function(n) {
      if (n.cumulative && n.cumulative.billable_bytes) {
        totalUsedBillable += n.cumulative.billable_bytes;
      }
      if (n.cycle && typeof n.cycle.daysRemaining === "number") {
        if (n.cycle.daysRemaining < minDays) {
          minDays = n.cycle.daysRemaining;
          minNode = n;
        }
      }
    });

    if (kpiUsedVal) kpiUsedVal.textContent = formatBytes(totalUsedBillable);
    if (kpiRiskVal) {
      kpiRiskVal.textContent = totalAlerts > 0 ? (totalAlerts + (isEn ? " Nodes" : " 台节点")) : (isEn ? "None" : "无风险");
      kpiRiskVal.style.color = totalAlerts > 0 ? "#fca5a5" : "#a7f3d0";
    }
    if (kpiResetVal) {
      if (minNode) {
        kpiResetVal.textContent = minDays + (isEn ? "d (" + minNode.node_name + ")" : "天后 (" + minNode.node_name + ")");
      } else {
        kpiResetVal.textContent = "-";
      }
    }

    if (btnAll) btnAll.textContent = (isEn ? "All (" : "全部 (") + nodes.length + ")";
    if (btnAlert) btnAlert.textContent = (isEn ? "🚨 Alert (" : "🚨 预警 (") + totalAlerts + ")";
    if (btnSafe) btnSafe.textContent = (isEn ? "✅ Safe (" : "✅ 安全 (") + safe + ")";
    if (btnNoQuota) btnNoQuota.textContent = (isEn ? "⚪ Uncapped (" : "⚪ 免额 (") + noQuota + ")";

    renderList();
  }

  function fetchData() {
    fetch("/api/plugin/net-forecast/overview")
      .then(function(res) { return res.json(); })
      .then(function(json) {
        if (json && json.ok) {
          renderData(json);
        }
      })
      .catch(function(e) {
        console.warn("[NetForecast Widget]", e);
      });
  }

  fetchData();
  setInterval(fetchData, 60000);
})();
</script>`;

function load() {
  console.log("[NetForecast] Plugin loaded in strict real-data mode.");
  const storage = new TrafficStorage();

  const getConfig = () => {
    const raw = server.getConfig ? server.getConfig() : {};
    return {
      default_reset_day: Number(raw.default_reset_day) || 1,
      warning_threshold: Number(raw.warning_threshold) || 90,
      auto_collect_cron: raw.auto_collect_cron || "*/10 * * * *",
      enable_floating_widget: raw.enable_floating_widget !== undefined ? Boolean(raw.enable_floating_widget) : true,
    };
  };

  const parseBody = (body) => {
    try {
      return JSON.parse(body || "{}");
    } catch (e) {
      return {};
    }
  };

  const fetchCoreClients = async (fallbackClients) => {
    if (Array.isArray(fallbackClients) && fallbackClients.length > 0) {
      return fallbackClients;
    }
    if (server.call) {
      try {
        const res = await server.call("admin:listClients").catch(() => null);
        if (Array.isArray(res) && res.length > 0) return res;
        const alt = await server.call("common:getNodes").catch(() => null);
        if (Array.isArray(alt) && alt.length > 0) return alt;
      } catch (e) {
        console.warn("[NetForecast] fetchCoreClients notice:", e);
      }
    }
    return [];
  };

  // 1. 全节点 30 天预测总览接口
  const handleOverview = async (req, res) => {
    try {
      const config = getConfig();
      const body = req.body ? parseBody(req.body) : {};
      let clients = await fetchCoreClients(body.clients);

      if (!clients) {
        clients = [];
      }

      const list = clients.map((c) => {
        if (typeof c.net_in === "number" && typeof c.net_out === "number") {
          storage.recordSample(c.uuid, c.net_in, c.net_out);
        }
        const history = Array.isArray(c.daily_history) && c.daily_history.length > 0
          ? c.daily_history
          : storage.getNodeHistory(c.uuid);

        return calculateNodeForecast(history, c, config.warning_threshold);
      });

      const criticalCount = list.filter((n) => n.status === "CRITICAL").length;
      const warningCount = list.filter((n) => n.status === "WARNING").length;
      const safeCount = list.filter((n) => n.status === "SAFE").length;
      const noQuotaCount = list.filter((n) => n.status === "NO_QUOTA").length;

      sendJSON(res, {
        ok: true,
        summary: {
          total_nodes: list.length,
          critical_count: criticalCount,
          warning_count: warningCount,
          safe_count: safeCount,
          no_quota_count: noQuotaCount,
        },
        nodes: list,
      });
    } catch (e) {
      sendJSON(res, { ok: false, error: e.message || String(e) }, 500);
    }
  };

  server.route("GET", "/api/plugin/net-forecast/overview", handleOverview);
  server.route("POST", "/api/plugin/net-forecast/overview", handleOverview);

  // 2. 限额配置更新：直写 Komari 核心数据库
  server.route("POST", "/api/plugin/net-forecast/update-quota", async (req, res) => {
    try {
      const data = parseBody(req.body);
      const uuid = data.uuid || data.node_id;
      if (!uuid) {
        sendJSON(res, { ok: false, error: "Missing uuid" }, 400);
        return;
      }

      const payload = {
        uuid: uuid,
        traffic_limit: Number(data.traffic_limit) >= 0 ? Number(data.traffic_limit) : 0,
        traffic_limit_type: data.traffic_limit_type || "sum",
      };

      let rpcSuccess = false;
      if (server.call) {
        try {
          await server.call("admin:editClient", payload);
          rpcSuccess = true;
        } catch (e) {
          console.warn("[NetForecast] admin:editClient notice:", e);
        }
      }

      sendJSON(res, {
        ok: true,
        rpc_success: rpcSuccess,
        message: "Node settings update submitted directly to Komari core",
        payload,
      });
    } catch (e) {
      sendJSON(res, { ok: false, error: e.message || String(e) }, 500);
    }
  });

  // 3. 定时同步轮询
  const config = getConfig();
  try {
    server.cron(config.auto_collect_cron, async () => {
      try {
        if (server.call) {
          const clients = await server.call("admin:listClients").catch(() => null);
          if (Array.isArray(clients)) {
            for (const c of clients) {
              if (c.uuid && typeof c.net_in === "number" && typeof c.net_out === "number") {
                storage.recordSample(c.uuid, c.net_in, c.net_out);
              }
            }
          }
        }
      } catch (e) {
        // cron error ignored
      }
    });
  } catch (e) {
    console.warn("[NetForecast] Cron registration notice:", e);
  }

  // 4. RPC
    // 5. 前台浮出层组件 HTML 自动注入 (根据配置 enable_floating_widget)
  if (config.enable_floating_widget && server.injectHTML) {
    try {
      server.injectHTML(WIDGET_HEAD_HTML, WIDGET_BODY_HTML);
      console.log("[NetForecast] Floating widget injected successfully.");
    } catch (e) {
      console.warn("[NetForecast] injectHTML notice:", e);
    }
  }

  server.registerRPC("netForecast:getOverview", async () => {
    const config = getConfig();
    const clients = await fetchCoreClients();
    return {
      ok: true,
      nodes: clients.map((c) => {
        const history = storage.getNodeHistory(c.uuid);
        return calculateNodeForecast(history, c, config.warning_threshold);
      }),
    };
  });
}

function unload() {
  console.log("[NetForecast] Plugin unloaded.");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { load, unload };
}
