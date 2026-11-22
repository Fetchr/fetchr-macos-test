import { useNavigate } from "@tanstack/react-router";

import { AddTaskModal } from "@/ui/redesign/add-task";
import { useUI } from "@/stores/ui";

export function AddDialog() {
  const open = useUI((state) => state.addDialogOpen);
  const close = useUI((state) => state.closeAddDialog);
  const navigate = useNavigate();

  return (
    <AddTaskModal
      open={open}
      onClose={close}
      onConfigureBlur={() => {
        close();
        void navigate({ to: "/sponsor-blur" });
      }}
    />
  );
}
