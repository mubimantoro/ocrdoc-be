const clients = new Map();


export const addClient = (sourceFileId, res) => {
  if (!clients.has(sourceFileId)) {
    clients.set(sourceFileId, new Set());
  }
  clients.get(sourceFileId).add(res);
};


export const removeClient = (sourceFileId, res) => {
  const group = clients.get(sourceFileId);
  if (!group) return;
  group.delete(res);
  if (group.size === 0) clients.delete(sourceFileId);
};

/**
 * Push event ke semua client yang subscribe ke sourceFileId
 * Dipanggil dari worker saat status berubah
 */
export const pushEvent = (sourceFileId, event, data) => {
  const group = clients.get(sourceFileId);
  if (!group || group.size === 0) return;

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of group) {
    res.write(payload);
  }
};

export default { addClient, removeClient, pushEvent };