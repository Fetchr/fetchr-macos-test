import { create } from "zustand";

import {
  EMPTY_HISTORY,
  pushEdit,
  redoEdit,
  undoEdit,
  type MuteEditState,
} from "@/ui/redesign/fetchr-mute/editModel";

/**
 * Неприменённые правки «Удалить маты». Живёт отдельно от страницы, чтобы
 * правки и стек отмены переживали уход на другие экраны, пока открыт файл.
 * Текущий набор правок собирается из стора и настроек страницы; здесь —
 * только то, с чем собран файл результата, и история правок.
 */
interface FetchrMuteEditsState {
  /** Набор правок, с которым собран текущий файл результата; null — результата нет. */
  applied: MuteEditState | null;
  past: MuteEditState[];
  future: MuteEditState[];
  setApplied: (state: MuteEditState | null) => void;
  /** Снимок до правки: новая правка обнуляет «повторить». */
  record: (before: MuteEditState) => void;
  /** Состояние, к которому нужно вернуться, или null — отменять нечего. */
  undo: (current: MuteEditState) => MuteEditState | null;
  redo: (current: MuteEditState) => MuteEditState | null;
  reset: () => void;
}

export const useFetchrMuteEditsStore = create<FetchrMuteEditsState>((set, get) => ({
  applied: null,
  past: [],
  future: [],
  setApplied: (applied) => set({ applied }),
  record: (before) => set((state) => pushEdit(state, before)),
  undo: (current) => {
    const result = undoEdit(get(), current);
    if (!result) return null;
    set(result.history);
    return result.state;
  },
  redo: (current) => {
    const result = redoEdit(get(), current);
    if (!result) return null;
    set(result.history);
    return result.state;
  },
  reset: () => set({ applied: null, ...EMPTY_HISTORY }),
}));
