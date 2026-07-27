import dotenv from "dotenv";
import postgres from "postgres";

dotenv.config({ path: ".env.local" });

type SeedUser = {
  name: string;
  email: string | undefined;
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set (check .env.local)");
  }

  const users: SeedUser[] = [
    {
      name: process.env.SEED_USER_1_NAME ?? "Rob",
      email: process.env.SEED_USER_1_EMAIL,
    },
    {
      name: process.env.SEED_USER_2_NAME ?? "Dudley",
      email: process.env.SEED_USER_2_EMAIL,
    },
  ];

  for (const user of users) {
    if (!user.email) {
      throw new Error(
        `Missing seed email for ${user.name}. Set SEED_USER_*_EMAIL in .env.local`,
      );
    }
  }

  const sql = postgres(databaseUrl, { max: 1 });

  for (const user of users) {
    await sql`
      insert into users (email, name)
      values (${user.email!}, ${user.name})
      on conflict (email) do update
        set name = excluded.name
    `;
    console.log(`Seeded user: ${user.email}`);
  }

  await sql.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
