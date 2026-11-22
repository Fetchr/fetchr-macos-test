import { useEffect, useState, type CSSProperties, type ImgHTMLAttributes } from "react";

import { cn } from "@/lib/utils";
import { type Platform } from "@/lib/url";

import styles from "./RemoteImage.module.css";

type RemoteImageState = "idle" | "loading" | "loaded" | "error";

export interface RemoteImageProps
  extends Omit<ImgHTMLAttributes<HTMLImageElement>, "alt" | "children" | "src"> {
  src?: string | null;
  alt: string;
  fallbackLabel?: string | null;
  platform?: Platform | string | null;
  platformBadge?: string | null;
  aspectRatio?: string;
  fit?: "cover" | "contain";
}

export function RemoteImage({
  src,
  alt,
  fallbackLabel,
  platform,
  platformBadge,
  aspectRatio = "16 / 9",
  fit = "cover",
  className,
  style,
  loading = "lazy",
  referrerPolicy = "no-referrer",
  onError,
  onLoad,
  ...imageProps
}: RemoteImageProps) {
  const [state, setState] = useState<RemoteImageState>(src ? "loading" : "idle");

  useEffect(() => {
    setState(src ? "loading" : "idle");
  }, [src]);

  const showImage = Boolean(src) && state !== "error";
  const showSpinner = Boolean(src) && state === "loading";
  const rootStyle = {
    ...style,
    "--remote-image-aspect-ratio": aspectRatio,
    "--remote-image-fit": fit,
  } as CSSProperties;

  return (
    <div
      className={cn(styles.root, state === "error" && styles.error, className)}
      data-state={state}
      data-platform={platform?.toLowerCase() || undefined}
      style={rootStyle}
    >
      {showImage && (
        <img
          {...imageProps}
          alt={alt}
          className={cn(styles.image, state === "loaded" && styles.imageLoaded)}
          loading={loading}
          referrerPolicy={referrerPolicy}
          src={src ?? undefined}
          onError={(event) => {
            setState("error");
            onError?.(event);
          }}
          onLoad={(event) => {
            setState("loaded");
            onLoad?.(event);
          }}
        />
      )}

      {showSpinner && <div className={styles.spinner} aria-hidden />}
    </div>
  );
}

