// The API applies connection, expiry and allocation gates. Count distinct exit
// IPs, while also honoring local switch updates before the next server refresh.
export function allocatableIpCount(proxies, now = Date.now()) {
  const ips = new Set();
  for (const proxy of proxies) {
    if (proxy.availableForBinding !== true || proxy.status !== 'active' || proxy.allocationPaused
      || proxy.iproyal?.autoAllocationPaused || proxy.iproyal?.usageCooldownPaused) continue;
    const expiresAt = Date.parse(proxy.iproyal?.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now) continue;
    const ip = String(proxy.ipAddress || '').trim().toLowerCase();
    if (ip) ips.add(ip);
  }
  return ips.size;
}
