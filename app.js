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

// ─── 포지션 상세 모달 ─────────────────────────────────────
function openPosModal(bot, key) {
  const status = STATE[bot]?.status;
  if (!status) return;
  const all = bot === 'coin' ? (status.current_positions || status.positions || []) : (status.positions || []);
  const p = all.find(x => (x.coin || x.stock) === key);
  if (!p) return;
  const isCoin = bot === 'coin';
  const sym = isCoin ? p.coin : `${p.stock_name || p.stock} (${p.stock})`;
  const persona = isCoin ? p.persona : p.profile;
  const market = isCoin ? '코인 (Upbit)' : (p.market === 'US' ? '미국 (NASDAQ/NYSE)' : '한국 (KOSPI/KOSDAQ)');
  const avg = isCoin ? p.entry_price : (p.avg_price_krw || p.avg_price);
  const cur = p.current_price || 0;
  const amt = isCoin ? (+p.amount).toFixed(6) : p.amount;
  const invested = isCoin ? (p.krw_invested || avg * +p.amount) : (avg * +p.amount);
  const fx = +p.fx_rate || 1;
  const isUsd = p.currency === 'USD';
  const curKrw = isUsd ? cur * fx : cur;
  const currentValue = curKrw > 0 ? curKrw * +p.amount : invested;
  const pnl = currentValue - invested;
  const pct = avg > 0 && cur > 0 ? ((cur - avg) / avg * 100) : (p.pnl_pct || 0);
  const pctCls = pnl > 0 ? 'up' : pnl < 0 ? 'down' : '';
  const sign = pnl >= 0 ? '+' : '';
  const enteredAt = (p.entered_at || p.entry_ts || '').slice(0, 16).replace('T', ' ');
  const stopLoss = p.stop_loss_pct != null ? (p.stop_loss_pct * 100).toFixed(2) + '%' :
                   p.stop_loss != null ? p.stop_loss : '-';
  const takeProfit = p.take_profit_pct != null ? (p.take_profit_pct * 100).toFixed(2) + '%' :
                     p.take_profit != null ? p.take_profit : '-';
  let extra = p.extra_json || p.extra;
  if (typeof extra === 'string') { try { extra = JSON.parse(extra); } catch { extra = null; } }
  const beActive = extra?.be_done || p.trailing_active === 1;
  const trailingHigh = p.trailing_high || extra?.trailing_high;

  document.getElementById('posModalTitle').innerHTML =
    `${isCoin ? '🪙' : '📈'} ${sym} ${personaBadge(persona)}`;

  const rows = [
    ['시장', market],
    ['진입 시각', enteredAt || '-'],
    ['전략', persona || '-'],
    ['', ''],
    ['평단', `<b>${fmt(avg)}원</b>${isUsd ? ` ($${(+p.avg_price).toFixed(2)})` : ''}`],
    ['수량', amt],
    ['투자금', `<b>${fmt(invested)}원</b>`],
    ['현재가', cur > 0 ? `${fmt(curKrw)}원` : '-'],
    ['현재금액', `<b class="${pctCls}">${fmt(currentValue)}원</b>`],
    ['평가손익', `<b class="${pctCls}">${sign}${fmt(pnl)}원 (${sign}${pct.toFixed(2)}%)</b>`],
    ['', ''],
    ['손절선', stopLoss],
    ['익절선', takeProfit],
    ['BE/트레일링', beActive ? '🟢 활성 (부분익절 후 잔량 라이딩)' : '⚪ 미활성'],
    ['트레일링 최고가', trailingHigh ? fmt(trailingHigh) + '원' : '-'],
  ];
  const html = rows.map(([k, v]) => k === '' ? '<div style="height:6px"></div>' :
    `<div style="display:flex;justify-content:space-between;gap:8px"><span style="color:var(--muted);min-width:100px">${k}</span><span style="text-align:right">${v}</span></div>`).join('');
  document.getElementById('posModalBody').innerHTML = html;
  document.getElementById('posModal').classList.add('show');
}

function closePosModal() { document.getElementById('posModal').classList.remove('show'); }

