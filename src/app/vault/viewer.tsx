"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Lightbox, { type RenderSlideProps, type Slide } from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Captions from "yet-another-react-lightbox/plugins/captions";
import Download from "yet-another-react-lightbox/plugins/download";
import Video from "yet-another-react-lightbox/plugins/video";
import "yet-another-react-lightbox/styles.css";
import "yet-another-react-lightbox/plugins/captions.css";
import type { FileRecord } from "@/lib/db/types";

type SlideStatus = "loading" | "ready" | "error";

type ResolvedSlide =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; url: string };

type VaultSlide = Slide & {
  fileId: string;
  title: string;
  status: SlideStatus;
};

function buildSlide(file: FileRecord, resolved: ResolvedSlide | undefined): VaultSlide {
  const base = { fileId: file.id, title: file.display_name };

  if (resolved?.status === "ready") {
    if (file.media_type === "video") {
      return {
        ...base,
        status: "ready",
        type: "video",
        controls: true,
        autoPlay: false,
        sources: [{ src: resolved.url, type: file.mime_type }],
      };
    }
    return { ...base, status: "ready", type: "image", src: resolved.url };
  }

  // src is never actually read for a non-"ready" slide — renderSlide()
  // intercepts it first — but SlideImage requires the field structurally.
  return { ...base, status: resolved?.status === "error" ? "error" : "loading", src: "" };
}

function Spinner() {
  return (
    <div
      className="h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-white"
      role="status"
      aria-label="Loading"
    />
  );
}

// Only reached for slides not yet resolved: the Video plugin intercepts
// type: "video" slides directly, and the Zoom plugin falls back to its own
// (fully zoomable) image renderer whenever this returns nothing.
function renderSlide({ slide }: RenderSlideProps) {
  const vaultSlide = slide as VaultSlide;
  if (vaultSlide.status === "ready") return undefined;

  return (
    <div className="flex h-full w-full items-center justify-center">
      {vaultSlide.status === "error" ? (
        <p className="text-sm text-white">Couldn&apos;t load this file.</p>
      ) : (
        <Spinner />
      )}
    </div>
  );
}

export function MediaViewer({
  files,
  index,
  onClose,
  onIndexChange,
  getViewUrl = (fileId) => `/api/files/${fileId}/view-url`,
  getDownloadUrl = (fileId) => `/api/files/${fileId}/view-url?disposition=attachment`,
  allowDownload = true,
}: {
  files: FileRecord[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  // Overridable so the public share page can point at its own
  // share-scoped, permission-checked presign routes instead of the
  // private /api/files/:id/view-url ones.
  getViewUrl?: (fileId: string) => string;
  getDownloadUrl?: (fileId: string) => string;
  // Hides the Download button entirely for view-only shares. The real
  // enforcement lives server-side in the presign route — this is just so
  // the UI doesn't offer a control that would be rejected anyway.
  allowDownload?: boolean;
}) {
  const [resolved, setResolved] = useState<Record<string, ResolvedSlide>>({});
  const requestedRef = useRef<Set<string>>(new Set());

  const resolveFile = useCallback(
    (file: FileRecord | undefined) => {
      if (!file || requestedRef.current.has(file.id)) return;
      requestedRef.current.add(file.id);

      setResolved((prev) => ({ ...prev, [file.id]: { status: "loading" } }));

      fetch(getViewUrl(file.id))
        .then((res) => {
          if (!res.ok) throw new Error("Could not load file");
          return res.json();
        })
        .then((data: { url: string }) => {
          setResolved((prev) => ({ ...prev, [file.id]: { status: "ready", url: data.url } }));
        })
        .catch(() => {
          setResolved((prev) => ({ ...prev, [file.id]: { status: "error" } }));
        });
    },
    [getViewUrl],
  );

  // Kick off the first slide's fetch as soon as the viewer opens; on.view
  // covers every navigation after that.
  useEffect(() => {
    resolveFile(files[index]);
    // Only re-run for the slide the viewer was opened on — subsequent
    // navigation is driven by the on.view callback below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const slides = useMemo(
    () => files.map((file) => buildSlide(file, resolved[file.id])),
    [files, resolved],
  );

  return (
    <Lightbox
      open
      close={onClose}
      index={index}
      slides={slides}
      on={{
        view: ({ index: nextIndex }) => {
          onIndexChange(nextIndex);
          resolveFile(files[nextIndex]);
        },
      }}
      controller={{ closeOnBackdropClick: true, closeOnEscape: true }}
      video={{ controls: true, autoPlay: false }}
      render={{ slide: renderSlide }}
      plugins={allowDownload ? [Zoom, Captions, Download, Video] : [Zoom, Captions, Video]}
      download={
        allowDownload
          ? {
              download: async ({ slide, saveAs }) => {
                const vaultSlide = slide as VaultSlide;
                const res = await fetch(getDownloadUrl(vaultSlide.fileId));
                if (!res.ok) return;
                const data: { url: string } = await res.json();
                saveAs(data.url, vaultSlide.title);
              },
            }
          : undefined
      }
    />
  );
}
