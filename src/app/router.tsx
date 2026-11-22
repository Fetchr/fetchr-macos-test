import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
} from "@tanstack/react-router";

import { AppLayout } from "@/components/app-layout";
import { ipc } from "@/lib/ipc";
import { QueuePage } from "@/features/queue/queue-page";

// Every page except the start one is its own chunk, so the entry bundle that
// has to parse before the splash paints stays small.
const pageLoaders = {
  logs: () => import("@/features/logs/logs-page"),
  settings: () => import("@/features/settings/settings-page"),
  finder: () => import("@/features/finder/finder-page"),
  chatRender: () => import("@/features/chat-render/chat-render-page"),
  sponsorBlur: () => import("@/features/sponsor-blur/sponsor-blur-page"),
  presets: () => import("@/features/presets/preset-builder-page"),
  fetchrMute: () => import("@/features/fetchr-mute/fetchr-mute-page"),
  vocalRemover: () => import("@/features/vocal-remover/vocal-remover-page"),
  liveRecorder: () => import("@/features/live-recorder/live-recorder-page"),
  vpsRecorder: () => import("@/features/vps-recorder/vps-recorder-page"),
};

/** Warms every page chunk once the app is idle, so a first visit is instant. */
export function preloadPages() {
  for (const load of Object.values(pageLoaders)) void load().catch(() => undefined);
}


const rootRoute = createRootRoute({
  component: () => (
    <AppLayout>
      <Outlet />
    </AppLayout>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw new Error("redirecting");
  },
  component: () => null,
});

const queueRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/queue",
  component: QueuePage,
});

const logsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/logs",
  component: lazyRouteComponent(pageLoaders.logs, "LogsPage"),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: lazyRouteComponent(pageLoaders.settings, "SettingsPage"),
});

const finderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/finder",
  component: lazyRouteComponent(pageLoaders.finder, "FinderPage"),
});

const chatRenderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat-render",
  component: lazyRouteComponent(pageLoaders.chatRender, "ChatRenderPage"),
});

const presetsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/presets",
  component: lazyRouteComponent(pageLoaders.presets, "PresetBuilderPage"),
});

const sponsorBlurRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sponsor-blur",
  component: lazyRouteComponent(pageLoaders.sponsorBlur, "SponsorBlurPage"),
});

const fetchrMuteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/fetchr-mute",
  component: lazyRouteComponent(pageLoaders.fetchrMute, "FetchrMutePage"),
});

const vocalRemoverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vocal-remover",
  component: lazyRouteComponent(pageLoaders.vocalRemover, "VocalRemoverPage"),
});

const liveRecorderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/live-recorder",
  component: lazyRouteComponent(pageLoaders.liveRecorder, "LiveRecorderPage"),
});

// Hidden until unlocked in Настройки → Интеграции; the nav entry is filtered
// out there, the route itself stays reachable so an unlock takes effect at once.
const vpsRecorderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/vps-recorder",
  component: lazyRouteComponent(pageLoaders.vpsRecorder, "VpsRecorderPage"),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  queueRoute,
  logsRoute,
  finderRoute,
  presetsRoute,
  chatRenderRoute,
  sponsorBlurRoute,
  fetchrMuteRoute,
  vocalRemoverRoute,
  liveRecorderRoute,
  vpsRecorderRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/queue"] }),
  defaultPreload: "intent",
  defaultErrorComponent: ({ error }) => (
    <pre
      style={{
        whiteSpace: "pre-wrap",
        padding: 16,
        color: "#ff6b6b",
        fontSize: 11,
        fontFamily: "monospace",
        userSelect: "text",
        overflow: "auto",
        maxHeight: "100vh",
      }}
    >
      {String((error as Error)?.stack ?? error)}
    </pre>
  ),
});

/** "/chat-render" → "chat_render"; the backend ignores names it does not know. */
export function screenOfPath(pathname: string): string {
  const name = pathname.replace(/^\/+|\/+$/g, "").split("/")[0] ?? "";
  return name ? name.replaceAll("-", "_") : "home";
}

router.subscribe("onResolved", ({ toLocation }) => {
  void ipc.trackScreen(screenOfPath(toLocation.pathname)).catch(() => undefined);
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
