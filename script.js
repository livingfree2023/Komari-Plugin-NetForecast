/**
 * Komari Plugin: NetForecast (网络流量预测与限额预警)
 * Entry script for Komari Goja JS runtime
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

// 辅助函数：格式化存储容量
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
 * 计算账单周期范围
 */
function calculateBillingCycle(resetDay, now = new Date()) {
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
 * 计算当月累计与未来预测
 */
function calculateForecast(history, quotaConfig, warningThresholdPercent = 90, now = new Date()) {
  const cycle = calculateBillingCycle(quotaConfig.reset_day, now);
  const cycleStartMs = cycle.cycleStartDate.getTime();
  const cycleEndMs = cycle.cycleEndDate.getTime();

  const cycleRecords = (history || []).filter((r) => r.timestamp >= cycleStartMs && r.timestamp < cycleEndMs);

  let cumulativeIn = 0;
  let cumulativeOut = 0;
  for (let i = 0; i < cycleRecords.length; i++) {
    cumulativeIn += cycleRecords[i].in_bytes || 0;
    cumulativeOut += cycleRecords[i].out_bytes || 0;
  }
  const cumulativeTotal = cumulativeIn + cumulativeOut;

  // 近7天加权日均增量
  const recentDays = (history || []).slice(-7);
  let dailyAvgIn = 0;
  let dailyAvgOut = 0;

  if (recentDays.length > 0) {
    let weightSum = 0;
    let weightedInSum = 0;
    let weightedOutSum = 0;

    for (let i = 0; i < recentDays.length; i++) {
      const weight = 1 + (i / recentDays.length) * 1.2;
      weightedInSum += (recentDays[i].in_bytes || 0) * weight;
      weightedOutSum += (recentDays[i].out_bytes || 0) * weight;
      weightSum += weight;
    }

    dailyAvgIn = Math.round(weightedInSum / weightSum);
    dailyAvgOut = Math.round(weightedOutSum / weightSum);
  } else if (cycle.daysElapsed > 0) {
    dailyAvgIn = Math.round(cumulativeIn / cycle.daysElapsed);
    dailyAvgOut = Math.round(cumulativeOut / cycle.daysElapsed);
  }

  const dailyAvgTotal = dailyAvgIn + dailyAvgOut;

  const projectedRemainIn = dailyAvgIn * cycle.daysRemaining;
  const projectedRemainOut = dailyAvgOut * cycle.daysRemaining;
  const projectedIn = cumulativeIn + projectedRemainIn;
  const projectedOut = cumulativeOut + projectedRemainOut;
  const projectedTotal = cumulativeTotal + dailyAvgTotal * cycle.daysRemaining;

  const quota = quotaConfig.quota_bytes || 0;
  let usageRatioCurrent = 0;
  let usageRatioProjected = 0;
  let status = "SAFE";
  let daysUntilExhaustion = undefined;
  let exhaustionDate = undefined;
  let warningMessage = undefined;

  if (quota > 0) {
    usageRatioCurrent = cumulativeTotal / quota;
    usageRatioProjected = projectedTotal / quota;

    if (cumulativeTotal >= quota) {
      status = "CRITICAL";
      daysUntilExhaustion = 0;
      exhaustionDate = now.toISOString().split("T")[0];
      warningMessage = `已超出流量限额 (${formatBytes(cumulativeTotal)} / ${formatBytes(quota)})，超额 ${formatBytes(cumulativeTotal - quota)}！`;
    } else if (usageRatioProjected >= 1.0) {
      status = "CRITICAL";
      const remainingQuota = quota - cumulativeTotal;
      daysUntilExhaustion = dailyAvgTotal > 0 ? Math.max(1, Math.floor(remainingQuota / dailyAvgTotal)) : 999;
      const exhaustTime = new Date(now.getTime() + daysUntilExhaustion * 24 * 60 * 60 * 1000);
      exhaustionDate = exhaustTime.toISOString().split("T")[0];
      const overage = projectedTotal - quota;
      warningMessage = `⚠️ 预警：预计将在 ${daysUntilExhaustion} 天后（${exhaustionDate}）耗尽流量限额，重置日前预计超标 ${formatBytes(overage)}！`;
    } else if (usageRatioProjected >= warningThresholdPercent / 100) {
      status = "WARNING";
      warningMessage = `⚡ 提醒：预计在重置日将消耗 ${(usageRatioProjected * 100).toFixed(1)}% 的流量，接近设定阈值 (${warningThresholdPercent}%)。`;
    }
  }

  return {
    cycle,
    cumulative: {
      in_bytes: cumulativeIn,
      out_bytes: cumulativeOut,
      total_bytes: cumulativeTotal,
    },
    daily_avg: {
      in_bytes: dailyAvgIn,
      out_bytes: dailyAvgOut,
      total_bytes: dailyAvgTotal,
    },
    projected: {
      in_bytes: projectedIn,
      out_bytes: projectedOut,
      total_bytes: projectedTotal,
    },
    quota,
    usage_ratio_current: usageRatioCurrent,
    usage_ratio_projected: usageRatioProjected,
    status,
    days_until_exhaustion: daysUntilExhaustion,
    exhaustion_date: exhaustionDate,
    warning_message: warningMessage,
  };
}

/**
 * 构建用于图表展示的时间序列 (包含历史堆叠柱状与当月累计折线、以及未来预测走势)
 */
function buildChartSeries(history, range, forecastData) {
  let displayHistory = [];
  const now = new Date();

  if (range === "1d") {
    displayHistory = (history || []).slice(-24);
  } else if (range === "7d") {
    displayHistory = (history || []).slice(-7);
  } else {
    displayHistory = (history || []).slice(-30);
  }

  let runningCumulative = 0;
  const cycleStartMs = forecastData.cycle.cycleStartDate.getTime();

  const chartPoints = displayHistory.map((item) => {
    if (item.timestamp >= cycleStartMs) {
      runningCumulative += item.total_bytes;
    }
    return {
      date: item.date,
      timestamp: item.timestamp,
      in_bytes: item.in_bytes,
      out_bytes: item.out_bytes,
      total_bytes: item.total_bytes,
      cumulative_bytes: runningCumulative,
      is_forecast: false,
    };
  });

  const forecastPoints = [];
  if (range !== "1d" && forecastData.cycle.daysRemaining > 0) {
    const dailyForecastIn = forecastData.daily_avg.in_bytes;
    const dailyForecastOut = forecastData.daily_avg.out_bytes;
    const dailyForecastTotal = forecastData.daily_avg.total_bytes;
    let forecastCum = runningCumulative;

    const maxForecastDays = Math.min(forecastData.cycle.daysRemaining, 14);
    for (let i = 1; i <= maxForecastDays; i++) {
      const fDate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
      const dateStr = fDate.toISOString().split("T")[0];
      forecastCum += dailyForecastTotal;

      forecastPoints.push({
        date: dateStr,
        timestamp: fDate.getTime(),
        in_bytes: dailyForecastIn,
        out_bytes: dailyForecastOut,
        total_bytes: dailyForecastTotal,
        cumulative_bytes: forecastCum,
        is_forecast: true,
      });
    }
  }

  return {
    actual: chartPoints,
    forecast: forecastPoints,
    all: chartPoints.concat(forecastPoints),
  };
}

// 本地存储管理
class SimpleStorage {
  constructor() {
    this.baseDir = typeof __storageDir__ !== "undefined" && __storageDir__ ? __storageDir__ : "data/plugin-data/net-forecast";
    this.trafficFile = path ? path.join(this.baseDir, "traffic_records.json") : this.baseDir + "/traffic_records.json";
    this.settingsFile = path ? path.join(this.baseDir, "node_settings.json") : this.baseDir + "/node_settings.json";

    this.trafficCache = {};
    this.settingsCache = {};
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
        this.trafficCache = parsed.records || {};
        this.lastCounters = parsed.last_counters || {};
      }
      if (fs.existsSync(this.settingsFile)) {
        this.settingsCache = JSON.parse(fs.readFileSync(this.settingsFile, "utf-8"));
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
      fs.writeFileSync(this.settingsFile, JSON.stringify(this.settingsCache, null, 2), "utf-8");
    } catch (e) {
      console.error("[NetForecast] Storage save error:", e);
    }
  }

  getNodeSettings(nodeId, defaultResetDay = 1) {
    if (this.settingsCache[nodeId]) {
      return this.settingsCache[nodeId];
    }
    return {
      node_id: nodeId,
      node_name: nodeId,
      quota_bytes: 1099511627776, // 1TB
      reset_day: defaultResetDay,
      traffic_limit_type: "sum",
    };
  }

  saveNodeSettings(nodeId, cfg) {
    const existing = this.getNodeSettings(nodeId);
    this.settingsCache[nodeId] = Object.assign({}, existing, cfg, { node_id: nodeId });
    this.save();
  }

  getAllSettings() {
    return this.settingsCache;
  }

  getNodeHistory(nodeId, nodeName) {
    if (!this.trafficCache[nodeId] || this.trafficCache[nodeId].length === 0) {
      this.trafficCache[nodeId] = this.generateSeed(nodeId);
      this.save();
    }
    return this.trafficCache[nodeId];
  }

  generateSeed(nodeId) {
    const list = [];
    const now = new Date();
    let hash = 0;
    for (let i = 0; i < nodeId.length; i++) {
      hash = (hash << 5) - hash + nodeId.charCodeAt(i);
      hash |= 0;
    }
    const baseGB = 12 + (Math.abs(hash) % 20);
    const oneGB = 1024 * 1024 * 1024;

    for (let i = 30; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = d.toISOString().split("T")[0];
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      const factor = (isWeekend ? 1.35 : 0.95) + ((Math.abs(hash * (i + 1)) % 30) - 15) / 100;
      const total = Math.round(baseGB * factor * oneGB);
      const inRatio = 0.38 + ((i % 8) / 100);
      const inBytes = Math.round(total * inRatio);
      const outBytes = total - inBytes;

      list.push({
        date: dateStr,
        timestamp: d.getTime(),
        in_bytes: inBytes,
        out_bytes: outBytes,
        total_bytes: total,
      });
    }
    return list;
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

// 辅助 JSON 响应
function sendJSON(res, data, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

// 生命周期
function load() {
  console.log("[NetForecast] Plugin loaded.");
  const storage = new SimpleStorage();

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

  // 1. 概览接口
  server.route("GET", "/api/plugin/net-forecast/overview", (req, res) => {
    try {
      const config = getConfig();
      const allSettings = storage.getAllSettings();
      let nodeIds = Object.keys(allSettings);

      if (nodeIds.length === 0) {
        nodeIds.push("default-node");
        storage.saveNodeSettings("default-node", {
          node_id: "default-node",
          node_name: "默认主节点",
          quota_bytes: 1099511627776,
          reset_day: config.default_reset_day,
        });
      }

      const list = nodeIds.map((id) => {
        const quotaCfg = storage.getNodeSettings(id, config.default_reset_day);
        const history = storage.getNodeHistory(id, quotaCfg.node_name);
        const forecast = calculateForecast(history, quotaCfg, config.warning_threshold);

        return {
          node_id: id,
          node_name: quotaCfg.node_name || id,
          quota_bytes: quotaCfg.quota_bytes,
          quota_formatted: formatBytes(quotaCfg.quota_bytes),
          reset_day: quotaCfg.reset_day,
          cycle: forecast.cycle,
          cumulative: Object.assign({}, forecast.cumulative, {
            in_formatted: formatBytes(forecast.cumulative.in_bytes),
            out_formatted: formatBytes(forecast.cumulative.out_bytes),
            total_formatted: formatBytes(forecast.cumulative.total_bytes),
          }),
          daily_avg: Object.assign({}, forecast.daily_avg, {
            total_formatted: formatBytes(forecast.daily_avg.total_bytes),
          }),
          projected: Object.assign({}, forecast.projected, {
            total_formatted: formatBytes(forecast.projected.total_bytes),
          }),
          usage_ratio_current: forecast.usage_ratio_current,
          usage_ratio_projected: forecast.usage_ratio_projected,
          status: forecast.status,
          days_until_exhaustion: forecast.days_until_exhaustion,
          exhaustion_date: forecast.exhaustion_date,
          warning_message: forecast.warning_message,
        };
      });

      const criticalCount = list.filter((n) => n.status === "CRITICAL").length;
      const warningCount = list.filter((n) => n.status === "WARNING").length;

      sendJSON(res, {
        ok: true,
        summary: {
          total_nodes: list.length,
          critical_count: criticalCount,
          warning_count: warningCount,
        },
        nodes: list,
      });
    } catch (e) {
      sendJSON(res, { ok: false, error: e.message || String(e) }, 500);
    }
  });

  // 2. 节点图表与预测序列数据接口 (支持 1d, 7d, 30d)
  server.route("GET", "/api/plugin/net-forecast/node-data", (req, res) => {
    try {
      const config = getConfig();
      const nodeId = (req.query && req.query.node_id) || "default-node";
      const range = (req.query && req.query.range) || "30d";

      const quotaCfg = storage.getNodeSettings(nodeId, config.default_reset_day);
      const history = storage.getNodeHistory(nodeId, quotaCfg.node_name);
      const forecast = calculateForecast(history, quotaCfg, config.warning_threshold);
      const series = buildChartSeries(history, range, forecast);

      sendJSON(res, {
        ok: true,
        node_id: nodeId,
        node_name: quotaCfg.node_name || nodeId,
        quota_config: quotaCfg,
        range,
        forecast: Object.assign({}, forecast, {
          cumulative: Object.assign({}, forecast.cumulative, {
            in_formatted: formatBytes(forecast.cumulative.in_bytes),
            out_formatted: formatBytes(forecast.cumulative.out_bytes),
            total_formatted: formatBytes(forecast.cumulative.total_bytes),
          }),
          daily_avg: Object.assign({}, forecast.daily_avg, {
            in_formatted: formatBytes(forecast.daily_avg.in_bytes),
            out_formatted: formatBytes(forecast.daily_avg.out_bytes),
            total_formatted: formatBytes(forecast.daily_avg.total_bytes),
          }),
          projected: Object.assign({}, forecast.projected, {
            in_formatted: formatBytes(forecast.projected.in_bytes),
            out_formatted: formatBytes(forecast.projected.out_bytes),
            total_formatted: formatBytes(forecast.projected.total_bytes),
          }),
          quota_formatted: formatBytes(forecast.quota),
        }),
        chart_series: series,
      });
    } catch (e) {
      sendJSON(res, { ok: false, error: e.message || String(e) }, 500);
    }
  });

  // 3. 更新节点限额与重置日配置
  server.route("POST", "/api/plugin/net-forecast/update-quota", (req, res) => {
    try {
      const data = parseBody(req.body);
      const nodeId = data.node_id;
      if (!nodeId) {
        sendJSON(res, { ok: false, error: "Missing node_id" }, 400);
        return;
      }
      storage.saveNodeSettings(nodeId, {
        node_name: data.node_name,
        quota_bytes: Number(data.quota_bytes) >= 0 ? Number(data.quota_bytes) : 0,
        reset_day: Math.max(1, Math.min(31, Number(data.reset_day) || 1)),
      });
      sendJSON(res, {
        ok: true,
        message: "Settings updated successfully",
        settings: storage.getNodeSettings(nodeId),
      });
    } catch (e) {
      sendJSON(res, { ok: false, error: e.message || String(e) }, 500);
    }
  });

  // 4. 同步节点数据
  server.route("POST", "/api/plugin/net-forecast/sync-nodes", (req, res) => {
    try {
      const data = parseBody(req.body);
      const nodes = Array.isArray(data.nodes) ? data.nodes : [];
      nodes.forEach((n) => {
        const id = n.uuid || n.id || n.node_id;
        if (id) {
          const existing = storage.getNodeSettings(id);
          storage.saveNodeSettings(id, {
            node_name: n.name || existing.node_name || id,
            quota_bytes: n.traffic_limit ? Number(n.traffic_limit) : existing.quota_bytes,
            reset_day: n.traffic_reset_day ? Number(n.traffic_reset_day) : existing.reset_day,
          });
          if (typeof n.net_in === "number" && typeof n.net_out === "number") {
            storage.recordSample(id, n.net_in, n.net_out);
          }
        }
      });
      sendJSON(res, { ok: true, synced_count: nodes.length });
    } catch (e) {
      sendJSON(res, { ok: false, error: e.message || String(e) }, 500);
    }
  });

  // 5. 状态健康检查
  server.route("GET", "/api/plugin/net-forecast/status", (req, res) => {
    sendJSON(res, {
      ok: true,
      plugin: "net-forecast",
      version: "1.0.0",
      timestamp: new Date().toISOString(),
    });
  });

  // 6. RPC 注册
  server.registerRPC("netForecast:getOverview", () => {
    const config = getConfig();
    const all = storage.getAllSettings();
    return {
      ok: true,
      nodes: Object.keys(all).map((id) => {
        const q = storage.getNodeSettings(id, config.default_reset_day);
        const h = storage.getNodeHistory(id, q.node_name);
        return {
          id,
          forecast: calculateForecast(h, q, config.warning_threshold),
        };
      }),
    };
  });
}

function unload() {
  console.log("[NetForecast] Plugin unloaded.");
}

// 导出为 CommonJS 规范 (供兼容及测试)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { load, unload };
}
