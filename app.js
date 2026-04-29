/* 두근 트레이딩 통합 대시보드 - 클라이언트 로직 v1.3
 *
 * 3가지 모드 자동 감지:
 *   1. file://             → 직접 API 호출 (같은 Mac, 개발)
 *   2. http://127.x        → system_api 프록시 (같은 Mac)
 *   3. http://192.x        → system_api 프록시 (같은 LAN)
 *   4. https://*.io 등     → Firebase Firestore 모드 (외부, 어디서든)
 *
 * 시스템: :9000  코인봇: :9001  주식봇: :9002
 * Firebase: datemap-759bf, 컬렉션 trading_status / trading_commands
 */

const APP_VERSION = 'v2.1';
const IS_FILE = location.protocol === 'file:';
const ORIGIN = IS_FILE ? '' : location.origin;

// 외부 호스트면 Firebase 모드 (LAN/localhost가 아닌 경우)
const IS_LOCAL = IS_FILE
  || /^(127\.|localhost|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01]))/.test(location.hostname);
const FIREBASE_MODE = !IS_LOCAL;

const APIS = IS_FILE
  ? {
      system: 'http://127.0.0.1:9000',
      coin:   'http://127.0.0.1:9001',
      stock:  'http://127.0.0.1:9002',
    }
  : {
      system: ORIGIN,
      coin:   `${ORIGIN}/api/coin`,
      stock:  `${ORIGIN}/api/stock`,
    };

/* ─── Firebase 초기화 (외부 모드) ──────────────────── */
let firestore = null;
let _fbConfig = null;

async function initFirebase() {
  if (typeof firebase === 'undefined') {
    console.warn('Firebase SDK 로드 실패');
    return false;
  }
  try {
    if (!_fbConfig) {
      const r = await fetch('firebase-config.json', { cache:'no-store' });
      _fbConfig = await r.json();
    }
    if (!firebase.apps.length) firebase.initializeApp(_fbConfig);
    firestore = firebase.firestore();
    console.log('[Firebase] 초기화 OK', _fbConfig.projectId);
    return true;
  } catch (e) {
    console.warn('[Firebase] 초기화 실패:', e);
    return false;
  }
}

if (FIREBASE_MODE) {
  initFirebase().then(ok => {
    if (ok) {
      subscribeFirestore();
      // 외부 모드는 폴링 안 함 (Firestore 실시간)
    } else {
      toast('⚠️ Firebase 연결 실패. 봇 호스트와 같은 네트워크에 있어야 컨트롤 가능');
    }
  });
}

/* ─── Firestore 실시간 구독 (외부 모드 전용) ──────── */
function subscribeFirestore() {
  ['coin', 'stock'].forEach(bot => {
    firestore.collection('trading_status').doc(bot).onSnapshot(snap => {
      if (!snap.exists) {
        console.log(`[FS] ${bot} 데이터 없음 (Bridge 안 켜짐?)`);
        return;
      }
      const data = snap.data();
      // health/status 형태로 분리해서 기존 렌더 함수 재사용
      const health = data.online ? {bot_mode: data.bot_mode, trade_mode: data.trade_mode} : null;
      const status = data.online ? {
        balance: data.balance, today_pnl: data.today_pnl, today_pct: data.today_pct,
        total_pnl: data.total_pnl, total_pct: data.total_pct, initial_balance: data.balance - data.total_pnl,
        positions: data.positions || [], recent_trades: data.recent_trades || [],
        tune_log: data.tune_log || [], daily_pnl_7d: data.daily_pnl_7d || [],
      } : null;
      applyHealthUI(bot, health);
      applyStatusUI(bot, status);
      renderHomeOverview();

      const upd = data.updated_at;
      if (upd) {
        document.getElementById('upd-time').textContent =
          '🌐 ' + new Date(upd).toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
      }

      // Firebase 모드 캐시 저장 (다음 페이지 로드 시 0초 표시)
      const c = STATE.coin.status, s = STATE.stock.status;
      if (c || s) {
        saveCache({
          coinH: STATE.coin.bot_mode ? {bot_mode: STATE.coin.bot_mode, trade_mode: STATE.coin.trade_mode} : null,
          stockH: STATE.stock.bot_mode ? {bot_mode: STATE.stock.bot_mode, trade_mode: STATE.stock.trade_mode} : null,
          coinS: c, stockS: s,
        });
      }
    }, err => console.warn(`[FS] ${bot} 구독 오류:`, err));
  });

  // 시장 / 인사이트 / 토큰 사용량
  firestore.collection('trading_status').doc('market').onSnapshot(snap => {
    if (snap.exists) renderMarket(snap.data());
  });
  firestore.collection('trading_status').doc('insights').onSnapshot(snap => {
    if (snap.exists) renderInsights(snap.data());
  });
  firestore.collection('trading_status').doc('tokens').onSnapshot(snap => {
    if (snap.exists) renderTokens(snap.data());
  });

  // 시스템 + 헬스체크 (외부 모드)
  firestore.collection('trading_status').doc('system_status').onSnapshot(snap => {
    if (snap.exists) {
      STATE.system = snap.data();
      if (document.getElementById('view-system')?.classList.contains('active')) {
        renderSystemFromCache(snap.data());
      }
    }
  });
  firestore.collection('trading_status').doc('healthcheck').onSnapshot(snap => {
    if (snap.exists) renderHealthcheckData(snap.data());
  });

  // 명령 처리 결과 모니터
  firestore.collection('trading_commands')
    .orderBy('created_at', 'desc').limit(5)
    .onSnapshot(snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'modified') {
          const d = ch.doc.data();
          if (d.status === 'processed') toast(`✅ ${d.bot} ${d.action}`);
          else if (d.status === 'failed') toast(`❌ ${d.bot} ${d.action} 실패`);
        }
      });
    });
}

/* Firebase 모드: 명령 발행 */
async function fbCommand(bot, action) {
  if (!firestore) {
    toast('❌ Firebase 미연결');
    return false;
  }
  try {
    await firestore.collection('trading_commands').add({
      bot, action,
      status: 'pending',
      created_at: new Date().toISOString(),
      origin: 'web',
    });
    toast(`📤 ${bot} ${action} 발행 (대기 중)`);
    return true;
  } catch (e) {
    toast(`❌ Firebase 발행 실패: ${e.message}`);
    return false;
  }
}

const STATE = {
  coin:  {bot_mode:null, trade_mode:null, online:false, status:null},
  stock: {bot_mode:null, trade_mode:null, online:false, status:null},
  system:{processes:[], autoload:false},
  cal:   {bot:'coin', year:null, month:null, selectedDay:null},
};

let chart7d = null;

/* ─── 비밀번호 (SHA-256) ─────────────────────────────────── */
const PW_KEY = 'doogeun_trading_pw_hash';
const AUTH_KEY = 'doogeun_trading_auth_until';
const AUTH_DURATION_MS = 5 * 60 * 1000;

async function sha256(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,'0')).join('');
}
const getStoredHash = () => localStorage.getItem(PW_KEY);
const setStoredHash = h => localStorage.setItem(PW_KEY, h);
const isAuthed = () => Date.now() < parseInt(localStorage.getItem(AUTH_KEY) || '0');
const markAuthed = () => localStorage.setItem(AUTH_KEY, String(Date.now() + AUTH_DURATION_MS));

let pwResolver = null, pwOnSuccess = null;

function openPw(opts = {}) {
  return new Promise(resolve => {
    pwResolver = resolve;
    const stored = getStoredHash();
    document.getElementById('pwTitle').textContent =
      opts.title || (stored ? '관리자 인증' : '비밀번호 첫 설정');
    document.getElementById('pwDesc').textContent = stored
      ? (opts.desc || '위험한 작업입니다. 비밀번호 입력.')
      : '비밀번호를 처음 설정합니다. 4자 이상.';
    document.getElementById('pwErr').textContent = '';
    const input = document.getElementById('pwInput');
    input.value = '';
    document.getElementById('pwModal').classList.add('show');
    setTimeout(() => input.focus(), 100);
  });
}

function closePw() {
  document.getElementById('pwModal').classList.remove('show');
  if (pwResolver) { pwResolver(false); pwResolver = null; }
}

async function submitPw() {
  const pw = document.getElementById('pwInput').value;
  const err = document.getElementById('pwErr');
  if (pw.length < 4) { err.textContent = '4자 이상 입력'; return; }

  const stored = getStoredHash();
  const hash = await sha256(pw);

  if (!stored) {
    setStoredHash(hash);
    markAuthed();
    document.getElementById('pwModal').classList.remove('show');
    toast('🔒 비밀번호 설정 완료');
    if (pwResolver) { pwResolver(true); pwResolver = null; }
    return;
  }
  if (hash === stored) {
    markAuthed();
    document.getElementById('pwModal').classList.remove('show');
    if (pwResolver) { pwResolver(true); pwResolver = null; }
  } else {
    err.textContent = '비밀번호 틀림';
    document.getElementById('pwInput').value = '';
  }
}

document.addEventListener('keydown', e => {
  if (!document.getElementById('pwModal').classList.contains('show')) return;
  if (e.key === 'Enter') submitPw();
  if (e.key === 'Escape') closePw();
});

