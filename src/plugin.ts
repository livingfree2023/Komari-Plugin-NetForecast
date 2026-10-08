import { definePlugin, jsonResponse, server } from "@komari-monitor/plugin-sdk";
import { StorageManager } from "./storage";
import { calculateNodeForecast } from "./forecast";
import { NodeCoreConfig, PluginConfig } from "./types";

export default definePlugin({
  async load() {
    console.log("[NetForecast] Plugin loaded. Direct database sync mode active (no local settings caching).");

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

    /**
     * 从 Komari 核心服务直接获取实时 Client 列表（永远以核心数据库为准）
     */
    const fetchCoreClients = async (fallbackClients?: NodeCoreConfig[]): Promise<NodeCoreConfig[]> => {
      // 1. 如果前端请求体中直接传入了最新读取的核心客户端列表，直接采用
      if (Array.isArray(fallbackClients) && fallbackClients.length > 0) {
        return fallbackClients;
      }

      // 2. 尝试通过内部 RPC 直接读取 Komari 核心数据库
      if (server.call) {
        try {
          const res = await server.call("admin:listClients").catch(() => null);
          if (Array.isArray(res) && res.length > 0) {
            return res;
          }
          const altRes = await server.call("common:getNodes").catch(() => null);
          if (Array.isArray(altRes) && altRes.length > 0) {
            return altRes;
          }
        } catch (e) {
          console.warn("[NetForecast] RPC call to core clients notice:", e);
        }
      }

      return [];
    };

    // 1. 获取所有节点 30 天流量堆叠与未来预测总览接口 (支持 GET 或 POST 附带最新核心客户端)
    const handleOverview = async (req: any, res: any) => {
      try {
        const config = getPluginConfig();
        const body = req.body ? parseBody(req.body) : {};
        let clients = await fetchCoreClients(body.clients);

        // 如果全新部署且未查到节点，提供优雅演示节点
        if (!clients || clients.length === 0) {
          clients = [
            {
              uuid: "node-demo-01",
              name: "主监控节点 (示例)",
              traffic_limit: 1099511627776, // 1TB
              traffic_limit_type: "sum",
              traffic_reset_day: config.default_reset_day,
            },
          ];
        }

        const nodesOverview = clients.map((client) => {
          const uuid = client.uuid;

          // 记录当前采样的网卡实时计数器增量
          if (typeof client.net_in === "number" && typeof client.net_out === "number") {
            storage.recordSample(uuid, client.net_in, client.net_out);
          }

          // 读取历史时间序列并结合核心数据库设置进行无缓存实时预测推算
          const history = storage.getNodeHistory(uuid);
          return calculateNodeForecast(history, client, config.warning_threshold);
        });

        // 状态统计
        const criticalCount = nodesOverview.filter((n) => n.status === "CRITICAL").length;
        const warningCount = nodesOverview.filter((n) => n.status === "WARNING").length;
        const safeCount = nodesOverview.filter((n) => n.status === "SAFE").length;
        const noQuotaCount = nodesOverview.filter((n) => n.status === "NO_QUOTA").length;

        jsonResponse(res, {
          ok: true,
          config,
          summary: {
            total_nodes: nodesOverview.length,
            critical_count: criticalCount,
            warning_count: warningCount,
            safe_count: safeCount,
            no_quota_count: noQuotaCount,
          },
          nodes: nodesOverview,
        });
      } catch (err: any) {
        res.statusCode = 500;
        jsonResponse(res, { ok: false, error: err.message || String(err) });
      }
    };

    server.route("GET", "/api/plugin/net-forecast/overview", handleOverview);
    server.route("POST", "/api/plugin/net-forecast/overview", handleOverview);

    // 2. 节点限额与计费类型修改：直接回写至 Komari 核心数据库，插件自身不落盘缓存
    server.route("POST", "/api/plugin/net-forecast/update-quota", async (req, res) => {
      try {
        const data = parseBody(req.body);
        const uuid = data.uuid || data.node_id;
        if (!uuid) {
          res.statusCode = 400;
          jsonResponse(res, { ok: false, error: "Missing uuid" });
          return;
        }

        const editPayload = {
          uuid: uuid,
          traffic_limit: Number(data.traffic_limit) >= 0 ? Number(data.traffic_limit) : 0,
          traffic_limit_type: data.traffic_limit_type || "sum",
          traffic_reset_day: Math.max(1, Math.min(31, Number(data.traffic_reset_day) || 1)),
        };

        // 直接调用 Komari 核心 RPC 写入数据库
        let rpcSuccess = false;
        if (server.call) {
          try {
            await server.call("admin:editClient", editPayload);
            rpcSuccess = true;
          } catch (rpcErr) {
            console.warn("[NetForecast] admin:editClient RPC failed:", rpcErr);
          }
        }

        jsonResponse(res, {
          ok: true,
          rpc_success: rpcSuccess,
          message: "Core database update requested",
          payload: editPayload,
        });
      } catch (err: any) {
        res.statusCode = 500;
        jsonResponse(res, { ok: false, error: err.message || String(err) });
      }
    });

    // 3. 定时轮询上报：定期从核心数据库拉取各节点最新流量计数并记录时间序列
    const config = getPluginConfig();
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
          // ignore background poll error
        }
      });
    } catch (e) {
      console.warn("[NetForecast] Cron registration notice:", e);
    }

    // 4. 注册 RPC 方法
    server.registerRPC("netForecast:getOverview", async () => {
      const config = getPluginConfig();
      const clients = await fetchCoreClients();
      return {
        ok: true,
        count: clients.length,
        nodes: clients.map((c) => {
          const history = storage.getNodeHistory(c.uuid);
          return calculateNodeForecast(history, c, config.warning_threshold);
        }),
      };
    });
  },

  async unload() {
    console.log("[NetForecast] Plugin unloaded.");
  },
});
