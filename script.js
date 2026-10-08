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

/**
 * 计算账单周期范围
 */
function calculateBillingCycle(resetDay = 1, now = new Date()) {
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentDate = now.getDate();

  const safeResetDay = Math.max(1, Math.min(31, Math.floor(Number(resetDay) || 1)));

  let cycleStartDate;
  let cycleEndDate;

  if (currentDate >= safeResetDay) {
    const maxDayThisMonth = getDaysInMonth(currentYear, currentMonth);
    const actualStartDay = Math.min(safeResetDay, maxDayThisMonth);
    cycleStartDate = new Date(currentYear, currentMonth, actualStartDay, 0, 0, 0, 0);

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

    const maxDayThisMonth = getDaysInMonth(currentYear, currentMonth);
    const actualEndDay = Math.min(safeResetDay, maxDayThisMonth);
    cycleEndDate = new Date(currentYear, currentMonth, actualEndDay, 0, 0, 0, 0);
  }

  const oneDayMs = 24 * 60 * 60 * 1000;
  const daysTotal = Math.max(1, Math.round((cycleEndDate.getTime() - cycleStartDate.getTime()) / oneDayMs));
  const daysElapsed = Math.max(1, Math.min(daysTotal, Math.ceil((now.getTime() - cycleStartDate.getTime()) / oneDayMs)));
  const daysRemaining = Math.max(0, daysTotal - daysElapsed);

  return {
    cycleStart: cycleStartDate.toISOString().split("T")[0],
    cycleEnd: cycleEndDate.toISOString().split("T")[0],
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
function build30DaySeries(history, mode, cycle, dailyAvgIn, dailyAvgOut, currentCycleBillable, cumulativeIn = 0, cumulativeOut = 0, now = new Date()) {
  const historyMap = {};
  (history || []).forEach((item) => {
    if (item.date) {
      historyMap[item.date] = item;
    }
  });

  const points = [];
  const cycleStartMs = cycle.cycleStartDate.getTime();
  let runningIn = 0;
  let runningOut = 0;

  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
    const dateStr = d.toISOString().split("T")[0];
    const rec = historyMap[dateStr];

    const inB = rec ? (rec.in_bytes || 0) : 0;
    const outB = rec ? (rec.out_bytes || 0) : 0;
    const totB = inB + outB;

    if (d.getTime() >= cycleStartMs && d.getTime() <= now.getTime()) {
      runningIn += inB;
      runningOut += outB;
    }
    let cumBillable = computeBillableAmount(runningIn, runningOut, mode);

    // 今天如果获取到真实累计量且历史采样未完全覆盖过去所有天数，使折线今天点锚定在真实的当前累计值上
    // 注意：柱状图（inB/outB）必须忠实反映单日增量，绝不能将历史整周期的累计流量错误倒灌进今日！
    if (i === 0 && currentCycleBillable > 0 && cumBillable < currentCycleBillable) {
      cumBillable = currentCycleBillable;
    }

    points.push({
      date: dateStr,
      timestamp: d.getTime(),
      in_bytes: inB,
      out_bytes: outB,
      total_bytes: totB,
      cumulative_bytes: runningIn + runningOut,
      cumulative_billable: cumBillable,
      is_forecast: false,
      is_today: i === 0,
    });
  }

  // 仅在有日均消耗且剩余天数大于 0 时外推未来预测点
  if (cycle.daysRemaining > 0 && (dailyAvgIn > 0 || dailyAvgOut > 0)) {
    let fCumBillable = points.length > 0 && points[points.length - 1].cumulative_billable
      ? points[points.length - 1].cumulative_billable
      : currentCycleBillable;

    const dailyForecastBillable = computeBillableAmount(dailyAvgIn, dailyAvgOut, mode);
    const maxForecastDays = Math.min(cycle.daysRemaining, 14);

    for (let i = 1; i <= maxForecastDays; i++) {
      const fd = new Date(now.getTime() + i * 24 * 3600 * 1000);
      fCumBillable += dailyForecastBillable;

      points.push({
        date: fd.toISOString().split("T")[0],
        timestamp: fd.getTime(),
        in_bytes: dailyAvgIn,
        out_bytes: dailyAvgOut,
        total_bytes: dailyAvgIn + dailyAvgOut,
        cumulative_bytes: fCumBillable,
        cumulative_billable: fCumBillable,
        is_forecast: true,
      });
    }
  }

  return points;
}

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

    const day = dateObj.getDate();
    const dateStr = dateObj.toISOString().split("T")[0];

    return {
      resetDay: Math.max(1, Math.min(31, day)),
      hasExpiredAt: true,
      expiredAtStr: dateStr,
      desc: `每月 ${day} 号 (同步自节点到期日: ${dateStr})`,
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

  const chartSeries = build30DaySeries(history, mode, cycle, dailyAvgIn, dailyAvgOut, cumulativeBillable, cumulativeIn, cumulativeOut, now);

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

function load() {
  console.log("[NetForecast] Plugin loaded in strict real-data mode.");
  const storage = new TrafficStorage();

  const getConfig = () => {
    const raw = server.getConfig ? server.getConfig() : {};
    return {
      default_reset_day: Number(raw.default_reset_day) || 1,
      warning_threshold: Number(raw.warning_threshold) || 90,
      auto_collect_cron: raw.auto_collect_cron || "*/10 * * * *",
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
