/* trading-dashboard 공통 API base 라우터.
 * 4 페이지 (index/persona_unified/persona_analytics/persona_settings) 가 inline 으로 갖던 로직을 한 파일로.
 *
 * 환경 자동 감지:
 *   file://                → http://127.0.0.1:9000
 *   127.0.0.1 / localhost  → '' (same-origin)
 *   192.x (LAN)            → '' (same-origin) + /trading prefix if served via /trading/
 *   *.600g.net (CF Tunnel) → '' + /trading
 *   외부 (github.io 등)    → https://api.600g.net + /trading
 *
 * 노출 전역:
 *   TradingAPI.base, TradingAPI.prefix
 *   TradingAPI.url(path)            → 절대 URL 빌더 (cache-bust _t 자동)
 *   TradingAPI.fetch(path, opts?)   → fetch wrapper (no-store, 5s timeout 기본)
 *   TradingAPI.botApi(bot, path)    → bot api proxy (coin/stock)
 *   TradingAPI.SYS_API              → 호환 (기존 SYS_API 변수)
 *   TradingAPI.BOT_APIS             → 호환 ({coin, stock})
 */
(function () {
  'use strict';
  const _h = location.hostname;
  const _isFile = location.protocol === 'file:';
  const _isLocal = _h === '127.0.0.1' || _h === 'localhost' || _h.startsWith('192.');
  const _isCF = _h.endsWith('.600g.net');

  let base = '', prefix = '';
  if (_isFile) {
    base = 'http://127.0.0.1:9000';
  } else if (_isLocal) {
    base = '';
    prefix = location.pathname.startsWith('/trading/') ? '/trading' : '';
  } else if (_h === 'trading.600g.net') {
    // 별도 도메인 — root 직접, prefix 없음
    base = ''; prefix = '';
  } else if (_isCF) {
    // api.600g.net 등 두근컴퍼니 도메인 — /trading prefix
    base = ''; prefix = '/trading';
  } else {
    base = 'https://api.600g.net'; prefix = '/trading';
  }

  function url(path) {
    if (!path) return base + prefix;
    if (path.startsWith('http')) return path;
    if (!path.startsWith('/')) path = '/' + path;
    return base + prefix + path;
  }

  function fetch_(path, opts = {}) {
    const u = url(path);
    const final = u + (u.includes('?') ? '&' : '?') + '_t=' + Date.now();
    const o = Object.assign(
      { cache: 'no-store', signal: AbortSignal.timeout(opts.timeout || 5000) },
      opts,
    );
    delete o.timeout;
    return fetch(final, o);
  }

  // bot api: file/127 직접 :9001/:9002, 그 외 proxy
  function botApi(bot, path = '') {
    if (_isFile || (_isLocal && !prefix)) {
      const port = bot === 'coin' ? 9001 : 9002;
      return 'http://127.0.0.1:' + port + (path ? '/' + path.replace(/^\//, '') : '');
    }
    return url('/api/' + bot + (path ? '/' + path.replace(/^\//, '') : ''));
  }

  window.TradingAPI = { base, prefix, url, fetch: fetch_, botApi };
  // 호환성 (기존 변수명 유지)
  window.SYS_API = base + prefix;
  window.BOT_APIS = (_isFile || (_isLocal && !prefix))
    ? { coin: 'http://127.0.0.1:9001', stock: 'http://127.0.0.1:9002' }
    : { coin: base + prefix + '/api/coin', stock: base + prefix + '/api/stock' };
  window.API_BASE = base + prefix;       // persona_settings 호환
  window.API_BASE_PA = base + prefix;    // persona_analytics 호환
  window.PATH_PREFIX = prefix;           // persona_unified 호환
})();
