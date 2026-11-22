import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-focus-ring disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent",
        secondary:
          "bg-elevated text-fg-primary border border-border-default hover:bg-overlay",
        ghost:
          "bg-transparent text-fg-secondary hover:bg-elevated hover:text-fg-primary",
        outline:
          "bg-transparent text-fg-primary border border-border-default hover:bg-elevated",
        danger:
          "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
      },
      /* Высоты те же, что у примитива в theme/primitives.module.css:
         buttonSmall 28, button 34, buttonHero 40, buttonIcon 34×34.
         Прежние 28/32/36 были собственной шкалой и расходились с ним.
         Иконочная кнопка не опускается ниже 24×24 — минимум WCAG 2.2. */
      size: {
        sm: "h-control-sm px-2.5 text-[12px]",
        md: "h-control px-3.5",
        lg: "h-control-lg px-4 text-sm",
        icon: "h-control w-control",
        "icon-sm": "h-6 w-6",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