// ─── 페르소나 상세 모달 ───────────────────────────────────
function openPersonaModal(bot, persona) {
  const status = STATE[bot]?.status;
  if (!status) return;
  const stats = (status.persona_stats || []).find(p => p.persona === persona);
  if (!stats) return;
  const trades = (status.recent_trades || []).filter(t => {
    const tp = tradePersona(t);
    return tp === persona || (tp && PERSONA_META[tp]?.group === PERSONA_META[persona]?.group);
  }).slice(0, 30);
  const meta = PERSONA_META[persona] || {icon:'•', trait:''};
  const winrateCls = stats.winrate >= 60 ? 'up' : stats.winrate < 40 ? 'down' : '';
  const pnlCls = stats.total_pnl > 0 ? 'up' : stats.total_pnl < 0 ? 'down' : '';

  document.getElementById('personaModalTitle').innerHTML =
    `${meta.icon} ${persona} <span style="font-weight:400;font-size:11px;color:var(--muted)">${meta.trait || ''}</span>`;

  const summary = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px;font-size:11px">
      <div class="stat" style="padding:8px"><div class="stat-label">거래수</div><div style="font-size:14px;font-weight:700">${stats.trades}건</div></div>
      <div class="stat" style="padding:8px"><div class="stat-label">승률</div><div class="${winrateCls}" style="font-size:14px;font-weight:700">${stats.winrate.toFixed(1)}%</div></div>
      <div class="stat" style="padding:8px"><div class="stat-label">승/패</div><div style="font-size:14px;font-weight:700">${stats.wins}/${stats.losses}</div></div>
      <div class="stat" style="padding:8px"><div class="stat-label">누적P&L</div><div class="${pnlCls}" style="font-size:14px;font-weight:700">${fmtSign(stats.total_pnl)}</div></div>
    </div>
  `;
  const tradesHtml = trades.length === 0
    ? '<div class="empty">최근 거래 없음</div>'
    : '<table style="width:100%;font-size:10.5px"><thead><tr><th>시각</th><th>심볼</th><th>매매</th><th class="num">P&L</th></tr></thead><tbody>' +
      trades.map(t => {
        const ts = (t.ts || t.created_at || '').slice(5, 16).replace('T', ' ');
        const sym = t.coin || t.stock_name || t.stock || '-';
        const cls = (t.pnl || 0) > 0 ? 'up' : (t.pnl || 0) < 0 ? 'down' : '';
        return `<tr><td>${ts}</td><td>${sym}</td><td>${t.side}</td><td class="num ${cls}">${fmtSign(t.pnl || 0)}</td></tr>`;
      }).join('') + '</tbody></table>';
  document.getElementById('personaModalBody').innerHTML = summary + tradesHtml;
  document.getElementById('personaModal').classList.add('show');
}

function closePersonaModal() { document.getElementById('personaModal').classList.remove('show'); }

// ─── 사유별 라벨/색 매핑 ──────────────────────────────────
const REASON_META = {
  '부분익절+BE': {icon:'🎯', cls:'up',   desc:'Qullamaggie 부분익절 후 BE 라이딩'},
  'MA트레일링': {icon:'📈', cls:'up',   desc:'BE 후 MA 깨질 때 청산 (잔량)'},
  '매도패턴':   {icon:'⚠️', cls:'warn', desc:'쌍봉/헤드앤숄더 즉시청산'},
  '손절':       {icon:'🛑', cls:'down', desc:'ADR 동적 손절 / 긴급'},
  '강제청산':   {icon:'⏰', cls:'',     desc:'한국장/미장 마감 강제'},
  '익절':       {icon:'💰', cls:'up',   desc:'고/중 익절 (전량)'},
  '횡보청산':   {icon:'😴', cls:'',     desc:'2시간+ 횡보 강제'},
  '기타':       {icon:'•',  cls:'',     desc:''},
};

// ─── 종목별 거래 라이프사이클 모달 ────────────────────────
function openStockModal(bot, stock) {
  // 백엔드에 종목 거래내역 endpoint가 있으면 fetch, 없으면 status에서 필터
  const status = STATE[bot]?.status;
  if (!status) return;
  const trades = (status.recent_trades || []).filter(t =>
    (t.coin || t.stock) === stock
  ).slice(0, 30);
  const ranking = (status.stock_pnl_ranking || {});
  const stat = [...(ranking.winners || []), ...(ranking.losers || [])].find(s => s.stock === stock);
  const name = stat?.stock_name || stock;
  const totalPnl = stat?.total_pnl || 0;
  const totalCls = totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : '';

  document.getElementById('stockModalTitle').innerHTML =
    `${bot === 'coin' ? '🪙' : '📈'} ${name} <span style="font-size:11px;color:var(--muted)">${stock}</span>`;

  const summary = stat ? `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px;font-size:11px">
      <div class="stat" style="padding:8px"><div class="stat-label">거래수</div><div style="font-size:14px;font-weight:700">${stat.trades}건</div></div>
      <div class="stat" style="padding:8px"><div class="stat-label">승률</div><div style="font-size:14px;font-weight:700">${stat.winrate}%</div></div>
      <div class="stat" style="padding:8px"><div class="stat-label">최고/최악</div><div style="font-size:11px;font-weight:700"><span class="up">${fmtSign(stat.best_pnl||0)}</span> / <span class="down">${fmtSign(stat.worst_pnl||0)}</span></div></div>
      <div class="stat" style="padding:8px"><div class="stat-label">누적P&L</div><div class="${totalCls}" style="font-size:14px;font-weight:700">${fmtSign(totalPnl)}</div></div>
    </div>
  ` : '';

  const tradesHtml = trades.length === 0
    ? '<div class="empty">최근 거래 데이터 없음 (recent_trades 50건 윈도우 밖)</div>'
    : '<table style="width:100%;font-size:10.5px"><thead><tr><th>시각</th><th>매매</th><th class="num">수량</th><th class="num">가격</th><th>사유</th><th class="num">P&L</th></tr></thead><tbody>' +
      trades.map(t => {
        const ts = (t.ts || t.created_at || '').slice(5, 16).replace('T', ' ');
        const cls = (t.pnl || 0) > 0 ? 'up' : (t.pnl || 0) < 0 ? 'down' : '';
        const sideEmoji = (t.side || '').toUpperCase().startsWith('B') ? '🟢' : '🔴';
        const reason = (t.reason || '').slice(0, 16);
        return `<tr><td>${ts}</td><td>${sideEmoji} ${t.side}</td><td class="num">${t.amount || '-'}</td><td class="num">${fmt(t.price || 0)}</td><td style="font-size:9.5px;color:var(--muted)">${reason}</td><td class="num ${cls}">${fmtSign(t.pnl || 0)}</td></tr>`;
      }).join('') + '</tbody></table>';

  document.getElementById('stockModalBody').innerHTML = summary + tradesHtml;
  document.getElementById('stockModal').classList.add('show');
}

function closeStockModal() { document.getElementById('stockModal').classList.remove('show'); }

// ─── 봇 가동 상태 + 홈 핵심 카드 ──────────────────────────
async function fetchBotProcesses() {
  try {
    const r = await fetch(`${APIS.system}/system/processes`, { signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function cleanupZombies() {
  if (!confirm('좀비 봇 자동 정리하시겠습니까? (가장 오래된 PID 유지)')) return;
  try {
    const r = await fetch(`${APIS.system}/system/processes/cleanup_zombies`, {
      method: 'POST', signal: AbortSignal.timeout(8000),
    });
    const d = await r.json();
    toast(`🧹 ${d.count}개 좀비 정리 완료`);
    setTimeout(renderBotProcesses, 1000);
  } catch (e) { toast('❌ 정리 실패: ' + e.message); }
}

async function renderBotProcesses() {
  const grid = document.getElementById('proc_grid');
  const sumEl = document.getElementById('proc_summary');
  const btn = document.getElementById('proc_cleanup_btn');
  if (!grid) return;
  const data = await fetchBotProcesses();
  if (!data) {
    grid.innerHTML = '<div class="empty">system_api(:9000) 연결 실패</div>';
    return;
  }
  const labelMap = {
    'coinbot': '🪙 코인봇',
    'stockbot-main': '📈 주식봇',
    'stockbot-api': '📈 주식 API',
    'system-api': '⚙️ 시스템 API',
    'firebase-bridge': '☁️ Firebase',
  };
  const colorMap = {
    'ok': 'var(--up)', 'down': 'var(--down)', 'duplicate': 'var(--warn)', 'warn': 'var(--warn)',
  };
  const iconMap = {'ok':'✅','down':'❌','duplicate':'⚠️','warn':'⚠️'};
  let hasZombie = false;
  grid.innerHTML = data.processes.map(p => {
    if (p.status === 'duplicate') hasZombie = true;
    const color = colorMap[p.status] || 'var(--muted)';
    const icon = iconMap[p.status] || '•';
    const startInfo = p.processes.length > 0
      ? `<div style="font-size:9px;color:var(--muted)">PID ${p.processes.map(x=>x.pid).join(', ')}</div>`
      : '';
    return `<div style="padding:6px 8px;background:#0d1117;border:1px solid var(--line);border-radius:6px;border-left:3px solid ${color}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:11px;font-weight:600">${labelMap[p.name] || p.name}</span>
        <span style="font-size:11px">${icon} ${p.running}/${p.expected}</span>
      </div>
      ${startInfo}
    </div>`;
  }).join('');
  if (sumEl) {
    sumEl.innerHTML = data.ok
      ? '<span class="up">✅ 모든 프로세스 정상</span>'
      : `<span class="down">${hasZombie ? '⚠️ 좀비 감지' : '❌ 일부 down'}</span>`;
  }
  if (btn) btn.style.display = hasZombie ? 'block' : 'none';
}

// ─── 홈 핵심 카드 (종목별 톱 + 페르소나 + 자가개선 요약) ──────
function renderHomeCoreCards() {
  const c = STATE.coin.status, s = STATE.stock.status;

  // 종목 톱5 수익/손실 (양봇 합산, 홈 컴팩트 버전)
  const winnersAll = [];
  const losersAll = [];
  ((c?.stock_pnl_ranking?.winners) || []).forEach(w => winnersAll.push({...w, _bot:'coin'}));
  ((s?.stock_pnl_ranking?.winners) || []).forEach(w => winnersAll.push({...w, _bot:'stock'}));
  ((c?.stock_pnl_ranking?.losers) || []).forEach(l => losersAll.push({...l, _bot:'coin'}));
  ((s?.stock_pnl_ranking?.losers) || []).forEach(l => losersAll.push({...l, _bot:'stock'}));
  winnersAll.sort((a,b) => b.total_pnl - a.total_pnl);
  losersAll.sort((a,b) => a.total_pnl - b.total_pnl);

  const renderRow = (r) => {
    const cls = r.total_pnl > 0 ? 'up' : 'down';
    const icon = r._bot === 'coin' ? '🪙' : '📈';
    return `<div onclick="openStockHistoryModal('${r._bot}','${r.stock}')" style="cursor:pointer;display:flex;justify-content:space-between;padding:5px 7px;background:#0d1117;border:1px solid var(--line);border-radius:5px;font-size:10.5px">
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${icon} <b>${(r.stock_name || r.stock).slice(0,12)}</b></span>
      <span class="${cls}" style="font-weight:700;white-space:nowrap;margin-left:4px">${fmtSign(r.total_pnl)}</span>
    </div>`;
  };
  const wBox = document.getElementById('home_winners');
  if (wBox) wBox.innerHTML = winnersAll.length === 0 ? '<div class="empty" style="font-size:10px">데이터 누적 중</div>' :
    winnersAll.slice(0,5).map(renderRow).join('');
  const lBox = document.getElementById('home_losers');
  if (lBox) lBox.innerHTML = losersAll.length === 0 ? '<div class="empty" style="font-size:10px">손실 종목 없음</div>' :
    losersAll.slice(0,5).map(renderRow).join('');

  // 페르소나 (양봇 합산)
  const personas = [];
  ((c?.persona_stats) || []).forEach(p => personas.push({...p, _bot:'coin'}));
  ((s?.persona_stats) || []).forEach(p => personas.push({...p, _bot:'stock'}));
  personas.sort((a,b) => (b.total_pnl||0) - (a.total_pnl||0));
  const pBox = document.getElementById('home_personas');
  if (pBox) {
    pBox.innerHTML = personas.length === 0 ? '<div class="empty">데이터 누적 중</div>' :
      personas.map(p => {
        const meta = PERSONA_META[p.persona] || {icon:'•', cls:'p-default', trait:''};
        const wr = p.winrate || 0;
        const wrCls = wr >= 60 ? 'up' : wr < 40 ? 'down' : '';
        const pnlCls = p.total_pnl > 0 ? 'up' : p.total_pnl < 0 ? 'down' : '';
        const botIcon = p._bot === 'coin' ? '🪙' : '📈';
        return `<div onclick="openPersonaModal('${p._bot}','${p.persona}')" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:#0d1117;border:1px solid var(--line);border-radius:5px;font-size:11px">
          <div style="overflow:hidden">${botIcon} <b>${p.persona}</b> <span style="font-size:9.5px;color:var(--muted)">${meta.trait || ''}</span></div>
          <div style="display:flex;gap:10px;font-variant-numeric:tabular-nums;white-space:nowrap;margin-left:6px">
            <span>${p.trades}건</span>
            <span class="${wrCls}">${wr.toFixed(0)}%</span>
            <span class="${pnlCls}" style="font-weight:700;min-width:70px;text-align:right">${fmtSign(p.total_pnl)}</span>
          </div>
        </div>`;
      }).join('');
  }

  // 자가개선 최근 변경
  const tunes = [];
  ((c?.tune_history) || []).forEach(t => tunes.push({...t, _bot:'🪙'}));
  ((s?.tune_history) || []).forEach(t => tunes.push({...t, _bot:'📈'}));
  tunes.sort((a,b) => (b.created_at || b.ts || '').localeCompare(a.created_at || a.ts || ''));
  const sumEl = document.getElementById('home_tune_summary');
  if (sumEl) sumEl.innerHTML = tunes.length === 0
    ? '<span style="color:var(--muted)">변경 없음</span>'
    : `<span class="info">최근 ${tunes.length}건 자동 조정</span>`;
  const tBox = document.getElementById('home_tune_recent');
  if (tBox) {
    tBox.innerHTML = tunes.length === 0 ? '<div class="empty">자가개선 변경 없음 (자정 자동)</div>' :
      tunes.slice(0, 4).map(t => {
        const ts = (t.created_at || t.ts || '').slice(5, 16).replace('T', ' ');
        return `<div style="display:flex;justify-content:space-between;padding:5px 7px;background:#0d1117;border-left:2px solid var(--info);border-radius:4px;margin-bottom:3px;font-size:10.5px">
          <span>${t._bot} ${ts} <b>${t.param || t.pattern || ''}</b></span>
          <span>${t.old_value} → <span class="info">${t.new_value}</span></span>
        </div>`;
      }).join('');
  }
}

// ─── 종목별 누적 거래 (history 사용, 50건 윈도우 회피) ──────
let _stockHistoryFilter = localStorage.getItem('stockHistoryFilter') || 'all';

function setStockHistoryFilter(f) {
  _stockHistoryFilter = f;
  localStorage.setItem('stockHistoryFilter', f);
  document.querySelectorAll('#stock_history_filter_bar .filter-chip').forEach(el => {
    el.classList.toggle('active', el.dataset.shf === f);
  });
  renderStockHistoryList();
}

function renderStockHistoryList() {
  const c = STATE.coin.status, s = STATE.stock.status;
  const all = [];
  ((c?.stock_pnl_ranking?.all) || []).forEach(x => all.push({...x, _bot: 'coin'}));
  ((s?.stock_pnl_ranking?.all) || []).forEach(x => all.push({...x, _bot: 'stock'}));

  let filtered = all;
  if (_stockHistoryFilter === 'coin') filtered = all.filter(x => x._bot === 'coin');
  else if (_stockHistoryFilter === 'stock') filtered = all.filter(x => x._bot === 'stock');
  else if (_stockHistoryFilter === 'winners') filtered = all.filter(x => x.total_pnl > 0);
  else if (_stockHistoryFilter === 'losers') filtered = all.filter(x => x.total_pnl < 0);

  filtered.sort((a, b) => Math.abs(b.total_pnl) - Math.abs(a.total_pnl));

  const cnt = document.getElementById('stock_history_count');
  if (cnt) cnt.textContent = `${filtered.length}/${all.length} 종목`;

  const box = document.getElementById('stock_history_list');
  if (!box) return;
  if (filtered.length === 0) {
    box.innerHTML = '<div class="empty">데이터 없음</div>';
    return;
  }
  box.innerHTML = filtered.map(s => {
    const cls = s.total_pnl > 0 ? 'up' : s.total_pnl < 0 ? 'down' : '';
    const wrCls = s.winrate >= 60 ? 'up' : s.winrate < 40 ? 'down' : '';
    const icon = s._bot === 'coin' ? '🪙' : '📈';
    const range = s.first_ts ? `${s.first_ts.slice(0,10)} ~ ${s.last_ts.slice(0,10)}` : '';
    return `<div onclick="openStockHistoryModal('${s._bot}','${s.stock}')" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#0d1117;border:1px solid var(--line);border-radius:6px;transition:border-color .15s" onmouseover="this.style.borderColor='var(--info)'" onmouseout="this.style.borderColor='var(--line)'">
      <div style="flex:1;overflow:hidden">
        <div style="font-size:12px"><span style="font-size:11px">${icon}</span> <b>${s.stock_name || s.stock}</b> <span style="color:var(--muted);font-size:9.5px">${s.stock}</span></div>
        <div style="font-size:9.5px;color:var(--muted)">${range}</div>
      </div>
      <div style="display:flex;gap:14px;font-size:11px;font-variant-numeric:tabular-nums;align-items:center">
        <span>${s.trades}건</span>
        <span class="${wrCls}">${s.winrate}%</span>
        <span class="${cls}" style="font-weight:700;min-width:90px;text-align:right">${fmtSign(s.total_pnl)}</span>
      </div>
    </div>`;
  }).join('');
}

// 종목별 전체 거래 모달 (history 기반, 50건 윈도우 회피)
function openStockHistoryModal(bot, stock) {
  const status = STATE[bot]?.status;
  const all = ((status?.stock_pnl_ranking?.all) || []);
  const item = all.find(x => x.stock === stock);
  if (!item) return;
  const trades = item.history || [];

  document.getElementById('stockModalTitle').innerHTML =
    `${bot === 'coin' ? '🪙' : '📈'} ${item.stock_name || stock} <span style="font-size:11px;color:var(--muted)">${stock}</span>`;

  const totalCls = item.total_pnl > 0 ? 'up' : 'down';
  const summary = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">
      <div class="stat" style="padding:8px"><div class="stat-label">거래수</div><div style="font-size:14px;font-weight:700">${item.trades}건</div></div>
      <div class="stat" style="padding:8px"><div class="stat-label">승률</div><div style="font-size:14px;font-weight:700">${item.winrate}%</div></div>
      <div class="stat" style="padding:8px"><div class="stat-label">최고/최악</div><div style="font-size:11px;font-weight:700"><span class="up">${fmtSign(item.best_pnl||0)}</span><br><span class="down">${fmtSign(item.worst_pnl||0)}</span></div></div>
      <div class="stat" style="padding:8px"><div class="stat-label">누적P&L</div><div class="${totalCls}" style="font-size:14px;font-weight:700">${fmtSign(item.total_pnl)}</div></div>
    </div>
  `;

  const tradesHtml = trades.length === 0
    ? '<div class="empty">거래 데이터 없음</div>'
    : '<table style="width:100%;font-size:10.5px"><thead><tr><th>시각</th><th>매매</th><th class="num">수량</th><th class="num">가격</th><th>전략</th><th>사유</th><th class="num">P&L</th></tr></thead><tbody>' +
      trades.map(t => {
        const ts = (t.ts || t.created_at || '').slice(5, 16).replace('T', ' ');
        const cls = (t.pnl || 0) > 0 ? 'up' : (t.pnl || 0) < 0 ? 'down' : '';
        const sideEmoji = (t.side || '').toUpperCase().startsWith('B') ? '🟢' : '🔴';
        const persona = t.persona || t.profile || '';
        const reason = (t.reason || '').slice(0, 14);
        return `<tr><td>${ts}</td><td>${sideEmoji}${t.side}</td><td class="num">${t.amount || '-'}</td><td class="num">${fmt(t.price || 0)}</td><td style="font-size:9.5px">${persona}</td><td style="font-size:9.5px;color:var(--muted)">${reason}</td><td class="num ${cls}">${fmtSign(t.pnl || 0)}</td></tr>`;
      }).join('') + '</tbody></table>';

  document.getElementById('stockModalBody').innerHTML = summary + `<div style="font-size:10px;color:var(--muted);margin-bottom:6px">전체 거래 ${trades.length}건 (DB 누적)</div>` + tradesHtml;
  document.getElementById('stockModal').classList.add('show');
}

