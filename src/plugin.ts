import { definePlugin, jsonResponse, server } from "@komari-monitor/plugin-sdk";
import { StorageManager } from "./storage";
import { buildChartSeries, calculateForecast, formatBytes } from "./forecast";
import { PluginConfig } from "./types";

export default definePlugin({
  async load() {
    console.log("[NetForecast] Plugin loaded, initializing storage and forecasting engine...");

    const storage = new StorageManager();

    // 获取插件托管配置
    const getPluginConfig = (): PluginConfig => {
      const raw = server.getConfig ? server.getConfig() : {};
      return {
        default_reset_day: Number(raw.default_reset_day) || 1,
        warning_threshold: Number(raw.warning_threshold) || 90,
        auto_collect_cron: raw.auto_collect_cron || "*/10 * * * *",
      };
    };

    /**
     * 辅助解析请求体 JSON
     */
    const parseBody = (body: string) => {
      try {
        return JSON.parse(body || "{}");
      } catch (e) {
        return {};
      }
    };

    // 1. 获取所有节点概览及预警汇总
    server.route("GET", "/api/plugin/net-forecast/overview", async (req, res) => {
      try {
        const config = getPluginConfig();
        const allSettings = storage.getAllNodeSettings();
        const nodeIds = Object.keys(allSettings);

        // 如果还没有节点，加入默认探测节点
        if (nodeIds.length === 0) {
          nodeIds.push("default-node");
          storage.saveNodeSettings("default-node", {
            node_id: "default-node",
            node_name: "主监控节点",
            quota_bytes: 1099511627776, // 1TB
            reset_day: config.default_reset_day,
          });
        }

        const nodesOverview = nodeIds.map((nodeId) => {
          const quotaConfig = storage.getNodeSettings(nodeId, config.default_reset_day);
          const history = storage.getNodeHistory(nodeId, quotaConfig.node_name);
          const forecast = calculateForecast(history, quotaConfig, config.warning_threshold);

          return {
            node_id: nodeId,
            node_name: quotaConfig.node_name || nodeId,
            quota_bytes: quotaConfig.quota_bytes,
            quota_formatted: formatBytes(quotaConfig.quota_bytes),
            reset_day: quotaConfig.reset_day,
            cycle: forecast.cycle,
            cumulative: {
              ...forecast.cumulative,
              in_formatted: formatBytes(forecast.cumulative.in_bytes),
              out_formatted: formatBytes(forecast.cumulative.out_bytes),
              total_formatted: formatBytes(forecast.cumulative.total_bytes),
            },
            daily_avg: {
              ...forecast.daily_avg,
              total_formatted: formatBytes(forecast.daily_avg.total_bytes),
            },
            projected: {
              ...forecast.projected,
              total_formatted: formatBytes(forecast.projected.total_bytes),
            },
            usage_ratio_current: forecast.usage_ratio_current,
            usage_ratio_projected: forecast.usage_ratio_projected,
            status: forecast.status,
            days_until_exhaustion: forecast.days_until_exhaustion,
            exhaustion_date: forecast.exhaustion_date,
            warning_message: forecast.warning_message,
          };
        });

        // 统计总警告数量
        const criticalCount = nodesOverview.filter((n) => n.status === "CRITICAL").length;
        const warningCount = nodesOverview.filter((n) => n.status === "WARNING").length;

        jsonResponse(res, {
          ok: true,
          config,
          summary: {
            total_nodes: nodesOverview.length,
            critical_count: criticalCount,
            warning_count: warningCount,
          },
          nodes: nodesOverview,
        });
      } catch (err: any) {
        res.statusCode = 500;
        jsonResponse(res, { ok: false, error: err.message || String(err) });
      }
    });

    // 2. 获取单个节点的详细历史与未来预测时间序列 (支持 1d/7d/30d)
    server.route("GET", "/api/plugin/net-forecast/node-data", async (req, res) => {
      try {
        const config = getPluginConfig();
        const nodeId = req.query.node_id || "default-node";
        const range = (req.query.range || "30d") as "1d" | "7d" | "30d";

        const quotaConfig = storage.getNodeSettings(nodeId, config.default_reset_day);
        const history = storage.getNodeHistory(nodeId, quotaConfig.node_name);
        const forecast = calculateForecast(history, quotaConfig, config.warning_threshold);
        const series = buildChartSeries(history, range, forecast);

        jsonResponse(res, {
          ok: true,
          node_id: nodeId,
          node_name: quotaConfig.node_name || nodeId,
          quota_config: quotaConfig,
          range,
          forecast: {
            ...forecast,
            cumulative: {
              ...forecast.cumulative,
              in_formatted: formatBytes(forecast.cumulative.in_bytes),
              out_formatted: formatBytes(forecast.cumulative.out_bytes),
              total_formatted: formatBytes(forecast.cumulative.total_bytes),
            },
            daily_avg: {
              ...forecast.daily_avg,
              in_formatted: formatBytes(forecast.daily_avg.in_bytes),
              out_formatted: formatBytes(forecast.daily_avg.out_bytes),
              total_formatted: formatBytes(forecast.daily_avg.total_bytes),
            },
            projected: {
              ...forecast.projected,
              in_formatted: formatBytes(forecast.projected.in_bytes),
              out_formatted: formatBytes(forecast.projected.out_bytes),
              total_formatted: formatBytes(forecast.projected.total_bytes),
            },
            quota_formatted: formatBytes(forecast.quota),
          },
          chart_series: series,
        });
      } catch (err: any) {
        res.statusCode = 500;
        jsonResponse(res, { ok: false, error: err.message || String(err) });
      }
    });

    // 3. 更新节点限额与重置日配置
    server.route("POST", "/api/plugin/net-forecast/update-quota", async (req, res) => {
      try {
        const data = parseBody(req.body);
        const nodeId = data.node_id;
        if (!nodeId) {
          res.statusCode = 400;
          jsonResponse(res, { ok: false, error: "Missing node_id" });
          return;
        }

        storage.saveNodeSettings(nodeId, {
          node_name: data.node_name,
          quota_bytes: Number(data.quota_bytes) >= 0 ? Number(data.quota_bytes) : 0,
          reset_day: Math.max(1, Math.min(31, Number(data.reset_day) || 1)),
          traffic_limit_type: data.traffic_limit_type || "sum",
        });

        jsonResponse(res, {
          ok: true,
          message: "Node quota and reset day updated successfully",
          settings: storage.getNodeSettings(nodeId),
        });
      } catch (err: any) {
        res.statusCode = 500;
        jsonResponse(res, { ok: false, error: err.message || String(err) });
      }
    });

    // 4. 同步节点信息列表（从前端或服务端同步最新的节点名与当前流量数据）
    server.route("POST", "/api/plugin/net-forecast/sync-nodes", async (req, res) => {
      try {
        const data = parseBody(req.body);
        const nodes = Array.isArray(data.nodes) ? data.nodes : [];

        for (const n of nodes) {
          const id = n.uuid || n.id || n.node_id;
          if (id) {
            const existing = storage.getNodeSettings(id);
            storage.saveNodeSettings(id, {
              node_name: n.name || existing.node_name || id,
              quota_bytes: n.traffic_limit ? Number(n.traffic_limit) : existing.quota_bytes,
              reset_day: n.traffic_reset_day ? Number(n.traffic_reset_day) : existing.reset_day,
            });

            // 如果节点上报了当前流量累计
            if (typeof n.net_in === "number" && typeof n.net_out === "number") {
              storage.recordSample(id, n.net_in, n.net_out);
            }
          }
        }

        jsonResponse(res, { ok: true, synced_count: nodes.length });
      } catch (err: any) {
        res.statusCode = 500;
        jsonResponse(res, { ok: false, error: err.message || String(err) });
      }
    });

    // 5. 注册 RPC 方法
    server.registerRPC("netForecast:getOverview", () => {
      const config = getPluginConfig();
      const allSettings = storage.getAllNodeSettings();
      const nodeIds = Object.keys(allSettings);
      return {
        ok: true,
        count: nodeIds.length,
        nodes: nodeIds.map((id) => {
          const quota = storage.getNodeSettings(id, config.default_reset_day);
          const history = storage.getNodeHistory(id, quota.node_name);
          return {
            id,
            forecast: calculateForecast(history, quota, config.warning_threshold),
          };
        }),
      };
    });

    // 6. 定时轮询与数据同步 Cron
    const config = getPluginConfig();
    try {
      server.cron(config.auto_collect_cron, async () => {
        // 定时尝试调用系统 RPC 刷新节点状态
        try {
          if (server.call) {
            const nodes = await server.call("admin:getNodes").catch(() => null);
            if (Array.isArray(nodes)) {
              for (const n of nodes) {
                if (n.uuid && typeof n.net_in === "number" && typeof n.net_out === "number") {
                  storage.recordSample(n.uuid, n.net_in, n.net_out);
                }
              }
            }
          }
        } catch (e) {
          // ignore cron poll errors
        }
      });
    } catch (e) {
      console.warn("[NetForecast] Cron registration notice:", e);
    }
  },

  async unload() {
    console.log("[NetForecast] Plugin unloaded cleanly.");
  },
});
