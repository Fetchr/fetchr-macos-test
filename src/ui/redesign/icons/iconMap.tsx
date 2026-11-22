import type { LucideIcon, LucideProps } from "lucide-react";
import {
  AlertCircle,
  ArrowDownToLine,
  Bell,
  Bookmark,
  Check,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUp,
  ChevronsDown,
  CircleDot,
  Clipboard,
  Clock,
  Cloud,
  Copy,
  Cpu,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  EyeOff,
  FileAudio,
  FileJson,
  FileVideo,
  Film,
  FolderOpen,
  Gauge,
  Globe,
  Home,
  Image,
  Info,
  KeyRound,
  Link2,
  ListChecks,
  ListFilter,
  LoaderCircle,
  Maximize2,
  MessageSquareText,
  Minus,
  MonitorPlay,
  Move,
  PanelLeft,
  Pause,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Twitch,
  Undo2,
  Video,
  WandSparkles,
  Volume2,
  X,
  Youtube,
  MicVocal,
  Server,
  VolumeX,
  Tv,
} from "lucide-react";

import { cn } from "@/lib/utils";

import { CUSTOM_PLATFORM_NODES, CUSTOM_REDESIGN_NODES } from "./motion/customNodes";
import { PLATFORM_ICON_NODES, REDESIGN_ICON_NODES } from "./motion/iconNodes.generated";
import { MotionSvg } from "./motion/MotionSvg";

export const redesignIcons = {
  add: Plus,
  alert: AlertCircle,
  apply: Check,
  audio: Volume2,
  mute: VolumeX,
  vocal: MicVocal,
  server: Server,
  bell: Bell,
  bookmark: Bookmark,
  blur: WandSparkles,
  chat: MessageSquareText,
  check: Check,
  arrowDown: ArrowDown,
  arrowUp: ArrowUp,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  chevronUp: ChevronUp,
  priorityHigh: ChevronsUp,
  priorityLow: ChevronsDown,
  priorityNormal: Minus,
  clear: X,
  clipboard: Clipboard,
  close: X,
  copy: Copy,
  cpu: Cpu,
  download: Download,
  expand: Maximize2,
  exportJson: FileJson,
  external: ExternalLink,
  fileAudio: FileAudio,
  fileVideo: FileVideo,
  finder: Search,
  folder: FolderOpen,
  hidden: EyeOff,
  home: Home,
  image: Image,
  info: Info,
  install: ArrowDownToLine,
  key: KeyRound,
  link: Link2,
  live: Radio,
  loading: LoaderCircle,
  logs: ListChecks,
  media: Film,
  more: Ellipsis,
  minimize: Minus,
  move: Move,
  pause: Pause,
  pencil: Pencil,
  performance: Gauge,
  play: Play,
  preset: SlidersHorizontal,
  preview: MonitorPlay,
  queue: ListFilter,
  refresh: RefreshCw,
  reset: RotateCcw,
  save: Save,
  secure: ShieldCheck,
  settings: Settings,
  sidebar: PanelLeft,
  source: Globe,
  sparkle: Sparkles,
  status: CircleDot,
  stop: Square,
  time: Clock,
  trash: Trash2,
  undo: Undo2,
  video: Video,
  visible: Eye,
} as const satisfies Record<string, LucideIcon>;

export const platformIcons = {
  hls: Cloud,
  kick: Radio,
  local: FolderOpen,
  rtmp: Radio,
  twitch: Twitch,
  unknown: Globe,
  vk: Video,
  wtv: Tv,
  youtube: Youtube,
} as const satisfies Record<string, LucideIcon>;

export type RedesignIconName = keyof typeof redesignIcons;
export type PlatformIconName = keyof typeof platformIcons;

export interface RedesignIconProps extends Omit<LucideProps, "ref"> {
  name: RedesignIconName;
}

export interface PlatformIconProps extends Omit<LucideProps, "ref"> {
  platform?: PlatformIconName | string | null;
}

export function RedesignIcon({
  name,
  className,
  strokeWidth = 1.8,
  ...props
}: RedesignIconProps) {
  const node = CUSTOM_REDESIGN_NODES[name] ?? REDESIGN_ICON_NODES[name];
  if (!node) {
    const Icon = redesignIcons[name];
    return <Icon aria-hidden className={cn("size-4", className)} strokeWidth={strokeWidth} {...props} />;
  }
  return (
    <MotionSvg
      motionKey={name}
      node={node}
      aria-hidden
      className={cn("size-4", className)}
      strokeWidth={strokeWidth}
      {...props}
    />
  );
}

export function PlatformIcon({
  platform,
  className,
  strokeWidth = 1.8,
  ...props
}: PlatformIconProps) {
  const key = normalizePlatformIcon(platform);
  const node = CUSTOM_PLATFORM_NODES[key] ?? PLATFORM_ICON_NODES[key];
  if (!node) {
    const Icon = platformIcons[key];
    return <Icon aria-hidden className={cn("size-4", className)} strokeWidth={strokeWidth} {...props} />;
  }
  return (
    <MotionSvg
      motionKey={key}
      node={node}
      aria-hidden
      className={cn("size-4", className)}
      strokeWidth={strokeWidth}
      {...props}
    />
  );
}

export function getRedesignIcon(name: RedesignIconName): LucideIcon {
  return redesignIcons[name];
}

export function getPlatformIcon(platform?: PlatformIconName | string | null): LucideIcon {
  return platformIcons[normalizePlatformIcon(platform)];
}

function normalizePlatformIcon(platform?: PlatformIconName | string | null): PlatformIconName {
  const key = platform?.toLowerCase();
  if (key && key in platformIcons) return key as PlatformIconName;
  return "unknown";
}