// ─── 히스토리 (일별/월별/자가개선 캘린더) ─────────────────
function renderHistoryCards() {
  renderStockHistoryList();
  const c = STATE.coin.status, s = STATE.stock.status;

  // 월별 합산 (코인 + 주식)
  const monthMap = {};
  [c, s].forEach((status, i) => {
    const bot = i === 0 ? 'coin' : 'stock';
    (status?.monthly_history || []).forEach(m => {
      if (!monthMap[m.month]) monthMap[m.month] = {month: m.month, trades: 0, pnl: 0, wins: 0, by_bot: {}};
      monthMap[m.month].trades += m.trades;
      monthMap[m.month].pnl += m.pnl;
      monthMap[m.month].wins += Math.round(m.trades * m.winrate / 100);
      monthMap[m.month].by_bot[bot] = {trades: m.trades, pnl: m.pnl};
    });
  });
  const months = Object.values(monthMap).sort((a,b) => b.month.localeCompare(a.month));
  const monthBox = document.getElementById('history_monthly');
  if (monthBox) {
    monthBox.innerHTML = months.length === 0
      ? '<div class="empty">월별 데이터 없음</div>'
      : '<table style="width:100%"><thead><tr><th style="text-align:left">월</th><th class="num">거래</th><th class="num">승률</th><th class="num">🪙코인</th><th class="num">📈주식</th><th class="num">합계</th></tr></thead><tbody>' +
        months.map(m => {
          const wr = m.trades ? (m.wins / m.trades * 100).toFixed(1) : 0;
          const cls = m.pnl > 0 ? 'up' : m.pnl < 0 ? 'down' : '';
          const cBot = m.by_bot.coin?.pnl || 0;
          const sBot = m.by_bot.stock?.pnl || 0;
          const cCls = cBot > 0 ? 'up' : cBot < 0 ? 'down' : '';
          const sCls = sBot > 0 ? 'up' : sBot < 0 ? 'down' : '';
          return `<tr><td><b>${m.month}</b></td><td class="num">${m.trades}</td><td class="num">${wr}%</td>` +
                 `<td class="num ${cCls}">${fmtSign(cBot)}</td>` +
                 `<td class="num ${sCls}">${fmtSign(sBot)}</td>` +
                 `<td class="num ${cls}" style="font-weight:700">${fmtSign(m.pnl)}</td></tr>`;
        }).join('') + '</tbody></table>';
  }

  // 일별 캘린더 (60일)
  const dayMap = {};
  [c, s].forEach((status, i) => {
    const bot = i === 0 ? 'coin' : 'stock';
    (status?.daily_history || []).forEach(d => {
      if (!dayMap[d.day]) dayMap[d.day] = {day: d.day, trades: 0, pnl: 0, wins: 0, by_bot: {}};
      dayMap[d.day].trades += d.trades;
      dayMap[d.day].pnl += d.pnl;
      dayMap[d.day].wins += Math.round(d.trades * d.winrate / 100);
      dayMap[d.day].by_bot[bot] = d;
    });
  });
  // 자가개선 일자별 묶음
  const tuneByDay = {};
  [c?.tune_history, s?.tune_history].forEach(arr => {
    (arr || []).forEach(t => {
      if (!tuneByDay[t.day]) tuneByDay[t.day] = [];
      tuneByDay[t.day].push(t);
    });
  });

  const days = Object.values(dayMap).sort((a,b) => a.day.localeCompare(b.day));
  const calBox = document.getElementById('history_daily_calendar');
  if (calBox) {
    if (days.length === 0) {
      calBox.innerHTML = '<div class="empty">일별 데이터 없음</div>';
    } else {
      // 최근 60일 그리드 (7열)
      const today = new Date();
      const grid = [];
      for (let i = 59; i >= 0; i--) {
        const d = new Date(today); d.setDate(today.getDate() - i);
        const ymd = d.toISOString().slice(0,10);
        const data = dayMap[ymd];
        const tunes = tuneByDay[ymd] || [];
        grid.push({ymd, dow: d.getDay(), data, tunes});
      }
      const dowLabels = ['일','월','화','수','목','금','토'];
      let html = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;font-size:10px">';
      // 헤더
      html += dowLabels.map(d => `<div style="text-align:center;color:var(--muted);font-size:9px;padding:2px">${d}</div>`).join('');
      // 첫 주 빈칸 채우기
      const firstDow = grid[0].dow;
      for (let i = 0; i < firstDow; i++) html += '<div></div>';
      grid.forEach(g => {
        const day = g.ymd.slice(8);
        if (!g.data) {
          html += `<div style="aspect-ratio:1;background:#0d1117;border:1px solid var(--line);border-radius:4px;padding:4px;font-size:9px;color:var(--muted)">${day}</div>`;
        } else {
          const cls = g.data.pnl > 0 ? 'up' : g.data.pnl < 0 ? 'down' : '';
          const bgColor = g.data.pnl > 0 ? 'rgba(255,82,82,0.15)' : g.data.pnl < 0 ? 'rgba(33,150,243,0.15)' : '#0d1117';
          const tuneIcon = g.tunes.length > 0 ? `<div style="position:absolute;top:1px;right:3px;font-size:9px">🤖</div>` : '';
          html += `<div onclick="openDayModal('${g.ymd}')" style="cursor:pointer;position:relative;aspect-ratio:1;background:${bgColor};border:1px solid var(--line);border-radius:4px;padding:3px;font-size:9px" title="${g.ymd} ${fmtSign(g.data.pnl)} (${g.data.trades}건)">
            ${tuneIcon}<div style="font-weight:700">${day}</div>
            <div class="${cls}" style="font-size:8.5px;font-weight:700">${fmtSign(g.data.pnl)}</div>
            <div style="font-size:8px;color:var(--muted)">${g.data.trades}건</div>
          </div>`;
        }
      });
      html += '</div>';
      html += '<div style="margin-top:8px;font-size:10px;color:var(--muted)">🤖 = 자가개선 변경 있는 날</div>';
      calBox.innerHTML = html;
    }
  }

  // 자가개선 변경 로그 (양봇 합산)
  const tunes = [];
  (c?.tune_history || []).forEach(t => tunes.push({...t, _bot: '🪙'}));
  (s?.tune_history || []).forEach(t => tunes.push({...t, _bot: '📈'}));
  tunes.sort((a,b) => (b.created_at || b.ts || '').localeCompare(a.created_at || a.ts || ''));
  const tuneBox = document.getElementById('history_tune_log');
  if (tuneBox) {
    tuneBox.innerHTML = tunes.length === 0
      ? '<div class="empty">자가개선 변경 기록 없음 (자정 자동 발동)</div>'
      : tunes.slice(0, 30).map(t => {
        const ts = (t.created_at || t.ts || '').slice(0, 16).replace('T', ' ');
        return `<div style="padding:6px 8px;background:#0d1117;border-left:3px solid var(--info);border-radius:4px;margin-bottom:4px">
          <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-bottom:2px">
            <span>${t._bot} ${ts}</span><span>${t.pattern || ''}</span>
          </div>
          <div><b>${t.param || ''}</b>: ${t.old_value} → <span class="info">${t.new_value}</span></div>
          ${t.reason ? `<div style="font-size:10px;color:var(--muted);margin-top:2px">${t.reason}</div>` : ''}
        </div>`;
      }).join('');
  }
}

