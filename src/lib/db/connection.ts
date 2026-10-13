export function databaseConnection(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const sharedPooler = url.hostname.endsWith(".pooler.supabase.com");
  // Honor the configured endpoint. Rewriting a session URL to transaction
  // pooling can stall parameterized queries during protocol negotiation.
  return {
    url: url.toString(),
    options: {
      max: 1,
      prepare: !(sharedPooler && url.port === "6543"),
      idle_timeout: 20,
      connect_timeout: 10,
    },
  };
}
