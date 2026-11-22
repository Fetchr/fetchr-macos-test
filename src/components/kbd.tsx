import { cn } from "@/lib/utils";

interface KbdProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Keycap glyph per DESIGN.md: 4px radius, 20px tall, and the faint
 * surface-card -> surface gradient that gives the key its physical feel.
 */
export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-xs",
        "border border-border-default px-1.5 py-px",
        "bg-gradient-to-b from-overlay to-elevated",
        "font-mono text-[11px] font-medium text-fg-secondary",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
