import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1rem" },
    extend: {
      /* Единственный источник значений — src/ui/redesign/theme/fetchrTokens.css.
         Форма rgb(var(--x) / <alpha-value>) обязательна: в коде ~67 классов
         с альфой (bg-accent/15, border-danger/30 и т.п.). */
      colors: {
        canvas: "rgb(var(--fetchr-rgb-canvas) / <alpha-value>)",
        surface: "rgb(var(--fetchr-rgb-surface) / <alpha-value>)",
        elevated: "rgb(var(--fetchr-rgb-elevated) / <alpha-value>)",
        overlay: "rgb(var(--fetchr-rgb-overlay) / <alpha-value>)",

        "border-subtle": "rgb(var(--fetchr-rgb-border-subtle) / <alpha-value>)",
        "border-default": "rgb(var(--fetchr-rgb-border) / <alpha-value>)",
        "border-strong": "rgb(var(--fetchr-rgb-border-strong) / <alpha-value>)",

        "fg-primary": "rgb(var(--fetchr-rgb-text) / <alpha-value>)",
        "fg-secondary": "rgb(var(--fetchr-rgb-text-secondary) / <alpha-value>)",
        "fg-tertiary": "rgb(var(--fetchr-rgb-text-tertiary) / <alpha-value>)",
        "fg-disabled": "rgb(var(--fetchr-rgb-text-disabled) / <alpha-value>)",

        accent: {
          DEFAULT: "rgb(var(--fetchr-accent-rgb) / <alpha-value>)",
          hover: "rgb(var(--fetchr-accent-hover-rgb) / <alpha-value>)",
          bright: "rgb(var(--fetchr-accent-bright-rgb) / <alpha-value>)",
          muted: "rgb(var(--fetchr-rgb-accent-muted) / <alpha-value>)",
          fg: "rgb(var(--fetchr-rgb-on-accent) / <alpha-value>)",
        },

        success: "rgb(var(--fetchr-success-rgb) / <alpha-value>)",
        warning: "rgb(var(--fetchr-warning-rgb) / <alpha-value>)",
        danger: "rgb(var(--fetchr-danger-rgb) / <alpha-value>)",
        live: "rgb(var(--fetchr-danger-rgb) / <alpha-value>)",

        // shadcn compatibility
        background: "rgb(var(--fetchr-rgb-canvas) / <alpha-value>)",
        foreground: "rgb(var(--fetchr-rgb-text) / <alpha-value>)",
        border: "rgb(var(--fetchr-rgb-border) / <alpha-value>)",
        input: "rgb(var(--fetchr-rgb-border) / <alpha-value>)",
        ring: "rgb(var(--fetchr-accent-rgb) / <alpha-value>)",
        muted: {
          DEFAULT: "rgb(var(--fetchr-rgb-elevated) / <alpha-value>)",
          foreground: "rgb(var(--fetchr-rgb-text-secondary) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "rgb(var(--fetchr-rgb-surface) / <alpha-value>)",
          foreground: "rgb(var(--fetchr-rgb-text) / <alpha-value>)",
        },
        card: {
          DEFAULT: "rgb(var(--fetchr-rgb-surface) / <alpha-value>)",
          foreground: "rgb(var(--fetchr-rgb-text) / <alpha-value>)",
        },
        primary: {
          DEFAULT: "rgb(var(--fetchr-accent-rgb) / <alpha-value>)",
          foreground: "rgb(var(--fetchr-rgb-on-accent) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "rgb(var(--fetchr-rgb-elevated) / <alpha-value>)",
          foreground: "rgb(var(--fetchr-rgb-text) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "rgb(var(--fetchr-danger-rgb) / <alpha-value>)",
          foreground: "rgb(var(--fetchr-rgb-on-accent) / <alpha-value>)",
        },
      },
      /* Высоты контролов — те же, что у примитивов в
         theme/primitives.module.css. Держим их в конфиге, а не в
         произвольных значениях h-[34px]: иначе Tailwind-остров снова
         разойдётся с CSS-модулями. */
      spacing: {
        control: "34px",
        "control-sm": "28px",
        "control-lg": "40px",
      },
      fontFamily: {
        sans: [
          "Inter Variable",
          "Inter",
          "Segoe UI",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono Variable",
          "JetBrains Mono",
          "Consolas",
          "monospace",
        ],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.02em" }],
      },
      /* Шкала DESIGN.md, синхронно с --fetchr-radius-* */
      borderRadius: {
        xs: "4px",
        sm: "6px",
        DEFAULT: "8px",
        md: "8px",
        lg: "10px",
        xl: "16px",
      },
      boxShadow: {
        /* Drop-shadow в системе нет: «overlay» теперь просто hairline */
        overlay: "0 0 0 1px rgb(var(--fetchr-rgb-border))",
        "focus-ring": "0 0 0 2px rgb(var(--fetchr-accent-rgb) / 0.5)",
      },
      keyframes: {
        pulseLive: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      /* Модалки анимирует framer-motion (modalOverlayMotion / modalContentMotion),
         поэтому утилит animate-modal-* здесь нет — они были без потребителей. */
      animation: {
        "pulse-live": "pulseLive 1.6s ease-in-out infinite",
        "fade-in": "fade-in 160ms cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-up": "slide-up 200ms cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
