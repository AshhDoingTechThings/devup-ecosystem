"use client";

import { CSSProperties, MouseEvent, ReactNode, useState } from "react";
import { api } from "@/lib/api/client";

/**
 * Opens an issued document (offer letter, certificate…).
 *
 * Files are private; the link in a list response is signed for a few minutes
 * only. Clicking asks the API for a fresh link at that moment, so a page left
 * open for an hour still downloads. The new tab is opened synchronously inside
 * the click (then pointed at the link) so Safari's popup blocker allows it.
 */
export default function DocumentFileLink({
  docId,
  href,
  scope,
  className,
  style,
  children,
}: {
  docId: string;
  /** The link from the list response — used for middle-click / copy link. */
  href?: string | null;
  /** "me" for the signed-in person's own documents, or the workspace code for HR. */
  scope: "me" | { code: string };
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);

  const onClick = async (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let the browser handle it
    e.preventDefault();
    setError(null);
    const tab = window.open("", "_blank");
    try {
      const path =
        scope === "me"
          ? `/api/me/documents/${docId}/file`
          : `/api/w/${scope.code}/documents/${docId}/file`;
      const { url } = await api.get<{ url: string }>(path);
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.assign(url);
      }
    } catch (err) {
      // Fall back to the link the list came with (still valid for a few
      // minutes, and the only link an older API version provides).
      if (href) {
        if (tab) {
          tab.opener = null;
          tab.location.href = href;
        } else {
          window.location.assign(href);
        }
        return;
      }
      tab?.close();
      setError(err instanceof Error ? err.message : "Could not open the file");
    }
  };

  return (
    <>
      <a href={href ?? "#"} onClick={onClick} target="_blank" rel="noopener noreferrer" className={className} style={style}>
        {children}
      </a>
      {error && (
        <span role="alert" className="text-[10.5px] text-red-400">
          {error}
        </span>
      )}
    </>
  );
}