async function ensureAuth(opts) {
  if (isAuthed()) return true;
  return await openPw(opts);
}

function changePw() {
  localStorage.removeItem(PW_KEY);
  localStorage.removeItem(AUTH_KEY);
  toast('🔓 새 비밀번호 설정 모달이 다음 위험 작업 시 뜸');
}
function resetPw() {
  if (!confirm('비밀번호 초기화? 다음 위험 작업 시 새로 설정.')) return;
  localStorage.removeItem(PW_KEY);
  localStorage.removeItem(AUTH_KEY);
  toast('초기화됨');
}
function logoutAuth() {
  localStorage.removeItem(AUTH_KEY);
  toast('인증 만료. 다음 위험 작업 시 비밀번호 요구.');
}

/* ─── 표시 헬퍼 ──────────────────────────────────────── */
const fmt = n => Math.round(n).toLocaleString('ko-KR');
const fmtSign = n => (n >= 0 ? '+' : '') + fmt(n);
const pct = n => (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';

function colorize(el, val) {
  el.classList.remove('up', 'down');
  if (val > 0) el.classList.add('up');
  else if (val < 0) el.classList.add('down');
}

function modeBadge(trade_mode, bot_mode) {
  let html = '';
  if (trade_mode === 'real') {
    html += `<span class="badge b-real"><span class="led err"></span>REAL</span>`;
  } else if (trade_mode === 'demo') {
    html += `<span class="badge b-demo"><span class="led on"></span>DEMO</span>`;
  }
  if (bot_mode === 'running') html += `<span class="badge b-running"><span class="led on"></span>RUNNING</span>`;
  else if (bot_mode === 'soft_stop') html += `<span class="badge b-soft"><span class="led warn"></span>SOFT-STOP</span>`;
  else if (bot_mode === 'stopped') html += `<span class="badge b-stopped"><span class="led err"></span>STOPPED</span>`;
  else if (!bot_mode) html += `<span class="badge b-offline"><span class="led off"></span>OFFLINE</span>`;
  return html;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

/* ─── 네비게이션 ────────────────────────────────────── */
function openMenu() {
  document.getElementById('menu').classList.add('show');
  document.getElementById('menuBg').classList.add('show');
}
function closeMenu() {
  document.getElementById('menu').classList.remove('show');
  document.getElementById('menuBg').classList.remove('show');
}

const VIEW_TITLES = {
  home: '📊 두근 트레이딩',
  coin: '🪙 코인봇',
  stock:'📈 주식봇',
  system:'⚙️ 시스템',
  tune: '📅 자가개선',
  alerts:'🔔 알림',
  settings:'🔐 설정',
};

/* ─── 푸시 알림 시스템 ───────────────────────────── */
const SEEN_KEY = 'doogeun_seen_alert_ids';
let _alertFilter = 'all';

function getSeenIds() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); }
  catch { return new Set(); }
}

function saveSeenIds(set) {
  localStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-500)));  // 최근 500개만
}

async function enableNotifications() {
  if (!('Notification' in window)) { toast('❌ 브라우저가 푸시 알림 미지원'); return; }
  const perm = await Notification.requestPermission();
  document.getElementById('alert_perm_status').textContent =
    perm === 'granted' ? '✅ 활성화됨' : perm === 'denied' ? '❌ 거부됨' : '대기';
  if (perm === 'granted') toast('🔔 푸시 알림 활성화');
}

function testNotification() {
  if (Notification.permission !== 'granted') {
    toast('먼저 알림 권한 활성화'); enableNotifications(); return;
  }
  new Notification('🔔 두근 트레이딩 테스트', {
    body: '알림이 정상적으로 작동합니다.',
    icon: '/favicon.ico',
  });
}

function pushOSNotification(alert) {
  if (Notification.permission !== 'granted') return;
  const icon = alert.severity === 'danger' ? '⚠️'
             : alert.severity === 'warn' ? '💡' : '✅';
  const botEmoji = alert.bot === 'coin' ? '🪙' : '📈';
  new Notification(`${icon} ${botEmoji} ${alert.title}`, {
    body: alert.body || '',
    tag: `alert-${alert.id}`,
    requireInteraction: alert.severity === 'danger',
  });
}

function checkNewAlerts(alerts) {
  if (!alerts || !alerts.length) return;
  const seen = getSeenIds();
  let newCount = 0;
  for (const a of alerts) {
    const aid = `${a.bot}-${a.id}`;
    if (!seen.has(aid)) {
      pushOSNotification(a);
      seen.add(aid);
      newCount++;
    }
  }
  if (newCount > 0) {
    saveSeenIds(seen);
    if (newCount > 1) toast(`🔔 ${newCount}건 신규 알림`);
  }
}

function markAllRead() {
  const seen = getSeenIds();
  const all = collectAllAlerts();
  for (const a of all) seen.add(`${a.bot}-${a.id}`);
  saveSeenIds(seen);
  document.getElementById('menu_alert_count').style.display = 'none';
  toast('✅ 모두 읽음');
  renderAlerts(all);
}

function clearAllAlerts() {
  if (!confirm('알림 리스트 전체 삭제? (DB는 유지, localStorage만)')) return;
  saveSeenIds(new Set());
  toast('전체 삭제');
}

// ─── 페르소나 / 카테고리 메타 ─────────────────────────────────────
// trait = 한글 특성 (이모지로는 안 보이는 핵심 행동 요약)
const PERSONA_META = {
  // 코인봇
  '박단타':       {icon:'⚡', cls:'p-dayta',    group:'dayta',    trait:'초단타·빠른회전'},
  '최모멘텀':     {icon:'🚀', cls:'p-momentum', group:'momentum', trait:'급등추격·돌파매수'},
  '이패턴':       {icon:'📊', cls:'p-pattern',  group:'pattern',  trait:'차트패턴·기술적'},
  '김리스크':     {icon:'🛡', cls:'p-risk',     group:'risk',     trait:'보수적·저변동'},
  // 주식봇 KR
  '단타':         {icon:'⚡', cls:'p-dayta',    group:'dayta',    trait:'당일청산·빠른익절'},
  '중타':         {icon:'🎯', cls:'p-midta',    group:'midta',    trait:'1~3일·스윙'},
  '장기':         {icon:'🌳', cls:'p-long',     group:'long',     trait:'주단위·트렌드라이딩'},
  // 주식봇 US
  '나스닥단타':   {icon:'⚡', cls:'p-dayta',    group:'dayta',    trait:'나스닥·당일'},
  'S&P안정형':    {icon:'🛡', cls:'p-snp',      group:'risk',     trait:'대형주·저변동'},
  '기술주모멘텀': {icon:'🚀', cls:'p-tech',     group:'momentum', trait:'테크주·돌파'},
};

function personaBadge(name, opts = {}) {
  if (!name || name === '-') return '';
  const meta = PERSONA_META[name] || {icon:'•', cls:'p-default', group:'', trait:''};
  const showTrait = opts.trait !== false && meta.trait;
  const traitHtml = showTrait
    ? ` <span class="p-trait">· ${meta.trait}</span>`
    : '';
  return `<span class="p-badge ${meta.cls}" title="${meta.trait || name}">${meta.icon} ${name}${traitHtml}</span>`;
}

function personaGroup(name) {
  return PERSONA_META[name]?.group || '';
}

// 마켓 분류: bot 이름 + market 필드 → 'coin' / 'kr' / 'us'
function marketKind(bot, market) {
  if (bot === 'coin') return 'coin';
  return (market || 'KR').toLowerCase() === 'us' ? 'us' : 'kr';
}

function marketBadge(kind) {
  if (kind === 'coin') return '<span class="badge b-coin">🪙 COIN</span>';
  if (kind === 'us')   return '<span class="badge b-us">📈 US</span>';
  return '<span class="badge b-kr">📈 KR</span>';
}

// 거래 reason/extra에서 페르소나 추출 (주식봇 trades.extra_json 에 reason 포함)
function tradePersona(t) {
  if (t.persona) return t.persona;
  let extra = t.extra;
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra); } catch { extra = null; }
  }
  if (!extra) return '';
  if (extra.persona) return extra.persona;
  const r = extra.reason || '';
  // "박단타_1차" / "중타_1차" → 페르소나명만
  const m = r.match(/^([가-힣A-Za-z&]+)/);
  return m ? m[1] : '';
}

// ─── 필터 상태 (localStorage 영속) ──────────────────────────────
let _tradeFilter = localStorage.getItem('tradeFilter') || 'all';
let _coinPosFilter = localStorage.getItem('coinPosFilter') || 'all';
let _stockPosFilter = localStorage.getItem('stockPosFilter') || 'all';

function setTradeFilter(f) {
  _tradeFilter = f;
  localStorage.setItem('tradeFilter', f);
  document.querySelectorAll('#trade_filter_bar .filter-chip').forEach(el => {
    const active = el.dataset.tf === f;
    el.classList.toggle('active', active);
    el.classList.toggle('coin', active && f === 'coin');
    el.classList.toggle('kr', active && f === 'kr');
    el.classList.toggle('us', active && f === 'us');
  });
  renderHomeOverview();
}