// 일별 모달 — 거래/복기/개선/토론/후회 모두 한 곳
function openDayModal(ymd) {
  const c = STATE.coin.status, s = STATE.stock.status;
  const cDay = (c?.daily_history || []).find(d => d.day === ymd);
  const sDay = (s?.daily_history || []).find(d => d.day === ymd);
  const cTunes = (c?.tune_history || []).filter(t => t.day === ymd);
  const sTunes = (s?.tune_history || []).filter(t => t.day === ymd);
  const cTrades = (c?.recent_trades || []).filter(t => (t.ts || t.created_at || '').startsWith(ymd));
  const sTrades = (s?.recent_trades || []).filter(t => (t.ts || t.created_at || '').startsWith(ymd));
  const cReviews = (c?.reviews || []).filter(r => (r.created_at || r.reviewed_at || '').startsWith(ymd));
  const sReviews = (s?.reviews || []).filter(r => (r.created_at || r.reviewed_at || '').startsWith(ymd));
  const cCouncils = (c?.council_log || []).filter(r => (r.updated_at || r.ts || '').startsWith(ymd));
  const sCouncils = (s?.council_log || []).filter(r => (r.updated_at || r.ts || '').startsWith(ymd));
  const todayHind = ymd === new Date().toISOString().slice(0,10) ? (c?.hindsight || s?.hindsight || {}) : {};

  document.getElementById('dayModalTitle').textContent = `📅 ${ymd}`;

  // 1. 일자 손익 요약
  let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">';
  [['🪙 코인', cDay], ['📈 주식', sDay]].forEach(([label, d]) => {
    if (!d) {
      html += `<div class="stat" style="padding:8px"><div class="stat-label">${label}</div><div style="color:var(--muted);font-size:11px">거래 없음</div></div>`;
    } else {
      const cls = d.pnl > 0 ? 'up' : d.pnl < 0 ? 'down' : '';
      html += `<div class="stat" style="padding:8px"><div class="stat-label">${label}</div>
        <div class="${cls}" style="font-size:14px;font-weight:700">${fmtSign(d.pnl)}</div>
        <div style="font-size:10px;color:var(--muted)">${d.trades}건 · 승률 ${d.winrate}%</div></div>`;
    }
  });
  html += '</div>';

  // 2. 거래 내역
  const allTrades = [...cTrades.map(t => ({...t, _bot:'🪙'})), ...sTrades.map(t => ({...t, _bot:'📈'}))];
  if (allTrades.length) {
    html += '<details open style="margin-bottom:10px"><summary style="cursor:pointer;font-weight:700;font-size:12px;padding:4px 0">💼 거래 내역 (' + allTrades.length + '건)</summary>';
    html += '<table style="width:100%;font-size:10.5px;margin-top:6px"><thead><tr><th>시각</th><th>심볼</th><th>매매</th><th>전략</th><th>사유</th><th class="num">P&L</th></tr></thead><tbody>' +
      allTrades.map(t => {
        const time = (t.ts || t.created_at || '').slice(11, 16);
        const sym = t.coin || t.stock_name || t.stock || '-';
        const persona = t.persona || t.profile || '';
        const cls = (t.pnl || 0) > 0 ? 'up' : (t.pnl || 0) < 0 ? 'down' : '';
        return `<tr><td>${t._bot} ${time}</td><td>${sym}</td><td>${t.side}</td><td style="font-size:9px">${persona.slice(0,5)}</td><td style="font-size:9px;color:var(--muted)">${(t.reason || '').slice(0, 14)}</td><td class="num ${cls}">${fmtSign(t.pnl || 0)}</td></tr>`;
      }).join('') + '</tbody></table></details>';
  }

  // 3. 자가개선 변경
  const allTunes = [...cTunes.map(t => ({...t, _bot:'🪙'})), ...sTunes.map(t => ({...t, _bot:'📈'}))];
  if (allTunes.length) {
    html += '<details open style="margin-bottom:10px"><summary style="cursor:pointer;font-weight:700;font-size:12px;padding:4px 0">🤖 자가개선 변경 (' + allTunes.length + '건)</summary>';
    html += allTunes.map(t => `<div style="padding:5px 8px;background:#0d1117;border-left:2px solid var(--info);border-radius:4px;margin:3px 0;font-size:11px">
      ${t._bot} <b>${t.param || t.pattern}</b>: ${t.old_value} → <span class="info">${t.new_value}</span>
      ${t.reason ? `<div style="color:var(--muted);font-size:10px">${t.reason}</div>` : ''}</div>`).join('');
    html += '</details>';
  }

  // 4. 자체평가 / 복기
  const allReviews = [...cReviews.map(r => ({...r, _bot:'🪙'})), ...sReviews.map(r => ({...r, _bot:'📈'}))];
  if (allReviews.length) {
    html += '<details style="margin-bottom:10px"><summary style="cursor:pointer;font-weight:700;font-size:12px;padding:4px 0">📝 자체평가/복기 (' + allReviews.length + '건)</summary>';
    html += allReviews.slice(0, 10).map(r => `<div style="padding:5px 8px;background:#0d1117;border-radius:4px;margin:3px 0;font-size:10.5px">
      ${r._bot} <b>${r.stock || ''}</b> <span style="color:var(--muted)">${r.verdict || ''}</span>
      ${r.lesson ? `<div style="font-size:10px;margin-top:2px">💡 ${r.lesson.slice(0,80)}</div>` : ''}</div>`).join('');
    html += '</details>';
  }

  // 5. 위원회 토론
  const allCouncils = [...cCouncils.map(r => ({...r, _bot:'🪙'})), ...sCouncils.map(r => ({...r, _bot:'📈'}))];
  if (allCouncils.length) {
    html += '<details style="margin-bottom:10px"><summary style="cursor:pointer;font-weight:700;font-size:12px;padding:4px 0">📋 위원회 토론 (' + allCouncils.length + '건)</summary>';
    html += allCouncils.map(d => {
      const consensus = d['합의'] || d.consensus || {};
      return `<div style="padding:6px 8px;background:#0d1117;border-radius:4px;margin:3px 0;font-size:10.5px">
        ${d._bot} <b>합의 th=${consensus.threshold || '?'}</b>
        <div style="color:var(--muted);font-size:10px">${(consensus.reason || '').slice(0, 100)}</div></div>`;
    }).join('');
    html += '</details>';
  }

  // 6. 후회분석 (오늘 날짜만)
  if (todayHind && (todayHind.hindsight_conserv || todayHind.hindsight_calib)) {
    const conserv = todayHind.hindsight_conserv;
    const calib = todayHind.hindsight_calib;
    html += '<details style="margin-bottom:10px"><summary style="cursor:pointer;font-weight:700;font-size:12px;padding:4px 0">⚠️ 후회분석 (Qullamaggie WhatIf)</summary>';
    if (conserv) html += `<div style="padding:6px 8px;background:#0d1117;border-radius:4px;font-size:10.5px;margin:3px 0">진단: <b>${conserv.verdict || '-'}</b> · ${(conserv.regret || '').slice(0,80)}</div>`;
    if (calib?.need_calibration) html += `<div style="padding:6px 8px;background:#0d1117;border-radius:4px;font-size:10.5px;margin:3px 0;color:var(--warn)">⚠️ 모멘텀 교정: ${calib.reason}</div>`;
    html += '</details>';
  }

  if (!allTrades.length && !allTunes.length && !allReviews.length && !allCouncils.length) {
    html += '<div class="empty">이 날 데이터 없음</div>';
  }

  document.getElementById('dayModalBody').innerHTML = html;
  document.getElementById('dayModal').classList.add('show');
}

