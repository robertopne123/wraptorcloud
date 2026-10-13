"use client";

export default function VaultError({ retry }: { retry: () => void }) {
  return (
    <section role="alert" className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-lg font-semibold">Could not load the vault</h1>
      <p className="text-sm text-zinc-500">The connection was interrupted. Please try again.</p>
      <button type="button" onClick={retry} className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500">
        Try again
      </button>
    </section>
  );
}
