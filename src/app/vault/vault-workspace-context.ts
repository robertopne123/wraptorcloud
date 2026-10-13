"use client";

import { createContext } from "react";

export const VaultWorkspaceContext = createContext<{
  revision: number;
  changed: () => void;
} | null>(null);
