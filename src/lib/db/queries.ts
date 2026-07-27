import { sql } from "./client";
import type { User } from "./types";

export async function listUsers(): Promise<User[]> {
  return sql<User[]>`select id, email, name, created_at from users order by name`;
}
