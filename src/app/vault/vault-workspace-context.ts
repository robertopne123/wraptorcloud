"use client";

import { createContext, type MutableRefObject } from "react";

export type VaultSelectionKey = `folder:${string}` | `file:${string}`;
export const VaultWorkspaceContext = createContext<{
  dragItems: MutableRefObject<VaultSelectionKey[]>;
  sourceFolder: MutableRefObject<string | null>;
  movePending: MutableRefObject<boolean>;
  revision: number;
  changed: () => void;
} | null>(null);