function closeDayModal() { document.getElementById('dayModal').classList.remove('show'); }

// 빈 카드 자동 숨김 헬퍼 — 데이터 없는 카드 .card 부모 hide
function hideIfEmpty(elementId, isEmpty) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const card = el.closest('.card');
  if (!card) return;
  card.style.display = isEmpty ? 'none' : '';
}

// ─── WhatIf 시뮬 렌더 ─────────────────────────────────
function renderWhatIf() {
  const c = STATE.coin.status, s = STATE.stock.status;

  // 양봇 합쳐서 baseline + 시나리오 표시
  const cWi = c?.whatif_simulation || {};
  const sWi = s?.whatif_simulation || {};
  const totalBase = (cWi.baseline_pnl || 0) + (sWi.baseline_pnl || 0);
  const totalN = (cWi.baseline_trades || 0) + (sWi.baseline_trades || 0);

  const baseEl = document.getElementById('whatif_baseline');
  if (baseEl) {
    const cls = totalBase > 0 ? 'up' : totalBase < 0 ? 'down' : '';
    baseEl.innerHTML = `최근 24h 실제: <b class="${cls}">${fmtSign(totalBase)}원</b> (${totalN}건)`;
  }

  // 시나리오들 (양봇 분리 표시)
  const allScenarios = [];
  (cWi.scenarios || []).forEach(x => allScenarios.push({...x, _bot:'🪙'}));
  (sWi.scenarios || []).forEach(x => allScenarios.push({...x, _bot:'📈'}));
  allScenarios.sort((a,b) => b.delta - a.delta);

  const box = document.getElementById('all_whatif');
  if (!box) return;
  hideIfEmpty('all_whatif', allScenarios.length === 0);
  if (allScenarios.length === 0) {
    box.innerHTML = '<div class="empty">최근 24h 거래 0건</div>';
    return;
  }
  box.innerHTML = allScenarios.map(sc => {
    const deltaCls = sc.delta > 0 ? 'up' : sc.delta < 0 ? 'down' : '';
    const sign = sc.delta >= 0 ? '+' : '';
    const recommend = sc.improve
      ? `<span style="background:var(--up);color:#0d1117;padding:2px 6px;border-radius:3px;font-size:9.5px;font-weight:700">✅ 적용 권장</span>`
      : `<span style="color:var(--muted);font-size:9.5px">유지 권장</span>`;
    return `<div style="padding:8px 10px;background:#0d1117;border:1px solid var(--line);border-radius:6px;margin-bottom:5px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
        <div><span style="font-size:10px">${sc._bot}</span> <b>${sc.scenario}</b> ${recommend}</div>
        <div class="${deltaCls}" style="font-weight:700;font-size:12px">${sign}${fmt(sc.delta)}원</div>
      </div>
      <div style="font-size:10px;color:var(--muted)">
        영향 ${sc.affected_trades}건 / 룰 손익 ${fmtSign(sc.rule_pnl)}원 → 시뮬 결과 <b>${fmtSign(sc.simulated_pnl)}원</b>
      </div>
    </div>`;
  }).join('') + (cWi.note ? `<div style="font-size:9.5px;color:var(--muted);margin-top:6px">${cWi.note}</div>` : '');
}

