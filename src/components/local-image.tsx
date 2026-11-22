import { useEffect, useState } from "react";

import { imageMimeFromPath, ipc } from "@/lib/ipc";

interface LocalImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> {
  path: string;
}

export function LocalImage({ path, alt = "", ...props }: LocalImageProps) {
  const src = useLocalImageSrc(path);
  if (!src) return null;
  return <img src={src} alt={alt} {...props} />;
}

export function useLocalImageSrc(path: string | null | undefined) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setSrc(null);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    void ipc
      .readImageFile(path)
      .then((bytes) => {
        if (cancelled) return;
        const blob = new Blob([bytes], { type: imageMimeFromPath(path) });
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  return src;
}
