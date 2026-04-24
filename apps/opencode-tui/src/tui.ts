import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createBackgroundTasksTuiRuntime } from "./runtime.ts";

const pluginId = "background-tasks-tui";

const readSessionID = (api: Parameters<TuiPlugin>[0]): string | undefined => {
  const route = api.route.current;
  const params = "params" in route ? route.params : undefined;
  return typeof params?.sessionID === "string" ? params.sessionID : undefined;
};

const tui: TuiPlugin = async (api, options, meta) => {
  const runtime = createBackgroundTasksTuiRuntime(api, options, meta);
  api.lifecycle.onDispose(() => {
    void runtime.runtime.dispose();
  });

  const off = api.command.register(() => [
    {
      value: "background-tasks.refresh",
      title: "Background Tasks: Refresh",
      category: "Background Tasks",
      onSelect: async () => {
        const sessionID = readSessionID(api);
        if (!sessionID) {
          api.ui.toast({ message: "No active session", variant: "warning" });
          return;
        }
        const tasks = await runtime.bridge.listTasks(sessionID);
        api.ui.toast({
          message: `${tasks.length} background task${tasks.length === 1 ? "" : "s"}`,
          variant: "info",
        });
      },
    },
  ]);
  api.lifecycle.onDispose(off);
};

export default {
  id: pluginId,
  tui,
} satisfies TuiPluginModule;
