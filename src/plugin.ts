import { definePlugin, jsonResponse, server } from "@komari-monitor/plugin-sdk";

export default definePlugin({
  async load() {
    console.log("[NetForecast] Plugin loaded successfully");

    // 注册基础状态检测路由
    server.route("GET", "/api/plugin/net-forecast/status", async (req, res) => {
      try {
        const config = server.getConfig?.() ?? {};
        jsonResponse(res, {
          ok: true,
          plugin: "net-forecast",
          version: "0.1.0",
          config,
          timestamp: new Date().toISOString(),
          message: "NetForecast plugin is running",
        });
      } catch (err: any) {
        res.statusCode = 500;
        jsonResponse(res, { ok: false, error: err.message });
      }
    });

    // 注册插件级 RPC 供前端或其他服务调用
    server.registerRPC("netForecast:getStatus", () => {
      return {
        ok: true,
        plugin: "net-forecast",
        timestamp: Date.now(),
      };
    });
  },

  async unload() {
    console.log("[NetForecast] Plugin unloaded");
  },
});
