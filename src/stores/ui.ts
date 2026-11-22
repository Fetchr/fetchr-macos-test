import { create } from "zustand";

export interface AddDialogPrefill {
  url: string;
  /** AddTaskSource id ("twitch" | "m3u8" | ...). */
  source?: string;
  name?: string;
}

interface UIState {
  paletteOpen: boolean;
  /** Простой режим: окно поиска и скачивания поверх страницы */
  downloadOpen: boolean;
  downloadPrefill: string | null;
  openDownload: () => void;
  openDownloadWith: (query: string) => void;
  consumeDownloadPrefill: () => string | null;
  closeDownload: () => void;
  toggleDownload: () => void;
  addDialogOpen: boolean;
  addDialogPrefill: AddDialogPrefill | null;
  newsOpen: boolean;
  presetPanelCollapsed: boolean;
  /** Окно «Что нового»: новости версии после её установки. */
  whatsNewOpen: boolean;
  tourOpen: boolean;
  openTour: () => void;
  closeTour: () => void;
  pendingSettingsTab: string | null;
  setPendingSettingsTab: (tab: string | null) => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  openAddDialog: () => void;
  openAddDialogWith: (prefill: AddDialogPrefill) => void;
  consumeAddDialogPrefill: () => AddDialogPrefill | null;
  closeAddDialog: () => void;
  openNews: () => void;
  closeNews: () => void;
  toggleNews: () => void;
  togglePresetPanel: () => void;
  openWhatsNew: () => void;
  closeWhatsNew: () => void;
}

export const useUI = create<UIState>((set, get) => ({
  paletteOpen: false,
  downloadOpen: false,
  downloadPrefill: null,
  openDownload: () => set({ downloadOpen: true }),
  openDownloadWith: (query) => set({ downloadOpen: true, downloadPrefill: query }),
  consumeDownloadPrefill: () => {
    const prefill = get().downloadPrefill;
    if (prefill) set({ downloadPrefill: null });
    return prefill;
  },
  closeDownload: () => set({ downloadOpen: false, downloadPrefill: null }),
  toggleDownload: () => set((s) => ({ downloadOpen: !s.downloadOpen })),
  addDialogOpen: false,
  addDialogPrefill: null,
  newsOpen: false,
  presetPanelCollapsed: false,
  whatsNewOpen: false,
  tourOpen: false,
  openTour: () => set({ tourOpen: true }),
  closeTour: () => set({ tourOpen: false }),
  pendingSettingsTab: null,
  setPendingSettingsTab: (tab) => set({ pendingSettingsTab: tab }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  openAddDialog: () => set({ addDialogOpen: true, addDialogPrefill: null }),
  openAddDialogWith: (prefill) => set({ addDialogOpen: true, addDialogPrefill: prefill }),
  consumeAddDialogPrefill: () => {
    const prefill = get().addDialogPrefill;
    if (prefill) set({ addDialogPrefill: null });
    return prefill;
  },
  closeAddDialog: () => set({ addDialogOpen: false, addDialogPrefill: null }),
  openNews: () => set({ newsOpen: true }),
  closeNews: () => set({ newsOpen: false }),
  toggleNews: () => set((s) => ({ newsOpen: !s.newsOpen })),
  togglePresetPanel: () => set((s) => ({ presetPanelCollapsed: !s.presetPanelCollapsed })),
  openWhatsNew: () => set({ whatsNewOpen: true }),
  closeWhatsNew: () => set({ whatsNewOpen: false }),
}));
