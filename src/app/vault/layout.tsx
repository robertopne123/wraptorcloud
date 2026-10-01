import type { ReactNode } from "react";
import { UploadProvider } from "./upload-provider";
import { TransferPanel } from "./transfer-panel";

export default function VaultLayout({ children }: { children: ReactNode }) {
  return <UploadProvider>{children}<TransferPanel /></UploadProvider>;
}