// ─── 자가 메타분석 + 보유시간 렌더 ─────────────────────
function renderMetaDiagnosis() {
  renderWhatIf();
  const c = STATE.coin.status, s = STATE.stock.status;

  // 메타진단 합산
  const allWarn = [], allWin = [], allRec = [];
  [c, s].forEach((status, i) => {
    const bot = i === 0 ? '🪙 코인' : '📈 주식';
    const md = status?.meta_diagnosis || {};
    (md.warnings || []).forEach(w => allWarn.push({...w, _bot: bot}));
    (md.wins || []).forEach(w => allWin.push({...w, _bot: bot}));
    (md.recommendations || []).forEach(w => allRec.push({...w, _bot: bot}));
  });
  const sumEl = document.getElementById('meta_diag_summary');
  if (sumEl) {
    const total = allWarn.length + allRec.length;
    sumEl.innerHTML = total > 0
      ? `<span class="warn">⚠️ ${total}건 개선포인트</span>`
      : '<span class="up">✅ 정상</span>';
  }
  const box = document.getElementById('all_meta_diag');
  if (box) {
    let html = '';
    if (allWin.length) {
      html += '<div style="margin-bottom:8px"><b class="up">🟢 효자 룰 / 스윗스팟</b></div>';
      html += allWin.map(w => `<div style="padding:6px 8px;background:#0d1117;border-left:3px solid var(--up);border-radius:4px;margin-bottom:4px">
        <span style="font-size:10px;color:var(--muted)">${w._bot}</span> <b>${w.title || w.rule || w.type}</b><br><span style="font-size:10.5px">${w.detail || ''}</span></div>`).join('');
    }
    if (allWarn.length) {
      html += '<div style="margin:8px 0 4px"><b class="warn">⚠️ 데드존 (회피 권장)</b></div>';
      html += allWarn.map(w => `<div style="padding:6px 8px;background:#0d1117;border-left:3px solid var(--warn);border-radius:4px;margin-bottom:4px">
        <span style="font-size:10px;color:var(--muted)">${w._bot}</span> <b>${w.title}</b><br><span style="font-size:10.5px">${w.detail}</span></div>`).join('');
    }
    if (allRec.length) {
      html += '<div style="margin:8px 0 4px"><b class="down">🛠 룰 개선 권장</b></div>';
      html += allRec.map(r => `<div style="padding:6px 8px;background:#0d1117;border-left:3px solid var(--down);border-radius:4px;margin-bottom:4px">
        <span style="font-size:10px;color:var(--muted)">${r._bot}</span> <b>${r.rule}</b>: ${r.current}<br><span style="font-size:10.5px;opacity:0.85">${r.action}</span></div>`).join('');
    }
    box.innerHTML = html || '<div class="empty">데이터 누적 중</div>';
  }
  hideIfEmpty('all_meta_diag', allWin.length + allWarn.length + allRec.length === 0);

  // 보유시간 합산
  const ht = [];
  (c?.hold_time_stats || []).forEach(h => ht.push({...h, _bot:'🪙'}));
  (s?.hold_time_stats || []).forEach(h => ht.push({...h, _bot:'📈'}));
  hideIfEmpty('all_hold_time', ht.length === 0);
  const htBox = document.getElementById('all_hold_time');
  if (htBox) {
    if (ht.length === 0) {
      htBox.innerHTML = '<div class="empty">보유시간 데이터 없음 (entry_ts 누적 시 표시)</div>';
    } else {
      // 최대값 기준 막대 그래프
      const maxN = Math.max(...ht.map(h => h.trades));
      htBox.innerHTML = ht.map(h => {
        const cls = h.total_pnl > 0 ? 'up' : h.total_pnl < 0 ? 'down' : '';
        const wrCls = h.winrate >= 80 ? 'up' : h.winrate < 40 ? 'down' : 'warn';
        const barW = (h.trades / maxN * 100).toFixed(1);
        const barColor = h.total_pnl > 0 ? 'var(--up)' : 'var(--down)';
        return `<div style="margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:2px">
            <span>${h._bot} <b>${h.bucket}</b></span>
            <div style="display:flex;gap:12px;font-variant-numeric:tabular-nums">
              <span>${h.trades}건</span>
              <span class="${wrCls}">${h.winrate}%</span>
              <span class="${cls}" style="font-weight:700;min-width:80px;text-align:right">${fmtSign(h.total_pnl)}</span>
            </div>
          </div>
          <div style="background:#0d1117;border-radius:3px;height:6px;overflow:hidden">
            <div style="background:${barColor};opacity:0.6;width:${barW}%;height:100%"></div>
          </div>
        </div>`;
      }).join('');
    }
  }
}

