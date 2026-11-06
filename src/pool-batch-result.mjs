// Create and update have different direct-proxy semantics in Sub2API:
// PUT uses 0 to clear a binding, but POST treats 0 as an actual foreign key.
export function poolCreateAccount(account) {
  const result = structuredClone(account);
  if (result.proxy_id === 0 || result.proxy_id === null) delete result.proxy_id;
  return result;
}

export function poolBatchResult(response, account) {
  const data = response?.data ?? response;
  const rows = data?.results;
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  const matches = row && typeof account?.name === "string" && row.name === account.name;
  const positiveId = value => (typeof value === "number" || typeof value === "string" && /^[1-9]\d*$/.test(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  const ids = matches && row.success === true && positiveId(row.id) ? [String(row.id)] : [];
  // A failed item is NOT generally proof that no row was inserted: Sub2API
  // binds groups after Create(), and a group failure may leave the row behind.
  const rejected = Boolean(matches && row.success === false && !row.id &&
    data.success === 0 && data.failed === 1 &&
    (!Array.isArray(data.accounts) || !data.accounts.length) &&
    typeof row.error === "string" && row.error.trim());
  const noCommit = rejected && /insert or update on table "accounts" violates foreign key constraint "accounts_proxy_id_fkey"/.test(row.error);
  return { ids, rejected, noCommit, error: rejected ? row.error : null };
}
