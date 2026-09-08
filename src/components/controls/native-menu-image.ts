import { cloneElement, type ReactElement, type SVGProps } from "react";
import { Image } from "@tauri-apps/api/image";

/** Rasterize the same SVG used by the web menu without requiring native PNG support. */
export async function nativeMenuImage(icon: ReactElement): Promise<Image> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const svg = renderToStaticMarkup(
    cloneElement(icon as ReactElement<SVGProps<SVGSVGElement>>, {
      width: 14,
      height: 14,
      style: { width: 14, height: 14 },
      color: getComputedStyle(document.body).color,
      xmlns: "http://www.w3.org/2000/svg",
    }),
  );
  const source = new window.Image();
  await new Promise<void>((resolve, reject) => {
    source.onload = () => resolve();
    source.onerror = () => reject(new Error("Unable to load menu icon"));
    source.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 14;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to render menu icon");
  context.drawImage(source, 0, 0, 14, 14);
  return Image.new(
    new Uint8Array(context.getImageData(0, 0, 14, 14).data),
    14,
    14,
  );
}