// ─── 종목 랭킹 / 사유 / 시간대 / 매트릭스 렌더 ────────────
function renderAnalyticsCards() {
  renderMetaDiagnosis();
  const c = STATE.coin.status, s = STATE.stock.status;

  // 종목 랭킹 (양봇 합산, 절대값 기준 톱)
  const winnersAll = [];
  (c?.stock_pnl_ranking?.winners || []).forEach(w => winnersAll.push({...w, _bot:'coin'}));
  (s?.stock_pnl_ranking?.winners || []).forEach(w => winnersAll.push({...w, _bot:'stock'}));
  winnersAll.sort((a,b) => b.total_pnl - a.total_pnl);

  const losersAll = [];
  (c?.stock_pnl_ranking?.losers || []).forEach(l => losersAll.push({...l, _bot:'coin'}));
  (s?.stock_pnl_ranking?.losers || []).forEach(l => losersAll.push({...l, _bot:'stock'}));
  losersAll.sort((a,b) => a.total_pnl - b.total_pnl);

  const renderRankRow = (r) => {
    const bot = r._bot;
    const icon = bot === 'coin' ? '🪙' : '📈';
    const cls = r.total_pnl > 0 ? 'up' : 'down';
    return `<div onclick="openStockHistoryModal('${bot}','${r.stock}')" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:#0d1117;border:1px solid var(--line);border-radius:6px;font-size:11px" onmouseover="this.style.borderColor='#484f58'" onmouseout="this.style.borderColor='var(--line)'">
      <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span style="font-size:10px">${icon}</span> <b>${r.stock_name || r.stock}</b> <span style="color:var(--muted);font-size:9.5px">${r.trades}건 ${r.winrate}%</span></div>
      <span class="${cls}" style="font-weight:700;white-space:nowrap;font-size:11px">${fmtSign(r.total_pnl)}</span>
    </div>`;
  };

  const wBox = document.getElementById('all_pnl_winners');
  if (wBox) wBox.innerHTML = winnersAll.length === 0 ? '<div class="empty" style="font-size:10px">데이터 누적 중</div>' :
    winnersAll.slice(0, 6).map(renderRankRow).join('');
  const lBox = document.getElementById('all_pnl_losers');
  if (lBox) lBox.innerHTML = losersAll.length === 0 ? '<div class="empty" style="font-size:10px">데이터 누적 중</div>' :
    losersAll.slice(0, 6).map(renderRankRow).join('');

  // 사유별 (양봇 합산)
  const reasonMap = {};
  [...(c?.reason_stats || []), ...(s?.reason_stats || [])].forEach(r => {
    if (!reasonMap[r.rule_kind]) reasonMap[r.rule_kind] = {trades:0, total_pnl:0, wins:0};
    reasonMap[r.rule_kind].trades += r.trades;
    reasonMap[r.rule_kind].total_pnl += r.total_pnl;
    reasonMap[r.rule_kind].wins += Math.round(r.trades * r.winrate / 100);
  });
  const reasons = Object.entries(reasonMap).map(([k,v]) => ({
    rule_kind: k, ...v,
    winrate: v.trades ? +(v.wins / v.trades * 100).toFixed(1) : 0,
  })).sort((a,b) => b.total_pnl - a.total_pnl);

  const rBox = document.getElementById('all_reason_stats');
  if (rBox) {
    rBox.innerHTML = reasons.length === 0 ? '<div class="empty">SELL 거래 누적 시 표시</div>' :
      reasons.map(r => {
        const meta = REASON_META[r.rule_kind] || {icon:'•', cls:'', desc:''};
        const cls = r.total_pnl > 0 ? 'up' : r.total_pnl < 0 ? 'down' : '';
        const wrCls = r.winrate >= 60 ? 'up' : r.winrate < 40 ? 'down' : '';
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#0d1117;border:1px solid var(--line);border-radius:8px;margin-bottom:4px">
          <div style="flex:1">
            <div style="font-size:12px;font-weight:600">${meta.icon} ${r.rule_kind}</div>
            <div style="font-size:10px;color:var(--muted)">${meta.desc}</div>
          </div>
          <div style="display:flex;gap:14px;font-size:11px;font-variant-numeric:tabular-nums;align-items:center">
            <span>${r.trades}건</span>
            <span class="${wrCls}">${r.winrate}%</span>
            <span class="${cls}" style="font-weight:700;min-width:80px;text-align:right">${fmtSign(r.total_pnl)}</span>
          </div>
        </div>`;
      }).join('');
  }

  // 시간대 (양봇 합산)
  const slotMap = {};
  [...(c?.time_slot_stats || []), ...(s?.time_slot_stats || [])].forEach(r => {
    const k = r.slot;
    if (!slotMap[k]) slotMap[k] = {trades:0, total_pnl:0, wins:0};
    slotMap[k].trades += r.trades;
    slotMap[k].total_pnl += r.total_pnl;
    slotMap[k].wins += Math.round(r.trades * r.winrate / 100);
  });
  const slots = Object.entries(slotMap).map(([k,v]) => ({
    slot: k, ...v,
    winrate: v.trades ? +(v.wins / v.trades * 100).toFixed(1) : 0,
  })).sort((a,b) => b.total_pnl - a.total_pnl);

  const tBox = document.getElementById('all_time_slots');
  if (tBox) {
    tBox.innerHTML = slots.length === 0 ? '<div class="empty">데이터 누적 중</div>' :
      slots.map(sl => {
        const cls = sl.total_pnl > 0 ? 'up' : sl.total_pnl < 0 ? 'down' : '';
        const wrCls = sl.winrate >= 60 ? 'up' : sl.winrate < 40 ? 'down' : '';
        const star = sl === slots[0] && sl.total_pnl > 0 ? ' ⭐' : '';
        return `<div style="display:flex;justify-content:space-between;padding:6px 8px;background:#0d1117;border:1px solid var(--line);border-radius:6px;margin-bottom:3px;font-size:11px">
          <span><b>${sl.slot}</b>${star}</span>
          <div style="display:flex;gap:12px;font-variant-numeric:tabular-nums">
            <span>${sl.trades}건</span>
            <span class="${wrCls}">${sl.winrate}%</span>
            <span class="${cls}" style="font-weight:700;min-width:80px;text-align:right">${fmtSign(sl.total_pnl)}</span>
          </div>
        </div>`;
      }).join('');
  }

  // 페르소나 × 사유 매트릭스 (양봇 합산)
  const matrix = {};
  [c?.persona_reason_matrix, s?.persona_reason_matrix].forEach(m => {
    if (!m) return;
    Object.entries(m).forEach(([persona, rules]) => {
      if (!matrix[persona]) matrix[persona] = {};
      Object.entries(rules).forEach(([rule, v]) => {
        if (!matrix[persona][rule]) matrix[persona][rule] = {trades:0, pnl:0};
        matrix[persona][rule].trades += v.trades;
        matrix[persona][rule].pnl += v.pnl;
      });
    });
  });
  const allRules = [...new Set(Object.values(matrix).flatMap(r => Object.keys(r)))];
  const personas = Object.keys(matrix);
  const mBox = document.getElementById('all_persona_matrix');
  if (mBox) {
    if (personas.length === 0) {
      mBox.innerHTML = '<div class="empty">매트릭스 데이터 누적 중</div>';
    } else {
      let html = '<table style="width:100%;font-size:10.5px;border-collapse:collapse"><thead><tr><th style="text-align:left;padding:4px">페르소나</th>';
      allRules.forEach(r => {
        const meta = REASON_META[r] || {icon:'•'};
        html += `<th style="padding:4px;font-size:10px" title="${r}">${meta.icon} ${r}</th>`;
      });
      html += '</tr></thead><tbody>';
      personas.forEach(p => {
        const meta = PERSONA_META[p] || {icon:'•', cls:'p-default'};
        html += `<tr><td style="padding:4px"><span class="p-badge ${meta.cls}">${meta.icon} ${p}</span></td>`;
        allRules.forEach(r => {
          const v = matrix[p][r];
          if (!v) {
            html += '<td style="padding:4px;text-align:center;color:var(--muted)">-</td>';
          } else {
            const cls = v.pnl > 0 ? 'up' : v.pnl < 0 ? 'down' : '';
            html += `<td class="num ${cls}" style="padding:4px"><div style="font-weight:700">${fmtSign(v.pnl)}</div><div style="font-size:9px;opacity:0.7">${v.trades}건</div></td>`;
          }
        });
        html += '</tr>';
      });
      html += '</tbody></table>';
      mBox.innerHTML = html;
    }
  }
}

// ─── 통합: 페르소나별 성과 / 위원회 / 후회분석 렌더 ─────────
function renderImprovementCards() {
  const c = STATE.coin.status, s = STATE.stock.status;

  // 페르소나별 성과
  const personas = [];
  (c?.persona_stats || []).forEach(p => personas.push({...p, _bot:'coin'}));
  (s?.persona_stats || []).forEach(p => personas.push({...p, _bot:'stock'}));
  const psBox = document.getElementById('all_persona_stats');
  if (psBox) {
    if (personas.length === 0) {
      psBox.innerHTML = '<div class="empty">페르소나 거래 누적 시 표시</div>';
    } else {
      personas.sort((a,b) => (b.total_pnl||0) - (a.total_pnl||0));
      psBox.innerHTML = personas.map(p => {
        const meta = PERSONA_META[p.persona] || {icon:'•', cls:'p-default', trait:''};
        const wr = p.winrate || 0;
        const wrCls = wr >= 60 ? 'up' : wr < 40 ? 'down' : '';
        const pnlCls = p.total_pnl > 0 ? 'up' : p.total_pnl < 0 ? 'down' : '';
        const botIcon = p._bot === 'coin' ? '🪙' : '📈';
        return `<div onclick="openPersonaModal('${p._bot}','${p.persona}')" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#0d1117;border:1px solid var(--line);border-radius:8px;transition:border-color .15s" onmouseover="this.style.borderColor='#484f58'" onmouseout="this.style.borderColor='var(--line)'">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:11px">${botIcon}</span>
            <span class="p-badge ${meta.cls}">${meta.icon} ${p.persona}</span>
            <span style="font-size:10px;color:var(--muted)">${meta.trait || ''}</span>
          </div>
          <div style="display:flex;gap:14px;font-size:11px;font-variant-numeric:tabular-nums">
            <span>${p.trades}건</span>
            <span class="${wrCls}">${wr.toFixed(1)}%</span>
            <span class="${pnlCls}" style="font-weight:700">${fmtSign(p.total_pnl)}</span>
          </div>
        </div>`;
      }).join('');
    }
  }

  hideIfEmpty('all_persona_stats', personas.length === 0);

  // 위원회 토론
  const councils = [];
  (c?.council_log || []).forEach(x => councils.push({...x, _bot:'coin'}));
  (s?.council_log || []).forEach(x => councils.push({...x, _bot:'stock'}));
  const cBox = document.getElementById('all_council_log');
  if (cBox) {
    if (councils.length === 0) {
      cBox.innerHTML = '<div class="empty">아직 토론 기록 없음 (코인 자정 / KR 15:35 / US 05:10 자동 발동)</div>';
    } else {
      hideIfEmpty('all_council_log', false);
      cBox.innerHTML = councils.map(d => {
        const consensus = d['합의'] || d.consensus || {};
        const market = d.market || (d._bot === 'coin' ? '🪙 코인' : '📈 주식');
        const personas = Object.keys(d).filter(k => k !== '합의' && k !== 'market' && k !== '_bot' && k !== 'consensus');
        const personaHtml = personas.slice(0, 4).map(name => {
          const op = d[name] || {};
          return `<div style="padding:4px 0"><span class="p-badge p-default" style="margin-left:0">${name}</span> <b>th=${op.threshold || '?'}</b> ${(op.opinion || '').slice(0, 50)}</div>`;
        }).join('');
        return `<div style="padding:8px;background:#0d1117;border:1px solid var(--line);border-radius:8px;margin-bottom:6px">
          <div style="font-size:10px;color:var(--muted);margin-bottom:4px">${market}</div>
          ${personaHtml}
          <div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--line)"><b>합의:</b> th=${consensus.threshold || '?'} — ${(consensus.reason || '').slice(0, 80)}</div>
        </div>`;
      }).join('');
    }
  }

  // 후회분석
  const hindsight = c?.hindsight || s?.hindsight || {};
  const hBox = document.getElementById('all_hindsight');
  if (hBox) {
    const conserv = hindsight.hindsight_conserv;
    const calib = hindsight.hindsight_calib;
    if (!conserv && !calib) {
      hBox.innerHTML = '<div class="empty">데이터 누적 중 (자정 자동 분석)</div>';
    } else {
      const v = conserv?.verdict || '데이터 부족';
      const vCls = v === '과보수' ? 'down' : v === '균형' ? 'up' : 'warn';
      hBox.innerHTML = `
        <div style="padding:6px 0"><b class="${vCls}">${v}</b> · ${conserv?.regret || ''}</div>
        ${calib?.need_calibration ? `<div class="warn" style="padding:6px 0">⚠️ 모멘텀 교정 필요: ${calib.reason}</div>` : ''}
        ${conserv?.suggestion?.threshold_offset != null ? `<div style="padding:6px 0;color:var(--muted)">제안 임계값 조정: ${conserv.suggestion.threshold_offset > 0 ? '+' : ''}${conserv.suggestion.threshold_offset}</div>` : ''}
      `;
    }
  }
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
        const amount = p.amount != null ? +p.amount : 0;
        const avg = p.entry_price != null ? +p.entry_price : 0;
        const cur = p.current_price != null ? +p.current_price : 0;
        const invested = p.krw_invested != null ? +p.krw_invested : (avg * amount);
        const currentValue = cur > 0 ? cur * amount : invested;
        const pnl = currentValue - invested;
        const pct = p.pnl_pct != null ? +p.pnl_pct : (invested > 0 ? (pnl / invested * 100) : 0);
        const pctCls = pnl > 0 ? 'up' : pnl < 0 ? 'down' : '';
        const sign = pnl >= 0 ? '+' : '';
        return `<tr class="row-coin" onclick="openPosModal('coin','${p.coin}')" style="cursor:pointer"><td><b>${p.coin}</b>${personaBadge(p.persona)}</td>` +
               `<td class="num">${avg > 0 ? fmt(avg) : '-'}</td>` +
               `<td class="num">${amount.toFixed(4)}</td>` +
               `<td class="num">${fmt(invested)}원</td>` +
               `<td class="num ${pctCls}"><b>${fmt(currentValue)}원</b>` +
                 `<div style="font-size:10px;font-weight:600;opacity:0.9">${sign}${fmt(pnl)}원 (${sign}${pct.toFixed(2)}%)</div></td></tr>`;
      }).join('');
    } else {
      posTb.innerHTML = positions.map(p => {
        const cur = p.current_price || 0;
        const avg = +p.avg_price || 0;
        const avgKrw = +(p.avg_price_krw || avg) || 0;
        const amount = +p.amount || 0;
        const fx = +p.fx_rate || 1;
        const isUsd = p.currency === 'USD';
        // 투자금 (KRW 환산 평단 × 수량)
        const invested = avgKrw * amount;
        // 현재금액 (KRW 환산)
        const curKrw = isUsd ? cur * fx : cur;
        const currentValue = curKrw > 0 ? curKrw * amount : invested;
        const pnl = currentValue - invested;
        const pct = avg > 0 && cur > 0 ? ((cur - avg) / avg * 100) : 0;
        const pctCls = pnl > 0 ? 'up' : pnl < 0 ? 'down' : '';
        const sign = pnl >= 0 ? '+' : '';
        const mk = (p.market || 'KR').toUpperCase();
        const rowCls = mk === 'US' ? 'row-us' : 'row-kr';
        const mkBadge = mk === 'US' ? '<span class="badge b-us" style="font-size:9px;padding:1px 5px">US</span>' :
                                       '<span class="badge b-kr" style="font-size:9px;padding:1px 5px">KR</span>';
        const priceUsd = isUsd ? ` <span style="opacity:0.6;font-size:10px">($${avg.toFixed(2)})</span>` : '';
        const noPnl = !(cur > 0);
        return `<tr class="${rowCls}" onclick="openPosModal('stock','${p.stock}')" style="cursor:pointer"><td>${mkBadge} <b>${p.stock_name || p.stock}</b> <span style="color:var(--muted);font-size:9px">${p.stock}</span>${personaBadge(p.profile)}</td>` +
               `<td class="num">${fmt(avgKrw)}${priceUsd}</td>` +
               `<td class="num">${amount}</td>` +
               `<td class="num">${fmt(invested)}원</td>` +
               (noPnl
                 ? `<td class="num">-</td>`
                 : `<td class="num ${pctCls}"><b>${fmt(currentValue)}원</b>` +
                   `<div style="font-size:10px;font-weight:600;opacity:0.9">${sign}${fmt(pnl)}원 (${sign}${pct.toFixed(2)}%)</div></td>`) +
               `</tr>`;
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
  renderAnalyticsCards();
  renderImprovementCards();
  renderHistoryCards();
  renderHomeCoreCards();
  renderBotProcesses();
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
