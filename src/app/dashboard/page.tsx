import { listUsers } from "@/lib/db/queries";

export default async function DashboardPage() {
  const users = await listUsers();

  return (
    <div className="flex min-h-screen flex-1 flex-col items-center justify-center gap-4 bg-zinc-50 dark:bg-black">
      <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        Wraptor Vault
      </h1>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Dashboard placeholder — file browser lands in Stage 3.
      </p>
      <ul className="text-sm text-zinc-700 dark:text-zinc-300">
        {users.map((user) => (
          <li key={user.id}>
            {user.name} ({user.email})
          </li>
        ))}
      </ul>
    </div>
  );
}
