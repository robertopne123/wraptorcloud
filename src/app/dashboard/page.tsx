import { Suspense } from "react";
import { listFiles } from "@/lib/db/queries";
import { UploadDashboard } from "./upload-dashboard";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const files = await listFiles();

  return (
    <Suspense>
      <UploadDashboard initialFiles={files} />
    </Suspense>
  );
}
