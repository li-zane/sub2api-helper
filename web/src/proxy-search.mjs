export function proxyMatches(value, query) {
  const text = String(query || '').trim().toLocaleLowerCase();
  if (!text) return true;
  const nodes = value.nodes || [value];
  const terms = [value.ipAddress, value.detectedIpAddress, value.city, value.region, value.country,
    ...nodes.flatMap(node => [node.id, node.name, node.host, node.port, node.city, node.region, node.country,
      ...(node.quality?.exits || []).flatMap(exit => [exit.ip, exit.city, exit.region, exit.country])]),
    ...(value.quality?.exits || []).flatMap(exit => [exit.ip, exit.city, exit.region, exit.country])];
  const haystack = terms.filter(value => value != null).join(' ').toLocaleLowerCase();
  return text.split(/\s+/).every(term => haystack.includes(term));
}
