/** Users' profile photos for the screen pictures, as data URIs.
 *
 * getUserProfilePhotos → getFile → download of the smallest size that is
 * still sharp at 120 px. Kept only in memory, for a few hours; a user with
 * no photo, or one hidden by privacy settings, gets null and the picture
 * goes out without it. */

const TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const LIMIT = 5000;
const WANT_PX = 160;

export function createAvatars({ api, log = null, now = () => Date.now() }) {
  const cache = new Map();
  const pending = new Map();

  async function fetchAvatar(userId) {
    const { photos = [] } = await api("getUserProfilePhotos", { user_id: userId, limit: 1 });
    const sizes = [...(photos[0] || [])].sort((a, b) => a.width - b.width);
    const size = sizes.find((item) => item.width >= WANT_PX) || sizes.at(-1);
    if (!size || typeof api.download !== "function") return null;
    const file = await api("getFile", { file_id: size.file_id });
    const bytes = await api.download(file.file_path);
    const type = /\.png$/i.test(file.file_path) ? "image/png" : "image/jpeg";
    return `data:${type};base64,${bytes.toString("base64")}`;
  }

  function remember(userId, uri) {
    if (cache.size >= LIMIT) cache.delete(cache.keys().next().value);
    cache.set(userId, { uri, until: now() + (uri ? TTL_MS : MISS_TTL_MS) });
  }

  return {
    /** Data URI of the user's photo, or null. Never throws. */
    async get(userId) {
      if (!Number.isSafeInteger(userId) || userId <= 0) return null;
      const hit = cache.get(userId);
      if (hit && hit.until > now()) return hit.uri;
      if (!pending.has(userId)) {
        pending.set(
          userId,
          fetchAvatar(userId)
            .catch((err) => {
              log?.error(`Avatar for ${userId} not loaded: ${err instanceof Error ? err.message : err}`);
              return null;
            })
            .then((uri) => {
              remember(userId, uri);
              pending.delete(userId);
              return uri;
            }),
        );
      }
      return pending.get(userId);
    },
  };
}