function setPosFilter(bot, f) {
  if (bot === 'coin') { _coinPosFilter = f; localStorage.setItem('coinPosFilter', f); }
  else { _stockPosFilter = f; localStorage.setItem('stockPosFilter', f); }
  document.querySelectorAll(`#${bot}_pos_filter_bar .filter-chip`).forEach(el => {
    const active = el.dataset.pf === f;
    el.classList.toggle('active', active);
    el.classList.toggle('kr', active && f === 'kr');
    el.classList.toggle('us', active && f === 'us');
  });
  renderBotPanel(bot);
}

// 초기 active 상태 동기화 (DOM 준비 후 호출)
function _syncFilterChips() {
  ['trade'].forEach(() => setTradeFilter(_tradeFilter));
  setPosFilter('coin', _coinPosFilter);
  setPosFilter('stock', _stockPosFilter);
}

function collectAllAlerts() {
  const c = STATE.coin.status?.alerts || [];
  const s = STATE.stock.status?.alerts || [];
  const all = [
    ...c.map(a => ({...a, bot: a.bot || 'coin'})),
    ...s.map(a => ({...a, bot: a.bot || 'stock'})),
  ];
  return all.sort((a,b) => (b.ts || '').localeCompare(a.ts || ''));
}

function filterAlerts(type) {
  _alertFilter = type;
  renderAlerts(collectAllAlerts());
}

function renderAlerts(all) {
  const list = document.getElementById('alerts_list');
  if (!list) return;

  let filtered = all;
  if (_alertFilter === 'buy') filtered = all.filter(a => a.type === 'buy');
  else if (_alertFilter === 'sell') filtered = all.filter(a => a.type === 'sell');
  else if (_alertFilter === 'danger') filtered = all.filter(a => a.severity === 'danger' || a.severity === 'warn');
  else if (_alertFilter === 'coin') filtered = all.filter(a => a.bot === 'coin');
  else if (_alertFilter === 'stock') filtered = all.filter(a => a.bot === 'stock');

  document.getElementById('alert_count_badge').textContent = `총 ${all.length}건 (필터 ${filtered.length})`;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty">알림 없음</div>';
    return;
  }

  const seen = getSeenIds();
  list.innerHTML = filtered.map(a => {
    const aid = `${a.bot}-${a.id}`;
    const isNew = !seen.has(aid);
    const sevColor = a.severity === 'danger' ? 'var(--danger)'
                  : a.severity === 'warn' ? 'var(--warn)' : 'var(--ok)';
    const botEmoji = a.bot === 'coin' ? '🪙' : '📈';
    const ts = (a.ts || '').slice(11, 19);
    return `<div style="padding:10px; border-left:3px solid ${sevColor}; background:${isNew?'#1f6feb11':'transparent'}; margin-bottom:6px; border-radius:6px">
      <div style="display:flex; justify-content:space-between; align-items:center">
        <div style="font-weight:600; font-size:13px">${botEmoji} ${a.title}${isNew?' <span style="color:var(--info)">●</span>':''}</div>
        <div style="font-size:10px; color:var(--muted)">${ts}</div>
      </div>
      <div style="font-size:11px; color:var(--muted); margin-top:3px">${a.body || ''}</div>
    </div>`;
  }).join('');

  // 메뉴 카운트 갱신
  const newCount = filtered.filter(a => !seen.has(`${a.bot}-${a.id}`)).length;
  const badge = document.getElementById('menu_alert_count');
  if (badge) {
    if (newCount > 0) {
      badge.textContent = newCount;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
}

function goView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('active'));
  document.querySelector(`.menu-item[data-view="${view}"]`)?.classList.add('active');
  document.getElementById('topbar-title').textContent = VIEW_TITLES[view] || view;
  closeMenu();
  if (view === 'system') loadSystemView();
  if (view === 'tune') initCalendar();
  if (view === 'alerts') {
    const perm = ('Notification' in window) ? Notification.permission : 'X';
    document.getElementById('alert_perm_status').textContent =
      perm === 'granted' ? '✅ 활성화됨' : perm === 'denied' ? '❌ 거부됨' : '⏸ 대기';
    renderAlerts(collectAllAlerts());
  }
  window.scrollTo({top: 0, behavior: 'smooth'});
}

