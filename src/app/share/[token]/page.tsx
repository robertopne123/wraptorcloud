import { resolveShare } from "@/lib/share";
import { ShareView } from "./share-view";

export const dynamic = "force-dynamic";

function ExpiredMessage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-4 dark:bg-black">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        This link has expired or doesn&apos;t exist.
      </p>
    </div>
  );
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolution = await resolveShare(token);

  if (resolution.kind === "not-found" || resolution.kind === "forbidden") {
    return <ExpiredMessage />;
  }

  if (resolution.kind === "file") {
    return (
      <ShareView
        token={token}
        permission={resolution.permission}
        data={{ type: "file", file: resolution.file }}
      />
    );
  }

  return (
    <ShareView
      token={token}
      permission={resolution.permission}
      data={{
        type: "folder",
        sharedFolder: resolution.sharedFolder,
        folder: resolution.folder,
        breadcrumb: resolution.breadcrumb,
        folders: resolution.folders,
        files: resolution.files,
      }}
    />
  );
}
