// URL query params can't carry a real null, so "null" (or absent) is the
// convention for "root" across the folders/files list endpoints.
export function parseNullableIdParam(value: string | null): string | null {
  return !value || value === "null" ? null : value;
}
