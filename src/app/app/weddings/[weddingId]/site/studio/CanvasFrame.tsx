"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const BLANK = "<!DOCTYPE html><html><head></head><body></body></html>";

/**
 * Studio's canvas viewport (STUDIO-01): a same-origin iframe the site is
 * rendered INTO with a React portal, so the theme's own responsive rules
 * see the iframe's width (a real 390 px phone, not a squeezed desktop) while
 * the page stays one React tree (state, events, no messaging). The app's
 * stylesheets are copied in once; the site never loads anything else. The
 * frame never navigates: links inside are neutralized by the canvas.
 */
export function CanvasFrame({
  title,
  width,
  children,
  testId,
}: {
  title: string;
  width: string;
  children: ReactNode;
  testId?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const setUp = () => {
      const doc = element.contentDocument;
      if (!doc || !doc.body || doc.URL !== "about:srcdoc" || doc.body.dataset.studioCanvas === "ready") return;
      doc.documentElement.lang = document.documentElement.lang;
      doc.documentElement.className = document.documentElement.className;
      const meta = doc.createElement("meta");
      meta.name = "viewport";
      meta.content = "width=device-width, initial-scale=1";
      doc.head.appendChild(meta);
      for (const node of document.head.querySelectorAll('link[rel="stylesheet"], style')) {
        doc.head.appendChild(node.cloneNode(true));
      }
      doc.body.className = document.body.className;
      doc.body.dataset.studioCanvas = "ready";
      setBody(doc.body);
    };
    setUp();
    element.addEventListener("load", setUp);
    return () => element.removeEventListener("load", setUp);
  }, []);

  return (
    <>
      <iframe
        ref={frame}
        srcDoc={BLANK}
        title={title}
        data-testid={testId}
        className="mx-auto block h-full rounded-xl border border-border bg-background shadow-sm transition-[width] duration-300 motion-reduce:transition-none"
        style={{ width, maxWidth: "100%" }}
      />
      {body ? createPortal(children, body) : null}
    </>
  );
}