/* ─── 봇 컨트롤 ──────────────────────────────────────── */
async function ctrl(bot, path, opts = {}) {
  if (opts.confirm && !confirm(opts.confirm)) return;

  const needAuth = opts.auth || path === 'trade/real' || path === 'mode/stop' || path === 'emergency';
  if (needAuth) {
    const ok = await ensureAuth({desc: opts.confirm || '위험한 작업입니다.'});
    if (!ok) return;
  }

  const msgEl = document.getElementById(`${bot}_msg`);
  if (msgEl) { msgEl.className = 'ctl-msg'; msgEl.textContent = '⏳ 처리 중...'; }

  // Firebase 모드: Firestore에 명령 발행
  if (FIREBASE_MODE) {
    const ok = await fbCommand(bot, path);
    if (msgEl) {
      msgEl.className = ok ? 'ctl-msg ok' : 'ctl-msg err';
      msgEl.textContent = ok ? `📤 ${path} 발행 (Bridge 처리 중)` : '❌ 발행 실패';
    }
    return;
  }

  // 로컬 모드: 직접 API 호출
  try {
    const r = await fetch(`${APIS[bot]}/${path}`, { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (msgEl) { msgEl.className = 'ctl-msg ok'; msgEl.textContent = `✅ ${data.msg || JSON.stringify(data).slice(0,60)}`; }
    toast(`✅ ${path}`);
    setTimeout(loadAll, 600);
  } catch (e) {
    if (msgEl) { msgEl.className = 'ctl-msg err'; msgEl.textContent = `❌ 실패: ${e.message} — ${APIS[bot]}`; }
    toast(`❌ 실패`);
  }
}

async function toggleTrade(bot) {
  const cur = STATE[bot].trade_mode;
  const next = cur === 'real' ? 'demo' : 'real';
  if (next === 'real') {
    await ctrl(bot, 'trade/real', {confirm:'⚠️ REAL 전환. 다음 매수부터 실제 주문. 진행?'});
  } else {
    await ctrl(bot, 'trade/demo');
  }
}

/* ─── 시스템 뷰 ──────────────────────────────────────── */
async function sysCall(action, label, opts = {}) {
  if (opts.confirm && !confirm(opts.confirm)) return;
  if (opts.auth) {
    const ok = await ensureAuth({desc: opts.confirm || `${label}?`});
    if (!ok) return;
  }
  toast(`⏳ ${label}...`);
  try {
    const r = await fetch(`${APIS.system}/system/${action}`, { method:'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    toast(`✅ ${label} 완료`);
    setTimeout(loadAll, 1500);
  } catch (e) {
    toast(`❌ ${label} 실패: 시스템 API (:9000) 켜졌는지 확인`);
  }
}

async function restartOne(name) {
  const ok = await ensureAuth({desc: `${name} 재시작?`});
  if (!ok) return;
  toast(`⏳ ${name} 재시작...`);
  try {
    await fetch(`${APIS.system}/system/restart/${name}`, { method:'POST' });
    toast(`✅ ${name} 재시작`);
    setTimeout(loadSystemView, 1500);
  } catch (e) {
    toast(`❌ 실패`);
  }
}

/* 외부 모드(Firebase) — Firestore 캐시 데이터로 시스템 뷰 렌더 */
function renderSystemFromCache(data) {
  const list = document.getElementById('sys_processes');
  if (list && data.processes) {
    list.innerHTML = data.processes.map(p => {
      const led = p.alive ? '<span class="led on"></span>' : '<span class="led off"></span>';
      const meta = p.alive
        ? `PID ${p.pid} · ${p.etime || '-'} · ${p.rss_kb ? Math.round(p.rss_kb/1024) + 'MB' : ''}`
        : '종료됨';
      return `<div class="sys-row"><div class="sys-info">
        <div class="sys-name">${led} ${p.name}</div>
        <div class="sys-meta">${meta}</div>
      </div></div>`;
    }).join('');
  }
  const sw = document.getElementById('autoload_switch');
  const desc = document.getElementById('autoload_desc');
  if (sw && desc) {
    if (data.autoload) {
      sw.classList.add('on');
      desc.textContent = '✅ Mac 부팅 시 자동 시작';
    } else {
      sw.classList.remove('on');
      desc.textContent = '❌ 수동으로 시작 필요';
    }
  }
}

function renderHealthcheckData(h) {
  const grid = document.getElementById('health_grid');
  if (!grid || !h) return;
  const items = [
    {key:'kis', label:'KIS (주식)'},
    {key:'upbit', label:'Upbit (코인)'},
    {key:'ollama', label:'Ollama (로컬 LLM)'},
    {key:'gemini', label:'Gemini API'},
    {key:'firestore', label:'Firestore'},
    {key:'github_pages', label:'GitHub Pages'},
  ];
  grid.innerHTML = items.map(it => {
    const v = h[it.key];
    if (!v) return '';
    const led = v.ok ? '<span style="color:var(--ok)">●</span>' : '<span style="color:var(--danger)">●</span>';
    const cls = v.ok ? 'up' : 'down';
    return `<div style="display:flex;justify-content:space-between;padding:5px 8px;border-bottom:1px dotted var(--line);font-size:12px">
      <span>${led} ${it.label}</span>
      <span class="${cls}">${v.note || (v.ok ? 'OK' : 'FAIL')} <span style="color:var(--muted)">${v.ms||0}ms</span></span>
    </div>`;
  }).join('');
  const ovr = document.getElementById('health_overall');
  if (ovr) ovr.innerHTML = h.all_ok
    ? '<span class="up">✅ 전체 정상</span>'
    : '<span class="down">⚠️ 일부 막힘</span>';
}

async function loadHealthcheck() {
  try {
    const r = await fetch(`${APIS.system}/system/healthcheck`, { signal:AbortSignal.timeout(8000) });
    if (!r.ok) return;
    const h = await r.json();
    const grid = document.getElementById('health_grid');
    if (!grid) return;
    const items = [
      {key:'kis', label:'KIS (주식)'},
      {key:'upbit', label:'Upbit (코인)'},
      {key:'ollama', label:'Ollama (로컬 LLM)'},
      {key:'gemini', label:'Gemini API'},
      {key:'firestore', label:'Firestore (외부)'},
      {key:'github_pages', label:'GitHub Pages'},
    ];
    grid.innerHTML = items.map(it => {
      const v = h[it.key];
      if (!v) return '';
      const led = v.ok ? '<span style="color:var(--ok)">●</span>' : '<span style="color:var(--danger)">●</span>';
      const cls = v.ok ? 'up' : 'down';
      return `<div style="display:flex;justify-content:space-between;padding:5px 8px;border-bottom:1px dotted var(--line);font-size:12px">
        <span>${led} ${it.label}</span>
        <span class="${cls}">${v.note || (v.ok ? 'OK' : 'FAIL')} <span style="color:var(--muted)">${v.ms}ms</span></span>
      </div>`;
    }).join('');
    const ovr = document.getElementById('health_overall');
    if (ovr) ovr.innerHTML = h.all_ok
      ? '<span class="up">✅ 전체 정상</span>'
      : '<span class="down">⚠️ 일부 막힘</span>';
  } catch (e) {
    const grid = document.getElementById('health_grid');
    if (grid) grid.innerHTML = `<div class="empty">헬스체크 실패</div>`;
  }
}

async function loadSystemView() {
  // Firebase 모드: Firestore 캐시 사용 (system_api 직접 호출 불가)
  if (FIREBASE_MODE) {
    if (STATE.system?.processes) renderSystemFromCache(STATE.system);
    return;  // healthcheck도 Firestore에서 자동 구독 중
  }
  loadHealthcheck();
  try {
    const r = await fetch(`${APIS.system}/system/status`, { signal:AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error('offline');
    const data = await r.json();
    STATE.system = data;

    // 프로세스 리스트
    const list = document.getElementById('sys_processes');
    list.innerHTML = data.processes.map(p => {
      const led = p.alive ? '<span class="led on"></span>' : '<span class="led off"></span>';
      const meta = p.alive
        ? `PID ${p.pid} · ${p.etime || '-'} · ${p.rss_kb ? Math.round(p.rss_kb/1024) + 'MB' : ''}`
        : '종료됨';
      return `<div class="sys-row">
        <div class="sys-info">
          <div class="sys-name">${led} ${p.name}</div>
          <div class="sys-meta">${meta}</div>
        </div>
        <div class="sys-actions">
          <button class="sys-btn primary" onclick="restartOne('${p.name}')">재시작</button>
        </div>
      </div>`;
    }).join('');

    // 자동시작
    const sw = document.getElementById('autoload_switch');
    const desc = document.getElementById('autoload_desc');
    if (data.autoload) {
      sw.classList.add('on');
      desc.textContent = '✅ Mac 부팅 시 자동 시작';
    } else {
      sw.classList.remove('on');
      desc.textContent = '❌ 수동으로 시작 필요';
    }
  } catch (e) {
    document.getElementById('sys_processes').innerHTML =
      `<div class="empty">⚠️ 시스템 API (:9000) 응답 없음<br>
      <code style="font-size:11px">cd ~/trading-dashboard &amp;&amp; python3 system_api.py &amp;</code></div>`;
    document.getElementById('autoload_desc').textContent = '확인 불가';
  }
}

async function toggleAutoload() {
  const cur = STATE.system.autoload;
  const path = cur ? 'autoload/off' : 'autoload/on';
  const label = cur ? '자동시작 OFF' : '자동시작 ON';
  const ok = await ensureAuth({desc: `${label}?`});
  if (!ok) return;
  try {
    await fetch(`${APIS.system}/system/${path}`, { method:'POST' });
    toast(`✅ ${label}`);
    setTimeout(loadSystemView, 800);
  } catch (e) {
    toast(`❌ 실패`);
  }
}

async function loadLog(name) {
  document.getElementById('log_view').textContent = '로딩...';
  try {
    const r = await fetch(`${APIS.system}/system/log/${name}?tail=80`);
    const data = await r.json();
    document.getElementById('log_view').textContent =
      (data.lines || []).join('\n') || '(빈 로그)';
  } catch (e) {
    document.getElementById('log_view').textContent = `❌ 실패: ${e.message}`;
  }
}

/* ─── 데이터 로드 ────────────────────────────────────── */
async function fetchHealth(bot) {
  try {
    const r = await fetch(`${APIS[bot]}/health`, { signal:AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function fetchStatus(bot) {
  try {
    const r = await fetch(`${APIS[bot]}/status?ts=${Date.now()}`, { signal:AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function applyHealthUI(bot, health) {
  STATE[bot].online = !!health;
  STATE[bot].bot_mode = health?.bot_mode || null;
  STATE[bot].trade_mode = health?.trade_mode || null;

  // 메인 카드 메타
  const meta = document.getElementById(`${bot}_card_meta`);
  meta.innerHTML = modeBadge(health?.trade_mode, health?.bot_mode);

  // 메뉴 LED
  const menuLed = document.getElementById(`menu_${bot}_led`);
  if (menuLed) {
    menuLed.className = 'led ' + (health
      ? (health.bot_mode === 'running' ? 'on'
        : health.bot_mode === 'soft_stop' ? 'warn'
        : 'err')
      : 'off');
  }

  // 봇 상세 뷰: 세그먼트
  const seg = document.getElementById(`${bot}_seg`);
  if (seg) {
    seg.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
    if (health) {
      const map = {running:'run', soft_stop:'soft', stopped:'stop'};
      const k = map[health.bot_mode];
      if (k) seg.querySelector(`.seg-btn[data-mode="${k}"]`)?.classList.add('active');
    }
  }

  // 거래 토글
  const sw = document.getElementById(`${bot}_switch`);
  const nameEl = document.getElementById(`${bot}_trade_name`);
  const descEl = document.getElementById(`${bot}_trade_desc`);
  if (sw && nameEl && descEl) {
    if (health?.trade_mode === 'real') {
      sw.classList.add('on');
      nameEl.textContent = 'REAL';
      nameEl.style.color = 'var(--danger)';
      descEl.textContent = '⚠️ 실전 주문';
    } else {
      sw.classList.remove('on');
      nameEl.textContent = health ? 'DEMO' : '-';
      nameEl.style.color = '';
      descEl.textContent = health ? '시뮬레이션' : '봇 오프라인';
    }
  }
}

function renderReviews(status) {
  if (!status) return;

  // 자체평가 통계 (14일)
  const summary = status.review_summary || {};
  const sumEl = document.getElementById('review_summary');
  if (sumEl) {
    if (!summary.count) {
      sumEl.innerHTML = '<div class="empty" style="padding:8px 0">평가 누적 중...</div>';
    } else {
      const v = summary.by_verdict || {};
      const total = summary.count;
      const eff_e = summary.avg_entry_eff != null ? (summary.avg_entry_eff * 100).toFixed(0) + '%' : '-';
      const eff_x = summary.avg_exit_eff != null ? (summary.avg_exit_eff * 100).toFixed(0) + '%' : '-';
      const missed = summary.avg_missed_pct != null ? (summary.avg_missed_pct * 100).toFixed(2) + '%' : '-';
      sumEl.innerHTML = `
        <div style="display:flex;justify-content:space-between;padding:3px 0"><span style="color:var(--muted)">총 평가</span><b>${total}건</b></div>
        <div style="display:flex;justify-content:space-between;padding:3px 0"><span class="up">🏆 최선</span><b>${v['최선']||0}건</b></div>
        <div style="display:flex;justify-content:space-between;padding:3px 0"><span style="color:var(--ok)">✅ 양호</span><b>${v['양호']||0}건</b></div>
        <div style="display:flex;justify-content:space-between;padding:3px 0"><span class="warn">💡 개선가능</span><b>${v['개선가능']||0}건</b></div>
        <div style="display:flex;justify-content:space-between;padding:3px 0"><span class="down">⚠️ 재학습</span><b>${v['재학습필요']||0}건</b></div>
        <div style="border-top:1px solid var(--line);margin-top:5px;padding-top:5px;color:var(--muted);font-size:10px">
          진입 효율 ${eff_e} · 청산 효율 ${eff_x}<br>
          베스트 대비 평균 ${missed} 놓침
        </div>
      `;
    }
  }

  // 반복 실수
  const repeats = status.repeated_mistakes || [];
  const repEl = document.getElementById('repeated_mistakes');
  if (repEl) {
    if (repeats.length === 0) {
      repEl.innerHTML = '<div class="empty" style="padding:8px 0">감지된 패턴 없음 ✅</div>';
    } else {
      repEl.innerHTML = repeats.slice(0, 5).map(p => `
        <div style="padding:5px 0;border-bottom:1px dotted #1f2937">
          <div style="font-weight:600">${p.pattern} <span style="color:var(--warn)">${p.count}회</span></div>
          <div style="color:var(--muted);font-size:10px;margin-top:2px">→ ${p.suggestion}</div>
        </div>
      `).join('');
    }
  }

  // 최근 평가 테이블
  const reviews = status.reviews || [];
  const tb = document.getElementById('reviews_table');
  if (tb) {
    if (reviews.length === 0) {
      tb.innerHTML = '<tr><td colspan="6" class="empty">평가 누적 시 표시</td></tr>';
    } else {
      tb.innerHTML = reviews.slice(0, 10).map(r => {
        const ts = (r.reviewed_at || '').slice(11, 16);
        const eff_e = r.entry_eff != null ? (r.entry_eff * 100).toFixed(0) + '%' : '-';
        const eff_x = r.exit_eff != null ? (r.exit_eff * 100).toFixed(0) + '%' : '-';
        const verdictColor = r.verdict === '최선' ? 'up'
                           : r.verdict === '양호' ? 'info'
                           : r.verdict === '개선가능' ? 'warn'
                           : r.verdict === '재학습필요' ? 'down' : '';
        return `<tr>
          <td>${ts}</td><td>${r.stock}</td>
          <td class="${verdictColor}">${r.verdict || '-'}</td>
          <td class="num">${eff_e}</td><td class="num">${eff_x}</td>
          <td style="color:var(--muted);font-size:10px">${(r.lesson || '').slice(0,40)}</td>
        </tr>`;
      }).join('');
    }
  }
}

function applyStatusUI(bot, status) {
  STATE[bot].status = status;
  const prefix = bot;

  if (!status) {
    document.getElementById(`${prefix}_card_pnl`).textContent = '-';
    return;
  }

  // 메인 카드 PnL
  const cardPnl = document.getElementById(`${prefix}_card_pnl`);
  cardPnl.textContent = fmtSign(status.today_pnl || 0);
  colorize(cardPnl, status.today_pnl || 0);

  // 상세 통계
  const setStat = (id, val, type) => {
    const el = document.getElementById(`${prefix}_${id}`);
    if (!el) return;
    if (type === 'pct') el.textContent = pct(val || 0);
    else if (type === 'sign') el.textContent = fmtSign(val || 0);
    else el.textContent = fmt(val || 0);
    colorize(el, val || 0);
  };
  setStat('today_pct', status.today_pct, 'pct');
  setStat('today_pnl', status.today_pnl, 'sign');
  setStat('total_pct', status.total_pct, 'pct');
  setStat('balance', status.balance, 'fmt');

  // 포지션 — 평단/수량/총액/현재수익률 (필터 적용)
  const posTb = document.getElementById(`${prefix}_positions`);
  if (posTb) {
    const all = (bot === 'coin' ? (status.current_positions || status.positions || []) : (status.positions || []));
    const filter = bot === 'coin' ? _coinPosFilter : _stockPosFilter;
    const positions = all.filter(p => {
      if (filter === 'all') return true;
      const persona = bot === 'coin' ? (p.persona || '') : (p.profile || '');
      const market = (p.market || 'KR').toLowerCase();
      if (filter === 'kr') return market === 'kr';
      if (filter === 'us') return market === 'us';
      return personaGroup(persona) === filter;
    });

    // 카운트 업데이트
    const cntEl = document.getElementById(`${bot}_pos_count`);
    if (cntEl) cntEl.textContent = filter === 'all'
      ? `총 ${all.length}건`
      : `총 ${all.length}건 / 필터 ${positions.length}건`;

    if (positions.length === 0) {
      posTb.innerHTML = `<tr><td colspan="5" class="empty">${all.length === 0 ? '보유 없음' : '필터 결과 없음'}</td></tr>`;
    } else if (bot === 'coin') {
      posTb.innerHTML = positions.map(p => {
        const pct = p.pnl_pct != null ? p.pnl_pct : 0;
        const pctCls = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
        const sign = pct >= 0 ? '+' : '';
        const notional = p.notional_krw != null ? fmt(p.notional_krw) + '원' : '-';
        const amount = p.amount != null ? (+p.amount).toFixed(4) : '-';
        const entry = p.entry_price != null ? fmt(p.entry_price) : '-';
        return `<tr class="row-coin"><td><b>${p.coin}</b>${personaBadge(p.persona)}</td>` +
               `<td class="num">${amount}</td>` +
               `<td class="num">${entry}</td>` +
               `<td class="num">${notional}</td>` +
               `<td class="num ${pctCls}"><b>${sign}${pct.toFixed(2)}%</b></td></tr>`;
      }).join('');
    } else {
      posTb.innerHTML = positions.map(p => {
        const cur = p.current_price || 0;
        const avg = +p.avg_price || 0;
        const pct = avg > 0 && cur > 0 ? ((cur - avg) / avg * 100) : 0;
        const pctCls = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
        const sign = pct >= 0 ? '+' : '';
        const notional = p.notional_krw != null ? fmt(p.notional_krw) + '원' : '-';
        const mk = (p.market || 'KR').toUpperCase();
        const rowCls = mk === 'US' ? 'row-us' : 'row-kr';
        const mkBadge = mk === 'US' ? '<span class="badge b-us" style="font-size:9px;padding:1px 5px">US</span>' :
                                       '<span class="badge b-kr" style="font-size:9px;padding:1px 5px">KR</span>';
        const priceUsd = p.currency === 'USD' ? ` <span style="opacity:0.6">($${(+p.avg_price).toFixed(2)})</span>` : '';
        return `<tr class="${rowCls}"><td>${mkBadge} <b>${p.stock_name || p.stock}</b> <span style="color:var(--muted);font-size:9px">${p.stock}</span>${personaBadge(p.profile)}</td>` +
               `<td class="num">${p.amount}</td>` +
               `<td class="num">${fmt(p.avg_price_krw || p.avg_price)}${priceUsd}</td>` +
               `<td class="num">${notional}</td>` +
               `<td class="num ${pctCls}"><b>${cur>0?sign+pct.toFixed(2)+'%':'-'}</b></td></tr>`;
      }).join('');
    }
  }
}

function renderHomeOverview() {
  const c = STATE.coin.status, s = STATE.stock.status;

  const todayPnl = (c?.today_pnl || 0) + (s?.today_pnl || 0);
  const balance = (c?.balance || 0) + (s?.balance || 0);
  const totalPnl = (c?.total_pnl || 0) + (s?.total_pnl || 0);
  const initialBal = (c?.initial_balance || 0) + (s?.initial_balance || 0);
  const todayPct = initialBal > 0 ? todayPnl / initialBal : 0;
  const totalPct = initialBal > 0 ? totalPnl / initialBal : 0;

  const pnlEl = document.getElementById('total_today_pnl');
  pnlEl.textContent = fmtSign(todayPnl) + '원';
  colorize(pnlEl, todayPnl);

  const tpEl = document.getElementById('total_today_pct');
  tpEl.textContent = pct(todayPct);
  colorize(tpEl, todayPct);

  const ttEl = document.getElementById('total_total_pct');
  ttEl.textContent = pct(totalPct);
  colorize(ttEl, totalPct);

  // HERO 메인: 합산 잔고 + 시드
  const balEl = document.getElementById('total_balance');
  balEl.textContent = fmt(balance) + '원';
  if (initialBal > 0 && balance > initialBal) balEl.classList.add('up');
  else if (initialBal > 0 && balance < initialBal) balEl.classList.add('down');
  document.getElementById('total_seed').textContent = fmt(initialBal) + '원';

  // 봇 카드별 잔고/시드/진행바
  ['coin', 'stock'].forEach(bot => {
    const st = STATE[bot].status;
    const balCardEl = document.getElementById(`${bot}_card_balance`);
    const seedEl = document.getElementById(`${bot}_card_seed`);
    const barEl = document.getElementById(`${bot}_card_bar`);
    if (!balCardEl || !st) return;

    const seed = st.initial_balance || 0;
    const bal = st.balance || 0;
    balCardEl.textContent = fmt(bal) + '원';
    seedEl.textContent = fmt(seed) + '원';
    balCardEl.classList.remove('up', 'down');
    if (seed > 0 && bal > seed) balCardEl.classList.add('up');
    else if (seed > 0 && bal < seed) balCardEl.classList.add('down');

    // 진행바: 같은 값이면 스킵 (CSS transition 재시작 = 깜빡임 방지)
    if (barEl && seed > 0) {
      const ratio = bal / seed;
      const pct = Math.min(Math.max(ratio * 50, 0), 100);
      const newWidth = pct.toFixed(2) + '%';
      const newClass = 'bal-bar-fill' + (bal > seed ? ' up' : bal < seed ? ' down' : '');
      if (barEl.dataset.lastWidth !== newWidth) {
        barEl.style.width = newWidth;
        barEl.dataset.lastWidth = newWidth;
      }
      if (barEl.className !== newClass) {
        barEl.className = newClass;
      }
    }
  });

  // 통합 최근 거래 (필터 적용)
  const all = [];
  (c?.recent_trades || []).slice(0,20).forEach(t => all.push({...t, _bot:'coin'}));
  (s?.recent_trades || []).slice(0,20).forEach(t => all.push({...t, _bot:'stock'}));
  all.sort((a,b) => (b.created_at || b.ts || '').localeCompare(a.created_at || a.ts || ''));

  // 페르소나/마켓 필터
  const filtered = all.filter(t => {
    if (_tradeFilter === 'all') return true;
    const kind = marketKind(t._bot, t.market);
    if (_tradeFilter === 'coin') return kind === 'coin';
    if (_tradeFilter === 'kr')   return kind === 'kr';
    if (_tradeFilter === 'us')   return kind === 'us';
    // 페르소나 그룹 필터
    return personaGroup(tradePersona(t)) === _tradeFilter;
  });

  // 카운트
  const cntEl = document.getElementById('trade_filter_count');
  if (cntEl) cntEl.textContent = _tradeFilter === 'all'
    ? `총 ${all.length}건`
    : `총 ${all.length}건 / 필터 ${filtered.length}건`;

  const trBody = document.getElementById('all_recent_trades');
  if (filtered.length === 0) {
    trBody.innerHTML = `<tr><td colspan="6" class="empty">${all.length === 0 ? '거래 없음' : '필터 결과 없음'}</td></tr>`;
  } else {
    trBody.innerHTML = filtered.slice(0,15).map(t => {
      const cls = (t.pnl || 0) > 0 ? 'up' : (t.pnl || 0) < 0 ? 'down' : '';
      const ts = (t.created_at || t.ts || '').slice(11, 16);
      const sym = t.coin || t.stock_name || t.stock || '-';
      const kind = marketKind(t._bot, t.market);
      const rowCls = kind === 'coin' ? 'row-coin' : kind === 'us' ? 'row-us' : 'row-kr';
      const persona = tradePersona(t);
      // SELL 일 때 % 수익률 표시. pnl_pct 가 소수(0.05)/퍼센트(5) 모두 처리.
      let pnlText = t.pnl != null ? fmtSign(t.pnl) : '-';
      if ((t.side === 'SELL' || t.side === 'sell') && t.pnl != null) {
        let pct = t.pnl_pct;
        if (pct == null && t.pnl_percent != null) pct = t.pnl_percent;
        if (pct != null) {
          if (Math.abs(pct) < 1.0) pct = pct * 100;
          const sign = pct >= 0 ? '+' : '';
          pnlText += ` <span style="opacity:0.75">(${sign}${pct.toFixed(2)}%)</span>`;
        }
      }
      return `<tr class="${rowCls}"><td>${ts}</td><td>${marketBadge(kind)}</td><td><b>${sym}</b></td>` +
             `<td>${persona ? personaBadge(persona) : '<span style="color:var(--muted);font-size:10px">-</span>'}</td>` +
             `<td>${t.side}</td>` +
             `<td class="num ${cls}">${pnlText}</td></tr>`;
    }).join('');
  }

  renderChart7d();
}

function renderChart7d() {
  const c = STATE.coin.status?.daily_pnl_7d || [];
  const s = STATE.stock.status?.daily_pnl_7d || [];

  const allDays = new Set();
  c.forEach(d => allDays.add(d.day));
  s.forEach(d => allDays.add(d.day));
  const days = [...allDays].sort();

  const cMap = Object.fromEntries(c.map(d => [d.day, d.pnl]));
  const sMap = Object.fromEntries(s.map(d => [d.day, d.pnl]));

  const total = days.reduce((sum, d) => sum + (cMap[d] || 0) + (sMap[d] || 0), 0);
  document.getElementById('chart_total').textContent = fmtSign(total);

  const ctx = document.getElementById('chart7d').getContext('2d');
  if (chart7d) chart7d.destroy();

  chart7d = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days.map(d => d.slice(5)),
      datasets: [
        {
          label: '코인봇',
          data: days.map(d => cMap[d] || 0),
          backgroundColor: '#f7931a99',
          borderColor: '#f7931a',
          borderWidth: 1,
        },
        {
          label: '주식봇',
          data: days.map(d => sMap[d] || 0),
          backgroundColor: '#3fb95099',
          borderColor: '#3fb950',
          borderWidth: 1,
        },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#e6edf3', font: { size: 11 } } },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmtSign(c.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: '#8b949e', font: {size:10} }, stacked: true, grid: {display:false} },
        y: { ticks: { color: '#8b949e', font: {size:10}, callback: v => fmt(v) }, stacked: true, grid: {color:'#30363d33'} },
      },
    },
  });
}

async function fetchTokens() {
  try {
    const r = await fetch(`${APIS.system}/system/tokens`, { signal:AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function renderTokens(t) {
  if (!t) {
    ['token_calls','token_denied','token_tokens','token_max_pct',
     'token_coin_calls','token_stock_calls','token_cost','token_pct_label']
      .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '-'; });
    return;
  }
  document.getElementById('token_calls').textContent = t.total_calls.toLocaleString('ko-KR');
  document.getElementById('token_denied').textContent = t.total_denied.toLocaleString('ko-KR');
  document.getElementById('token_tokens').textContent =
    t.est_tokens >= 1000 ? (t.est_tokens/1000).toFixed(1) + 'K' : t.est_tokens;

  const pctEl = document.getElementById('token_max_pct');
  pctEl.textContent = t.max_5x_pct + '%';
  pctEl.classList.remove('up', 'down', 'warn');
  if (t.max_5x_pct >= 80) pctEl.classList.add('down');
  else if (t.max_5x_pct >= 50) pctEl.classList.add('warn');
  else pctEl.classList.add('up');

  document.getElementById('token_pct_label').textContent = `Max 5x ${t.max_5x_pct}%`;
  document.getElementById('token_coin_calls').textContent = t.coin.calls;
  document.getElementById('token_stock_calls').textContent = t.stock.calls;
  document.getElementById('token_cost').textContent = '$' + t.est_cost_usd.toFixed(3);
}

async function fetchMarket() {
  try {
    const r = await fetch(`${APIS.system}/system/market`, { signal:AbortSignal.timeout(4000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function fetchInsights() {
  try {
    const r = await fetch(`${APIS.system}/system/insights`, { signal:AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function renderMarket(m) {
  if (!m) return;
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const setChg = (id, v) => {
    const el = document.getElementById(id); if (!el) return;
    if (v == null) { el.textContent = '-'; return; }
    el.textContent = pct(v);
    el.classList.remove('up','down');
    if (v > 0) el.classList.add('up'); else if (v < 0) el.classList.add('down');
  };

  setVal('mkt_btc', m.btc ? fmt(m.btc) + '원' : '-');
  setChg('mkt_btc_chg', m.btc_24h);
  // 알트 평균
  setVal('mkt_alt', m.alt_tracked > 0 ? `${m.alt_tracked}종 평균` : '-');
  setChg('mkt_alt_chg', m.alt_avg_24h);

  // 공포탐욕
  const fngEl = document.getElementById('mkt_fng');
  const fngLbl = document.getElementById('mkt_fng_lbl');
  if (m.fear_greed != null) {
    fngEl.textContent = m.fear_greed;
    let lbl, color;
    if (m.fear_greed >= 75) { lbl='과열'; color='var(--up)'; }
    else if (m.fear_greed >= 55) { lbl='탐욕'; color='var(--warn)'; }
    else if (m.fear_greed >= 45) { lbl='중립'; color='var(--text)'; }
    else if (m.fear_greed >= 25) { lbl='공포'; color='var(--info)'; }
    else { lbl='패닉'; color='var(--down)'; }
    fngLbl.textContent = lbl;
    fngLbl.style.color = color;
    fngEl.style.color = color;
  } else {
    fngEl.textContent = '-';
    fngLbl.textContent = '-';
  }

  setVal('mkt_kospi', m.kospi ? m.kospi.toFixed(2) : '-');
  setChg('mkt_kospi_chg', m.kospi_chg);
  setVal('mkt_nasdaq', m.nasdaq ? m.nasdaq.toFixed(0) : '-');
  setChg('mkt_nasdaq_chg', m.nasdaq_chg);
  setVal('mkt_usdkrw', m.usd_krw ? m.usd_krw.toFixed(0) + '원' : '-');
}

function renderInsights(i) {
  if (!i || !i.combined) {
    ['kpi_winrate','kpi_rr','kpi_mdd','kpi_trades'].forEach(id => {
      const el = document.getElementById(id); if (el) el.textContent = '-';
    });
    return;
  }

  const c = i.combined;
  const wr = (c.winrate * 100).toFixed(1) + '%';
  const wrEl = document.getElementById('kpi_winrate');
  wrEl.textContent = wr;
  wrEl.classList.remove('up','down','warn');
  if (c.winrate >= 0.5) wrEl.classList.add('up');
  else if (c.winrate >= 0.4) wrEl.classList.add('warn');
  else wrEl.classList.add('down');

  // 평균 RR (양 봇 평균)
  const bots = Object.values(i.by_bot || {});
  const avgRR = bots.length ? bots.reduce((s,b) => s + b.rr, 0) / bots.length : 0;
  const rrEl = document.getElementById('kpi_rr');
  rrEl.textContent = avgRR.toFixed(2);
  rrEl.classList.remove('up','down','warn');
  if (avgRR >= 1.3) rrEl.classList.add('up');
  else if (avgRR >= 1.0) rrEl.classList.add('warn');
  else rrEl.classList.add('down');

  const mddEl = document.getElementById('kpi_mdd');
  mddEl.textContent = (c.max_mdd * 100).toFixed(1) + '%';
  mddEl.classList.add('down');

  document.getElementById('kpi_trades').textContent = c.trades;

  // 시간대 히트맵
  const grid = document.getElementById('hourly_grid');
  if (grid && i.hourly) {
    const max = Math.max(...i.hourly, 1);
    grid.innerHTML = i.hourly.map((cnt, h) => {
      let lvl = 0;
      if (cnt > 0) {
        const ratio = cnt / max;
        lvl = ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : 1;
      }
      return `<div class="hourly-cell ${lvl ? 'h-'+lvl : ''}" title="${h}시: ${cnt}건"></div>`;
    }).join('');
  }

  // 페르소나
  const personaList = document.getElementById('persona_list');
  if (personaList) {
    const personas = Object.entries(i.personas || {})
      .filter(([k,v]) => v.trades > 0)
      .sort((a,b) => b[1].pnl - a[1].pnl)
      .slice(0, 6);
    if (personas.length === 0) {
      personaList.innerHTML = '<div class="empty" style="padding:8px 0">데이터 없음</div>';
    } else {
      personaList.innerHTML = personas.map(([name, p]) => {
        const wr = p.trades ? (p.wins / p.trades * 100).toFixed(0) : 0;
        const cls = p.pnl > 0 ? 'up' : p.pnl < 0 ? 'down' : '';
        const icon = p.bot === 'coin' ? '🪙' : '📈';
        return `<div class="persona-row">
          <div class="persona-name">${icon} ${name}</div>
          <div style="display:flex; align-items:center; gap:6px">
            <span class="persona-stats">${p.trades}건 · ${wr}%</span>
            <span class="persona-pnl ${cls}">${fmtSign(p.pnl)}</span>
          </div>
        </div>`;
      }).join('');
    }
  }
}

let _marketCache = {data: null, ts: 0};
async function fetchMarketCached() {
  // 60초 캐시 (외부 API 호출 보호)
  if (Date.now() - _marketCache.ts < 60000 && _marketCache.data) return _marketCache.data;
  const m = await fetchMarket();
  if (m) _marketCache = {data:m, ts:Date.now()};
  return m;
}

/* sessionStorage 캐시 → 페이지 진입 즉시 이전 데이터 표시 (0초) */
const CACHE_KEY = 'doogeun_dash_cache_v2';

function saveCache(snapshot) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({...snapshot, _ts: Date.now()})); }
  catch {}
}

function loadCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // 5분 이내 캐시만
    if (Date.now() - (data._ts || 0) > 300000) return null;
    return data;
  } catch { return null; }
}

function applySnapshot(s) {
  if (!s) return;
  if (s.coinH) applyHealthUI('coin', s.coinH);
  if (s.stockH) applyHealthUI('stock', s.stockH);
  if (s.coinS) applyStatusUI('coin', s.coinS);
  if (s.stockS) applyStatusUI('stock', s.stockS);
  if (s.stockS) renderReviews(s.stockS);
  renderHomeOverview();
  if (s.tokens) renderTokens(s.tokens);
  if (s.market) renderMarket(s.market);
  if (s.insights) renderInsights(s.insights);
}

async function loadAll(force = false) {
  if (force) _marketCache.ts = 0;

  // 1) 빠른 데이터 먼저 (health + status 병렬)
  const fastResults = await Promise.all([
    fetchHealth('coin'), fetchStatus('coin'),
    fetchHealth('stock'), fetchStatus('stock'),
    fetchTokens(), fetchInsights(),
  ]);
  const [coinH, coinS, stockH, stockS, tokens, insights] = fastResults;

  applyHealthUI('coin', coinH);
  applyHealthUI('stock', stockH);
  applyStatusUI('coin', coinS);
  applyStatusUI('stock', stockS);
  renderReviews(stockS);
  renderHomeOverview();
  renderTokens(tokens);
  renderInsights(insights);

  document.getElementById('upd-time').textContent =
    new Date().toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit', second:'2-digit'});

  // 2) 시장 데이터는 별도 비동기 (외부 API 호출이라 느림 — UI 블록 X)
  fetchMarketCached().then(market => {
    if (market) renderMarket(market);
    saveCache({coinH, coinS, stockH, stockS, tokens, insights, market});
  });

  if (document.getElementById('view-system').classList.contains('active')) {
    loadSystemView();
  }

  // 알림 처리
  const allAlerts = collectAllAlerts();
  checkNewAlerts(allAlerts);
  if (document.getElementById('view-alerts')?.classList.contains('active')) {
    renderAlerts(allAlerts);
  } else {
    // 메뉴 배지만 갱신
    const seen = getSeenIds();
    const unread = allAlerts.filter(a => !seen.has(`${a.bot}-${a.id}`)).length;
    const badge = document.getElementById('menu_alert_count');
    if (badge) {
      if (unread > 0) { badge.textContent = unread; badge.style.display = 'inline-block'; }
      else badge.style.display = 'none';
    }
  }

  if (force) toast('🔄 새로고침 완료');
}

/* ─── Pull-to-Refresh (모바일) ───────────────────────── */
(function setupPTR() {
  let startY = 0, currentY = 0, pulling = false;
  const ptr = document.getElementById('ptr');
  const ptrText = document.getElementById('ptr-text');
  const ptrIcon = document.getElementById('ptr-icon');
  const THRESHOLD = 70;

  if (!ptr) return;

  document.addEventListener('touchstart', e => {
    if (window.scrollY > 5) return;
    if (document.querySelector('.modal-bg.show')) return;
    if (document.querySelector('.menu.show')) return;
    startY = e.touches[0].clientY;
    pulling = true;
  }, {passive:true});

  document.addEventListener('touchmove', e => {
    if (!pulling) return;
    currentY = e.touches[0].clientY;
    const dy = currentY - startY;
    if (dy <= 0) { ptr.style.transform = 'translate(-50%, -100%)'; return; }
    const pct = Math.min(dy / THRESHOLD, 1.5);
    ptr.style.transform = `translate(-50%, ${Math.min(dy * 0.5, 50)}px)`;
    ptr.style.opacity = Math.min(pct, 1);
    if (dy >= THRESHOLD) { ptrText.textContent = '놓으면 새로고침'; ptrIcon.style.transform = 'rotate(180deg)'; }
    else { ptrText.textContent = '당겨서 새로고침'; ptrIcon.style.transform = 'rotate(0)'; }
  }, {passive:true});

  document.addEventListener('touchend', () => {
    if (!pulling) return;
    const dy = currentY - startY;
    pulling = false;
    if (dy >= THRESHOLD) {
      ptrText.textContent = '새로고침 중...';
      ptrIcon.style.animation = 'spin 0.8s linear infinite';
      loadAll(true).finally(() => {
        ptr.style.transform = 'translate(-50%, -100%)';
        ptrIcon.style.animation = '';
        ptrIcon.style.transform = 'rotate(0)';
      });
    } else {
      ptr.style.transform = 'translate(-50%, -100%)';
      ptrIcon.style.transform = 'rotate(0)';
    }
  }, {passive:true});

  // CSS keyframe 동적 주입
  const style = document.createElement('style');
  style.textContent = '@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
})();

/* ─── 캐시 버스트 (앱 버전 변경시 강제 갱신) ──────────── */
(function checkVersion() {
  const stored = localStorage.getItem('trading_dash_version');
  if (stored && stored !== APP_VERSION) {
    // 버전 바뀜 → SW 캐시 + localStorage 클린 (인증/PW 유지)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
    }
    if (window.caches) caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
    console.log(`[버전 갱신] ${stored} → ${APP_VERSION}`);
  }
  localStorage.setItem('trading_dash_version', APP_VERSION);
})();

/* ─── 자가개선 캘린더 + What-If ──────────────────────── */
function initCalendar() {
  const now = new Date();
  if (STATE.cal.year === null) {
    STATE.cal.year = now.getFullYear();
    STATE.cal.month = now.getMonth();
  }
  document.getElementById(`calbtn_coin`).style.background = STATE.cal.bot === 'coin' ? '#f7931a33' : '#0d1117';
  document.getElementById(`calbtn_stock`).style.background = STATE.cal.bot === 'stock' ? '#3fb95033' : '#0d1117';
  renderCalendar();
}

function calNav(dir) {
  if (dir === 0) {
    const now = new Date();
    STATE.cal.year = now.getFullYear();
    STATE.cal.month = now.getMonth();
  } else {
    STATE.cal.month += dir;
    if (STATE.cal.month < 0) { STATE.cal.month = 11; STATE.cal.year--; }
    if (STATE.cal.month > 11) { STATE.cal.month = 0; STATE.cal.year++; }
  }
  renderCalendar();
}

function calBot(bot) {
  STATE.cal.bot = bot;
  document.getElementById(`calbtn_coin`).style.background = bot === 'coin' ? '#f7931a33' : '#0d1117';
  document.getElementById(`calbtn_stock`).style.background = bot === 'stock' ? '#3fb95033' : '#0d1117';
  renderCalendar();
}

async function fetchCalendarData(bot, year, month) {
  // 봇 status에서 최근 거래만 받아와서 일별 집계
  // (전체 히스토리가 필요하면 별도 API 필요 - MVP는 최근 거래로)
  const status = STATE[bot].status;
  if (!status) return {trades:{}, tunes:{}};

  const trades = {};
  (status.recent_trades || []).forEach(t => {
    const d = (t.created_at || t.ts || '').slice(0, 10);
    if (!d) return;
    if (!trades[d]) trades[d] = {pnl:0, count:0};
    trades[d].pnl += (t.pnl || 0);
    trades[d].count++;
  });

  // 튜닝 데이터는 별도 status 필드 'tune_log' 가 있으면 사용
  const tunes = {};
  (status.tune_log || []).forEach(t => {
    const d = (t.created_at || t.ts || '').slice(0, 10);
    if (!d) return;
    if (!tunes[d]) tunes[d] = [];
    tunes[d].push(t);
  });

  return {trades, tunes};
}

async function renderCalendar() {
  const {year, month, bot} = STATE.cal;
  const monthName = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'][month];
  document.getElementById('cal_month').textContent = `${year}년 ${monthName}`;

  const data = await fetchCalendarData(bot, year, month);
  const grid = document.getElementById('cal_grid');

  const dows = ['일','월','화','수','목','금','토'];
  let html = dows.map(d => `<div class="cal-dow">${d}</div>`).join('');

  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;

  for (let i = 0; i < firstDow; i++) html += `<div class="cal-cell empty"></div>`;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const tradeData = data.trades[dateStr];
    const tuneData = data.tunes[dateStr];
    const isToday = isCurrentMonth && today.getDate() === d;

    const classes = ['cal-cell'];
    if (tradeData) classes.push('has-trade');
    if (tuneData) classes.push('has-tune');
    if (isToday) classes.push('today');

    const pnlHtml = tradeData
      ? `<div class="cal-pnl ${tradeData.pnl > 0 ? 'up' : tradeData.pnl < 0 ? 'down' : ''}">${fmtSign(tradeData.pnl)}</div>`
      : '';
    const dotHtml = tuneData ? `<span class="cal-dot"></span>` : '';

    html += `<div class="${classes.join(' ')}" onclick="selectDay('${dateStr}')">
      <div class="cal-day">${d}</div>
      ${pnlHtml}
      ${dotHtml}
    </div>`;
  }

  grid.innerHTML = html;
}

async function selectDay(dateStr) {
  STATE.cal.selectedDay = dateStr;
  const detail = document.getElementById('cal_detail');
  const bot = STATE.cal.bot;
  const data = await fetchCalendarData(bot, STATE.cal.year, STATE.cal.month);

  const trade = data.trades[dateStr];
  const tunes = data.tunes[dateStr] || [];

  let html = `<h4><svg class="ic ic-sm"><use href="#i-cal"/></svg>${dateStr} (${bot === 'coin' ? '🪙 코인봇' : '📈 주식봇'})</h4>`;

  if (trade) {
    html += `<div class="tune-item">📊 거래 ${trade.count}건 · P&L <b class="${trade.pnl > 0 ? 'up' : 'down'}">${fmtSign(trade.pnl)}</b></div>`;
  } else {
    html += `<div class="tune-item" style="color:var(--muted)">거래 데이터 없음</div>`;
  }

  if (tunes.length === 0) {
    html += `<div class="tune-item" style="color:var(--muted)">자가개선 튜닝 없음</div>`;
  } else {
    tunes.forEach(t => {
      html += `<div class="tune-item">
        🔧 <b>${t.param || t.variable}</b>: ${t.old_value} → ${t.new_value}
        <div style="font-size:11px; color:var(--muted); margin-top:2px">사유: ${t.pattern || t.reason || '-'}</div>
      </div>`;
      // What-If 시뮬레이션
      const sim = simulateWhatIf(t, bot);
      html += `<div class="whatif">
        <div class="whatif-title"><svg class="ic ic-xs"><use href="#i-bolt"/></svg>What-If: 이 튜닝을 30일 전부터 적용했다면</div>
        <div class="whatif-row"><span>예상 누적 P&L 변동</span><b class="${sim.pnl_diff >= 0 ? 'up' : 'down'}">${fmtSign(sim.pnl_diff)}</b></div>
        <div class="whatif-row"><span>예상 승률 변동</span><b>${(sim.winrate_diff*100).toFixed(1)}%p</b></div>
        <div class="whatif-row"><span>예상 거래수 변동</span><b>${sim.trades_diff > 0 ? '+' : ''}${sim.trades_diff}건</b></div>
        <div class="whatif-row"><span>예상 MDD 변동</span><b class="${sim.mdd_diff <= 0 ? 'up' : 'down'}">${(sim.mdd_diff*100).toFixed(2)}%p</b></div>
      </div>`;
    });
  }

  detail.innerHTML = html;
}

function simulateWhatIf(tune, bot) {
  /* 휴리스틱 시뮬레이터 - 튜닝 종류별로 효과 추정.
   * 실제 백테스트는 봇 측 backtest 스크립트를 호출해야 함.
   * MVP: 변수별 경험적 추정.
   */
  const param = (tune.param || tune.variable || '').toLowerCase();
  const oldV = parseFloat(tune.old_value) || 0;
  const newV = parseFloat(tune.new_value) || 0;
  const delta = newV - oldV;

  // 지난 30일 거래 데이터 (status에서)
  const recent = (STATE[bot].status?.recent_trades || []);
  const totalTrades = recent.length || 1;
  const wins = recent.filter(t => (t.pnl || 0) > 0).length;
  const baseWinrate = wins / totalTrades;
  const baseTotalPnl = recent.reduce((s,t) => s + (t.pnl || 0), 0);

  let pnlMult = 1.0, winrateDelta = 0, tradesDelta = 0, mddDelta = 0;

  if (param.includes('threshold')) {
    // 임계값 ↑ → 거래수 ↓, 승률 ↑, P&L 안정화
    const factor = delta / 5;
    tradesDelta = Math.round(-totalTrades * 0.10 * factor);
    winrateDelta = 0.03 * factor;
    pnlMult = 1 + 0.05 * factor;
    mddDelta = -0.005 * factor;
  } else if (param.includes('vol')) {
    // 거래량 임계값 ↑ → 거래수 ↓, 위양성 ↓
    const factor = delta / 0.2;
    tradesDelta = Math.round(-totalTrades * 0.08 * factor);
    winrateDelta = 0.02 * factor;
    pnlMult = 1 + 0.03 * factor;
    mddDelta = -0.003 * factor;
  } else if (param.includes('trailing')) {
    // 트레일링 오프셋 ↓ (더 타이트) → 익절 빨라짐, 큰 수익 놓침
    const factor = delta / 0.005;
    tradesDelta = 0;
    winrateDelta = 0.04 * Math.abs(factor);
    pnlMult = 1 - 0.02 * Math.abs(factor);
    mddDelta = -0.002;
  } else if (param.includes('blacklist')) {
    // 블랙리스트 추가 → 거래수 ↓, 손실 회피
    tradesDelta = -3;
    winrateDelta = 0.01;
    pnlMult = 1.02;
    mddDelta = -0.005;
  } else {
    pnlMult = 1.01;
  }

  return {
    pnl_diff: Math.round(baseTotalPnl * (pnlMult - 1)),
    winrate_diff: winrateDelta,
    trades_diff: tradesDelta,
    mdd_diff: mddDelta,
  };
}

/* ─── 시작 ────────────────────────────────────────── */
// 페이지 로드 즉시 캐시 표시 (0초 보임)
const cached = loadCache();
if (cached) {
  console.log('[캐시] 즉시 표시 후 백그라운드 갱신');
  applySnapshot(cached);
  document.getElementById('upd-time').textContent = '⚡ 캐시 (갱신 중...)';
}

if (!FIREBASE_MODE) {
  loadAll();
  setInterval(loadAll, 30000);  // 30초 폴링 (CPU 부담 감소)
} else {
  console.log('[모드] Firebase Firestore (외부)');
  if (!cached) toast('🌐 Firebase 모드 - 실시간 동기화');
}

// 필터 칩 초기 active 상태 복원 (localStorage)
document.addEventListener('DOMContentLoaded', _syncFilterChips);
if (document.readyState !== 'loading') _syncFilterChips();
