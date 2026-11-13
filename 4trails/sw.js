/* eslint-disable no-restricted-globals */
/**
 * 麦理浩径徒步地图 — Service Worker（阶段 2）
 *
 * 策略：
 *   - 应用外壳（导航请求）：网路优先，离线时退回快取的外壳 → 离线也能打开页面。
 *   - 资料（/data/*）：stale-while-revalidate → 先给快取的路线／设施／标距柱，背景更新。
 *     预快取清单**由 dataset-manifest.json 推导**，所以换资料不需要改这个档案。
 *   - 建构产物（/_next/static/*）：cache-first（档名有内容杂凑，可长期快取）。
 *   - 底图样式（第三方 style.json）：stale-while-revalidate。它很小，但没有它 MapLibre 无法初始化。
 *   - **底图瓦片一律走网路，不快取**：能不能离线快取别人的瓦片取决于该服务的条款，
 *     本专案不预设可以。离线时地图会是空白底色 + 我们的路线与设施图层。
 *
 * 版本升级：改 VERSION 会让旧的 trail-* 快取在 activate 时被清掉。
 */
const VERSION = 'v137';
/**
 * 部署前綴：從註冊 scope 推導，所以同一份 sw.js 在根路徑（/）與
 * 子路徑（/4trails/）都能用，不需要在建置時替換路徑。
 */
const BASE = new URL(self.registration.scope).pathname.replace(/\/+$/, '');
const DATA_BASE = `${BASE}/data`;
const SHELL_URL = `${BASE}/`;
const withBase = (path) => (path.startsWith(`${BASE}/`) ? path : `${BASE}${path.startsWith('/') ? path : `/${path}`}`);
const CACHE_PREFIX = 'trail';
const SHELL_CACHE = `${CACHE_PREFIX}-shell-${VERSION}`;
const DATA_CACHE = `${CACHE_PREFIX}-data-${VERSION}`;
const ASSET_CACHE = `${CACHE_PREFIX}-assets-${VERSION}`;
/**
 * 离线底图（使用者按「下载离线地图包」存进来的图砖与字形）。
 * ⚠️ 刻意**不带 VERSION**：应用程式更新不应该把辛苦下载的地图包清掉。
 */
const BASEMAP_CACHE = `${CACHE_PREFIX}-basemap-v1`;

/**
 * 预快取应用外壳与所有资料档。
 *
 * 清单来自 `/data/offline-index.json`（由 `scripts/build-offline-index.mjs` 读专案径登记表产生）。
 * ⚠️ 2026-10-21 之前是固定只读麦径的 `dataset-manifest.json` ——
 *    结果**离线时只有麦径有资料**，港岛径／卫径／凤凰径在山上打开会是空的。
 * 现在依索引逐径预快取；新增山径只要重新产生索引，这支 sw 不用改。
 */
async function precacheShell() {
  const shell = await caches.open(SHELL_CACHE);

  /** 抓一个页面／档案并放进指定 cache；失败就跳过（单项失败不影响其它） */
  const put = async (cache, url) => {
    try {
      const response = await fetch(url, { cache: 'no-cache' });
      if (response.ok) await cache.put(url, response);
    } catch {
      /* 单项失败不影响其他资源 */
    }
  };

  let index = null;
  try {
    const response = await fetch(`${DATA_BASE}/offline-index.json`, { cache: 'no-cache' });
    if (response.ok) index = await response.json();
  } catch {
    /* 索引拿不到 → 退回旧行为（只快取首页与麦径清单） */
  }

  const staticPages = (index?.static ?? ['/', '/icon.svg', '/maplibre-gl-worker.mjs']).map(withBase);
  const shells = (index?.shells ?? []).map(withBase);
  const plans = (index?.plans ?? []).map(withBase);
  const manifests = index?.manifests ?? ['dataset-manifest.json'];

  await Promise.all([...staticPages, ...shells, ...plans].map((url) => put(shell, url)));
  // 資料預快取移到 activate 背景做：install 先讓外殼可用，避免山上第一次開站時
  // 因為 4 條徑全部資料下載太慢而「Service Worker 還沒裝好 → 離線完全打不開」。
  self.__mhPendingPrecache = async () => {
  const data = await caches.open(DATA_CACHE);
  for (const manifestName of manifests) {
    const manifestUrl = `${DATA_BASE}/${manifestName}`;
    try {
      const response = await fetch(manifestUrl, { cache: 'no-cache' });
      if (!response.ok) continue;
      await data.put(manifestUrl, response.clone());
      const manifest = await response.json();
      const files = Object.values(manifest.files || {}).filter((file) => /\.(geojson|json)$/.test(file));
      await Promise.all(files.map((file) => put(data, `${DATA_BASE}/${file}`)));
    } catch {
      /* 这条径的清单失败不影响其它径 */
    }
  }

  // 离线索引本身也快取，之后离线仍能判断有哪些径
  await put(data, `${DATA_BASE}/offline-index.json`);
  };
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  const pendingPrecache = self.__mhPendingPrecache;
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const keep = new Set([SHELL_CACHE, DATA_CACHE, ASSET_CACHE, BASEMAP_CACHE]);
      await Promise.all(
        names
          .filter((name) => name.startsWith(`${CACHE_PREFIX}-`) && !keep.has(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
  // 背景補齊資料檔（activate 完成後仍會繼續；下次上線也會再補）
  if (typeof pendingPrecache === 'function') event.waitUntil(pendingPrecache());
});

/** 先回快取、背景更新 */

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fresh = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === 'opaque')) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    void fresh; // 背景更新，不阻塞回覆
    return cached;
  }
  const response = await fresh;
  return response || Response.error();
}

/**
 * ⚠️ service worker **刻意完全不碰底图网域**（tiles.openfreemap.org）。
 *
 * 教训：曾经用 SW 拦截样式与图砖来做离线，结果使用者那边出现「黑色只有轨迹」，
 * 而且按「重新载入底图」也救不回来 —— 因为拦截逻辑本身成了新的失败点。
 * 现在底图完全由 App 自己管：MapLibre 的 addProtocol（见 src/lib/basemapRuntime.ts）
 * 直接读写 Cache Storage，线上走网路、离线走快取，行为与「直接在浏览器开那个网址」一致。
 * SW 只负责我们自己的来源（外壳、资料档、静态资源）。
 */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // 第三方资源：底图一律**不拦截**（交给 App 的 addProtocol），
  // 其他第三方也不碰，尊重各自的服务条款。
  if (!sameOrigin) return;

  // 导航：网路优先；离线时先找「同一个网址」的快取（例如 /plan/full），最后才退回主外壳。
  // 这样大计划在山上没信号时也能打开，而不是被换成地图首页。
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const exact = await caches.match(request, { ignoreSearch: true });
          if (exact) return exact;
          const shell = await caches.match(SHELL_URL);
          return shell || Response.error();
        }
      })(),
    );
    return;
  }

  if (url.pathname.startsWith(`${DATA_BASE}/`)) {
    event.respondWith(staleWhileRevalidate(request, DATA_CACHE));
    return;
  }
  if (url.pathname.startsWith(`${BASE}/_next/static/`)) {
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
    return;
  }
  if (sameOrigin) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
  }
});
