import { useState, useEffect, Component, createContext, useContext } from 'react';
import * as api from './lib/api';
import { STR, catLabel } from './lib/strings';

// YYYY-MM-DD → "১৪ অক্টোবর ২০২৬" / "14 Oct 2026"
function fmtDate(ds, lang = 'bn') {
  if (!ds || typeof ds !== 'string') return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ds);
  if (!m) return ds;
  const monthsBn = ['জানুয়ারি','ফেব্রুয়ারি','মার্চ','এপ্রিল','মে','জুন','জুলাই','আগস্ট','সেপ্টেম্বর','অক্টোবর','নভেম্বর','ডিসেম্বর'];
  const monthsEn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = parseInt(m[3], 10), mo = parseInt(m[2], 10);
  if (lang === 'bn') {
    const bn = (n) => String(n).replace(/\d/g, (x) => '০১২৩৪৫৬৭৮৯'[x]);
    return `${bn(d)} ${monthsBn[mo - 1]} ${bn(m[1])}`;
  }
  return `${d} ${monthsEn[mo - 1]} ${m[1]}`;
}

/* ================= Language ================= */

const LangCtx = createContext(null);

function LangProvider({ children }) {
  const [lang, setLang] = useState(() => localStorage.getItem('mh_lang') || 'bn');
  const change = (l) => {
    setLang(l);
    localStorage.setItem('mh_lang', l);
  };
  const t = (k, vars) => {
    let s = (STR[lang] && STR[lang][k]) ?? STR.bn[k] ?? k;
    if (vars) for (const key of Object.keys(vars)) s = s.split(`{${key}}`).join(vars[key]);
    return s;
  };
  const fmt = (n) =>
    lang === 'en'
      ? '৳' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
      : api.fmt(n);
  return <LangCtx.Provider value={{ lang, setLang: change, t, fmt }}>{children}</LangCtx.Provider>;
}

function useLang() {
  return useContext(LangCtx);
}

function LangToggle() {
  const { lang, setLang } = useLang();
  return (
    <button className="ghost sm" onClick={() => setLang(lang === 'bn' ? 'en' : 'bn')}>
      🌐 {lang === 'bn' ? 'EN' : 'বাং'}
    </button>
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      return true;
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

const loadSession = () => {
  try { return JSON.parse(localStorage.getItem('mh_session')); }
  catch { return null; }
};

export default function App() {
  const [session, setSession] = useState(loadSession);
  const [checking, setChecking] = useState(!!loadSession());

  useEffect(() => {
    if (!session) return;
    api.dashboard()
      .then(() => setChecking(false))
      .catch(() => {
        localStorage.removeItem('mh_session');
        localStorage.removeItem('mh_token');
        setSession(null);
        setChecking(false);
      });
  }, []);

  const done = (res) => {
    localStorage.setItem('mh_token', res.token);
    localStorage.setItem('mh_session', JSON.stringify(res));
    setSession(res);
  };
  const out = () => {
    api.logout();
    localStorage.removeItem('mh_session');
    localStorage.removeItem('mh_token');
    setSession(null);
  };

  return (
    <LangProvider>
      <SetupNotice />
      {checking ? (
        <div className="wrap"><p className="center"><CheckingText /></p></div>
      ) : !session ? (
        <ErrorBoundary key="auth"><AuthScreen onDone={done} /></ErrorBoundary>
      ) : (
        <ErrorBoundary key={session.token || 's'}>
          {session.user.role === 'admin'
            ? <AdminApp key={session.token} session={session} onLogout={out} />
            : <MemberApp key={session.token} session={session} onLogout={out} />}
        </ErrorBoundary>
      )}
    </LangProvider>
  );
}

function CheckingText() {
  const { t } = useLang();
  return <>{t('loading')}</>;
}

// কোনো render error হলে সাদা blank পেজের বদলে কারণ + রিফ্রেশ বাটন দেখাবে।
class ErrorBoundary extends Component {
  static contextType = LangCtx;
  constructor(p) { super(p); this.state = { err: null, stack: '' }; }
  static getDerivedStateFromError(e) { return { err: e }; }
  componentDidCatch(e, info) {
    console.error(e);
    this.setState({ stack: String((e && e.stack) || '') + '\n---\n' + String((info && info.componentStack) || '') });
  }
  render() {
    const ctx = this.context || {};
    const t = ctx.t || ((k) => k);
    if (this.state.err) {
      return (
        <div className="wrap"><div className="card">
          <h3>{t('crashTitle')}</h3>
          <p className="dim">{String((this.state.err && this.state.err.message) || this.state.err)}</p>
          <button onClick={() => window.location.reload()}>{t('refresh')}</button>
          {this.state.stack && (
            <details><summary className="dim">{t('techDetails')}</summary>
              <pre className="dim" style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {this.state.stack.slice(0, 1500)}
              </pre></details>
          )}
        </div></div>
      );
    }
    return this.props.children;
  }
}

// Firebase config না থাকলে বন্ধুত্বপূর্ণ নোটিশ — app crash করবে না।
function SetupNotice() {
  const { t } = useLang();
  if (api.isConfigured()) return null;
  return <p className="notice">{t('setupNotice')}</p>;
}

/* ================= Dialogs ================= */

function Modal({ children, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function ConfirmDialog({ message, okLabel, onOk, onCancel }) {
  const { t } = useLang();
  return (
    <Modal onClose={onCancel}>
      <p className="dlgmsg">{message}</p>
      <div className="btnrow">
        <button className="no" onClick={onOk}>{okLabel || t('yes')}</button>
        <button className="ghost" onClick={onCancel}>{t('cancel')}</button>
      </div>
    </Modal>
  );
}

function PromptDialog({ message, placeholder, okLabel, onOk, onCancel }) {
  const { t } = useLang();
  const [val, setVal] = useState('');
  const go = () => { if (val) onOk(val); };
  return (
    <Modal onClose={onCancel}>
      <p className="dlgmsg">{message}</p>
      <input type="password" value={val} onChange={(e) => setVal(e.target.value)}
        placeholder={placeholder} autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
      <div className="btnrow">
        <button onClick={go}>{okLabel || t('save')}</button>
        <button className="ghost" onClick={onCancel}>{t('cancel')}</button>
      </div>
    </Modal>
  );
}

/* ================= Auth ================= */

function AuthScreen({ onDone }) {
  const { t } = useLang();
  const [tab, setTab] = useState('login');
  return (
    <div className="wrap">
      <div className="hero">
        <div className="coin">৳</div>
        <h1 className="logo">{t('appName')}</h1>
        <p className="sub">{t('tagline')}</p>
      </div>
      <div className="tabs">
        <button className={tab === 'login' ? 'on' : ''} onClick={() => setTab('login')}>{t('login')}</button>
        <button className={tab === 'signup' ? 'on' : ''} onClick={() => setTab('signup')}>{t('signup')}</button>
      </div>
      {tab === 'login' ? <LoginForm onDone={onDone} /> : <SignupForm onDone={onDone} />}
      <p className="foot">{t('onlineSafe')}</p>
      <p className="center"><LangToggle /></p>
    </div>
  );
}

function LoginForm({ onDone }) {
  const { t } = useLang();
  const [forgot, setForgot] = useState(false);
  const [code, setCode] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try { onDone(await api.login(code, user, pass)); }
    catch (e2) { setErr(e2.message); }
    setBusy(false);
  };
  if (forgot) return <ForgotForm onBack={() => setForgot(false)} />;
  return (
    <form className="card" onSubmit={go}>
      <label>{t('messCode')}<input value={code} onChange={(e) => setCode(e.target.value)}
        placeholder={t('messCodePh')} autoCapitalize="characters" /></label>
      <label>{t('username')}<input value={user} onChange={(e) => setUser(e.target.value)}
        placeholder={t('yourUsername')} /></label>
      <label>{t('password')}<input type="password" value={pass}
        onChange={(e) => setPass(e.target.value)} placeholder="••••••" /></label>
      {err && <p className="err">{err}</p>}
      <button disabled={busy}>{busy ? t('loggingIn') : t('login')}</button>
      <p className="hint">{t('messCodeHint')}</p>
      <p className="hint"><a href="#" onClick={(e) => { e.preventDefault(); setForgot(true); }}>
        {t('forgotPw')}</a> {t('forgotHint')}</p>
    </form>
  );
}

function ForgotForm({ onBack }) {
  const { t } = useLang();
  const [code, setCode] = useState('');
  const [user, setUser] = useState('');
  const [rc, setRc] = useState('');
  const [np, setNp] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault(); setMsg(''); setBusy(true);
    try {
      await api.resetPasswordSelf(code, user, rc, np);
      setMsg(t('pwChangedLogin'));
    } catch (e2) { setMsg(t('errPrefix') + e2.message); }
    setBusy(false);
  };
  return (
    <form className="card" onSubmit={go}>
      <h3>{t('resetPw')}</h3>
      <p className="hint">{t('onlyAdminRecovery')}</p>
      <label>{t('messCode')}<input value={code} onChange={(e) => setCode(e.target.value)}
        autoCapitalize="characters" required /></label>
      <label>{t('username')}<input value={user} onChange={(e) => setUser(e.target.value)} required /></label>
      <label>{t('recoveryCode')}<input value={rc} onChange={(e) => setRc(e.target.value)}
        placeholder={t('recoveryCodePh')} autoCapitalize="characters" required /></label>
      <label>{t('newPassword')}<input type="password" value={np}
        onChange={(e) => setNp(e.target.value)} required /></label>
      <button disabled={busy}>{busy ? t('changing') : t('changePw')}</button>
      {msg && <p className="msg">{msg}</p>}
      <p className="hint"><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>{t('backToLogin')}</a></p>
    </form>
  );
}

function SignupForm({ onDone }) {
  const { t } = useLang();
  const [mess, setMess] = useState('');
  const [name, setName] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const go = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const res = await api.signupAdmin(
        { messName: mess, username: user, password: pass, displayName: name });
      localStorage.setItem('mh_token', res.token);
      const code = await api.getRecoveryCode();
      setPending({ res, code });
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  };
  if (pending) {
    return (
      <div className="card">
        <h3>{t('saveRecovery')}</h3>
        <p className="dim">{t('recoverySaveHint')}</p>
        <p className="bigcode">{pending.code}</p>
        <button onClick={() => onDone(pending.res)}>{t('savedGoIn')}</button>
      </div>
    );
  }
  return (
    <form className="card" onSubmit={go}>
      <label>{t('messName')}<input value={mess} onChange={(e) => setMess(e.target.value)}
        placeholder={t('messNamePh')} /></label>
      <label>{t('yourName')}<input value={name} onChange={(e) => setName(e.target.value)}
        placeholder={t('adminNamePh')} /></label>
      <label>{t('username')}<input value={user} onChange={(e) => setUser(e.target.value)}
        placeholder={t('min3')} /></label>
      <label>{t('password')}<input type="password" value={pass}
        onChange={(e) => setPass(e.target.value)} placeholder={t('min4')} /></label>
      {err && <p className="err">{err}</p>}
      <button disabled={busy}>{busy ? t('creating') : t('createMess')}</button>
      <p className="hint">{t('youWillBeAdmin')}</p>
    </form>
  );
}

/* ================= Shared bits ================= */

function Header({ session, onLogout }) {
  const { t } = useLang();
  return (
    <header className="topbar">
      <div>
        <div className="mtitle">{session.mess.name}</div>
        <div className="mcode">{t('messCodeLabel')} <b>{session.mess.join_code}</b> · {session.user.display_name}</div>
      </div>
      <div className="btnrow">
        <LangToggle />
        <button className="ghost" onClick={onLogout}>{t('logout')}</button>
      </div>
    </header>
  );
}

function BalanceTable({ members, payments }) {
  const { t, fmt } = useLang();
  const fs = api.fundSettlement(members || [], payments || []);
  const balCell = (r) => {
    const d = (fs.debtors || []).find((x) => x.id === r.id);
    if (d) {
      if (d.remaining < 0.5) return <span className="pos">{t('willGive')} {fmt(d.owe)} ({t('paidDone')})</span>;
      return `${t('willGive')} ${fmt(d.remaining)}`;
    }
    const c = (fs.creditors || []).find((x) => x.id === r.id);
    if (c) {
      if (c.remaining < 0.5) return <span className="pos">{t('willGet')} {fmt(c.get)} ({t('paidDone')})</span>;
      return `${t('willGet')} ${fmt(c.remaining)}`;
    }
    return <span className="dim">—</span>;
  };
  const cellClass = (r) => {
    const d = (fs.debtors || []).find((x) => x.id === r.id);
    if (d) return d.remaining < 0.5 ? 'pos' : 'neg';
    const c = (fs.creditors || []).find((x) => x.id === r.id);
    if (c) return 'pos';
    return '';
  };
  return (
    <>
      <div className="stats">
        <div className="stat"><span>{t('totalExpense')}</span><b>{fmt(fs.total)}</b></div>
        <div className="stat"><span>{t('perHead')}</span><b>{fmt(fs.share)}</b></div>
      </div>
      <table className="tbl">
        <thead><tr><th>{t('thName')}</th><th>{t('thPaid')}</th><th>{t('thAdvance')}</th><th>{t('thTotalDep')}</th><th>{t('thBalance')}</th></tr></thead>
        <tbody>
          {fs.rows.map((r, i) => (
            <tr key={r.id || i}>
              <td>{r.display_name}{r.role === 'admin' ? ' 👑' : ''}{r.active === false ? t('inactiveSuffix') : ''}</td>
              <td>{fmt(r.paidOwn != null ? r.paidOwn : r.paid)}</td>
              <td>{fmt(r.advance)}</td>
              <td><b>{fmt(r.contributed)}</b></td>
              <td className={cellClass(r)}>
                {balCell(r)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function buildCopy(monthLabel, fs, t, fmt, lang, expenses, payments, members) {
  const lines = [];
  lines.push(`📊 ${monthLabel}`);
  lines.push(`${t('copyL1')} ${fmt(fs.total)} | ${t('copyL2')} ${fmt(fs.share)} | ${t('copyL3')} ${fmt(fs.fundTotal)}`);
  lines.push('');
  for (const r of fs.rows) {
    // মিটমাটের সাথে মিলিয়ে — remaining দেখাও, net নয়
    const d = (fs.debtors || []).find((x) => x.id === r.id);
    const c = (fs.creditors || []).find((x) => x.id === r.id);
    let st;
    if (d) {
      st = d.remaining < 0.5 ? `${t('willGive')} ${fmt(d.owe)} (${t('paidDone')})` : `${t('willGive')} ${fmt(d.remaining)}`;
    } else if (c) {
      st = c.remaining < 0.5 ? `${t('willGet')} ${fmt(c.get)} (${t('paidDone')})` : `${t('willGet')} ${fmt(c.remaining)}`;
    } else {
      st = fmt(0);
    }
    lines.push(`${r.display_name} — ${st}`);
  }
  // খরচের detail: কে, কবে, কী বাবদ, কত, উৎস
  const expList = (expenses || []).filter((e) => e && e.amount > 0);
  if (expList.length) {
    lines.push('');
    lines.push(t('copyExpDetail') || '🧾 খরচের বিবরণ:');
    const nameOf = (id) => (members || []).find((m) => m.id === id)?.display_name || '?';
    for (const e of expList) {
      const who = e.by || nameOf(e.byId) || '?';
      const when = e.expenseDate ? fmtDate(e.expenseDate, lang) : '';
      const what = catLabel(e.category, lang);
      const src = e.source === 'fund' ? ` (${t('srcFundShort') || 'ফান্ড'})` : '';
      lines.push(`  • ${who}${when ? ` · ${when}` : ''} · ${what}: ${fmt(e.amount)}${src}${e.note ? ` — ${e.note}` : ''}`);
    }
  }
  lines.push('');
  lines.push(t('copySettlement'));
  lines.push(t('fundInTitle') + ':');
  if (!fs.debtors.length) lines.push('  -');
  for (const d of fs.debtors) {
    const st = d.remaining < 0.5 ? t('paidDone') : `${t('dueLeft')} ${fmt(d.remaining)}`;
    lines.push(`  ${d.display_name}: ${fmt(d.owe)} (${st})`);
  }
  lines.push(t('fundOutTitle') + ':');
  if (!fs.creditors.length) lines.push('  -');
  for (const c of fs.creditors) {
    const st = c.remaining < 0.5 ? t('paidDone') : `${t('dueLeft')} ${fmt(c.remaining)}`;
    lines.push(`  ${c.display_name}: ${fmt(c.get)} (${st})`);
  }
  // পেমেন্ট হিস্ট্রি (তারিখসহ)
  const payList = (payments || []).filter((p) => p && p.amount > 0);
  if (payList.length) {
    lines.push('');
    lines.push(t('payHistory') + ':');
    const nameOf = (id) => (members || []).find((m) => m.id === id)?.display_name || '?';
    const sorted = payList.slice().sort((a, b) => String(a.paymentDate || a.at || '').localeCompare(String(b.paymentDate || b.at || '')));
    for (const p of sorted) {
      const when = p.paymentDate ? fmtDate(p.paymentDate, lang) : '';
      const dir = p.kind === 'in' ? `${nameOf(p.memberId)} → ${t('fundTotal').replace(':', '')}` : `${t('fundTotal').replace(':', '')} → ${nameOf(p.memberId)}`;
      lines.push(`  • ${when ? when + ' · ' : ''}${dir}: ${fmt(p.amount)}`);
    }
  }
  return lines.join('\n');
}

// ফান্ড মিটমাট সেকশন: 📥 ফান্ডে জমা দেবে / 📤 ফান্ড থেকে পাবে + পেমেন্ট রেকর্ড + কপি
function SettlementSection({ members, payments, expenses, monthId, monthLabel, admin, onDone }) {
  const { t, fmt, lang } = useLang();
  const [payDlg, setPayDlg] = useState(null);
  const [delPay, setDelPay] = useState(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState('');
  const fs = api.fundSettlement(members || [], payments || []);
  const payList = (payments || []).slice().sort((a, b) => (a.at < b.at ? 1 : -1));
  const nameOf = (id) => (members || []).find((m) => m.id === id)?.display_name || '?';

  const doCopy = async () => {
    const ok = await copyText(buildCopy(monthLabel, fs, t, fmt, lang, expenses, payments, members));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  const delPayment = async () => {
    const p = delPay; setDelPay(null); setErr('');
    try { await api.deletePayment(p.id); onDone && onDone(); }
    catch (e2) { setErr(e2.message); }
  };

  return (
    <div className="card">
      <h3>💰 {t('copySettlement').replace('💰 ', '')}</h3>
      <p className="dim">{t('fundTotal')} <b>{fmt(fs.fundTotal)}</b>{fs.fundSpent > 0.5 && <> · {t('fundSpent')}: <b>{fmt(fs.fundSpent)}</b> · {t('fundBalance')}: <b>{fmt(fs.fundBalance)}</b></>}</p>
      {(fs.dueIn > 0.5 || fs.dueOut > 0.5) && (
        <p className="dim">{t('totalDue')}: <b>{t('dueCollect')} {fmt(fs.dueIn)} · {t('duePayout')} {fmt(fs.dueOut)}</b></p>
      )}
      <p className="hint">{t('fundNote')}</p>
      {err && <p className="err">{err}</p>}

      <h4>{t('fundInTitle')}</h4>
      {!fs.debtors.length && <p className="dim">{t('nothing')}</p>}
      {fs.debtors.map((d) => (
        <div className="row" key={d.id}>
          <div><b>{d.display_name}</b>: {fmt(d.owe)}{' '}
            <small className={d.remaining < 0.5 ? 'pos' : 'neg'}>
              {d.remaining < 0.5 ? t('paidDone') : `${t('dueLeft')}: ${fmt(d.remaining)}`}
            </small></div>
          {admin && d.remaining > 0.5 && (
            <button className="ghost sm" onClick={() => setPayDlg({ memberId: d.id, name: d.display_name, kind: 'in', max: d.remaining, monthId })}>
              {t('markPaid')}
            </button>
          )}
        </div>
      ))}

      <h4>{t('fundOutTitle')}</h4>
      {!fs.creditors.length && <p className="dim">{t('nothing')}</p>}
      {fs.creditors.map((c) => (
        <div className="row" key={c.id}>
          <div><b>{c.display_name}</b>: {fmt(c.get)}{' '}
            <small className={c.remaining < 0.5 ? 'pos' : 'neg'}>
              {c.remaining < 0.5 ? t('paidDone') : `${t('dueLeft')}: ${fmt(c.remaining)}`}
            </small></div>
          {admin && c.remaining > 0.5 && (
            <button className="ghost sm" onClick={() => setPayDlg({ memberId: c.id, name: c.display_name, kind: 'out', max: c.remaining, monthId })}>
              {t('markPaid')}
            </button>
          )}
        </div>
      ))}

      <div className="btnrow" style={{ marginTop: 8 }}>
        <button className="ghost sm" onClick={doCopy}>{copied ? t('copied') : t('copyBtn')}</button>
      </div>

      {payList.length > 0 && (
        <>
          <h4 style={{ marginTop: 12 }}>{t('payHistory')}</h4>
          {payList.map((p) => (
            <div className="row" key={p.id}>
              <div><small>
                {p.paymentDate ? `📅 ${fmtDate(p.paymentDate, lang)} · ` : ''}
                {p.kind === 'in' ? `${nameOf(p.memberId)} → ${t('fundTotal').replace(':', '')}` : `${t('fundTotal').replace(':', '')} → ${nameOf(p.memberId)}`}
                : <b>{fmt(p.amount)}</b>{p.note ? ` — ${p.note}` : ''}
              </small></div>
              {admin && (
                <button className="ghost sm danger" onClick={() => setDelPay(p)}>🗑️</button>
              )}
            </div>
          ))}
        </>
      )}

      {payDlg && (
        <PaymentDialog info={payDlg}
          onClose={() => setPayDlg(null)}
          onDone={() => { setPayDlg(null); onDone && onDone(); }} />
      )}
      {delPay && (
        <ConfirmDialog message={t('payDeleteQ')} okLabel={t('delete')}
          onOk={delPayment} onCancel={() => setDelPay(null)} />
      )}
    </div>
  );
}

function PaymentDialog({ info, onClose, onDone }) {
  const { t, fmt } = useLang();
  const [amount, setAmount] = useState(String(Math.round(info.max)));
  const [note, setNote] = useState('');
  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [confirming, setConfirming] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault(); setMsg('');
    if (!payDate) { setMsg(t('errPrefix') + t('expDateReq')); return; }
    const amt = Number(amount) || 0;
    // Client-side overpayment guard — সার্ভারেও আছে
    if (amt > info.max + 0.5) {
      setMsg(t('errPrefix') + t('payOverMax', { max: fmt(Math.round(info.max)) }));
      return;
    }
    if (!confirming) { setConfirming(true); return; }
    setBusy(true);
    try {
      await api.recordPayment(info.monthId, info.memberId, info.kind, Number(amount), note, payDate);
      onDone();
    } catch (e2) { setMsg(t('errPrefix') + e2.message); }
    setBusy(false);
  };
  return (
    <Modal onClose={onClose}>
      <form onSubmit={go}>
        <h3>{t('payDialogTitle')}</h3>
        <p className="dim">{t(info.kind === 'in' ? 'payInLabel' : 'payOutLabel', { name: info.name })}</p>
        <label>{t('payAmount')}<input type="number" min="1" step="any" value={amount}
          onChange={(e) => { setAmount(e.target.value); setConfirming(false); }} required /></label>
        <label>{t('payDateLabel')}<input type="date" value={payDate}
          onChange={(e) => { setPayDate(e.target.value); setConfirming(false); }} required /></label>
        <label><input value={note} onChange={(e) => setNote(e.target.value)}
          placeholder={t('payNotePh')} /></label>
        {confirming && (
          <p className="confirmbox">⚠️ {t('payConfirmMsg', { amount: fmt(Number(amount) || 0) })}</p>
        )}
        {msg && <p className="err">{msg}</p>}
        <div className="btnrow">
          <button disabled={busy}>{busy ? t('saving') : confirming ? t('payYes') : t('paySave')}</button>
          {confirming
            ? <button type="button" className="ghost" onClick={() => setConfirming(false)}>{t('payNo')}</button>
            : <button type="button" className="ghost" onClick={onClose}>{t('cancel')}</button>}
        </div>
      </form>
    </Modal>
  );
}

function CategoryBreakdown({ items }) {
  const { t, lang, fmt } = useLang();
  if (!items || !items.length) return null;
  return (
    <div className="card">
      <h3>{t('catBreakdown')}</h3>
      {items.map((c) => (
        <p key={c.category} className="settle">{catLabel(c.category, lang)}: <b>{fmt(c.total)}</b></p>
      ))}
    </div>
  );
}

function History({ reloadKey, admin }) {
  const { t, lang, fmt } = useLang();
  const [hist, setHist] = useState(null);
  const [open, setOpen] = useState(null);
  const [rk, setRk] = useState(0);
  useEffect(() => {
    api.monthHistory().then(setHist).catch(() => setHist([]));
  }, [reloadKey, rk]);
  if (hist === null) return <p className="center">{t('loading')}</p>;
  if (!hist.length) return <p className="center dim">{t('noClosedYet')}</p>;
  const label = (h) => api.periodDisplay(h, lang);
  return hist.map((h, i) => (
    <div className="card" key={h.id || i}>
      <h3>{label(h)}</h3>
      <p className="dim">{t('fundTotal')} <b>{fmt(h.total_advance)}</b></p>
      <BalanceTable members={h.members || []} payments={h.payments || []} />
      <SettlementSection members={h.members || []} payments={h.payments || []} expenses={h.expenses || []}
        monthId={h.id} monthLabel={label(h)} admin={admin}
        onDone={() => setRk((r) => r + 1)} />
      <CategoryBreakdown items={h.byCategory} />
      {admin && (
        <button className="ghost sm" onClick={() => setOpen(open === h.id ? null : h.id)}>
          {open === h.id ? t('hideRecords') : t('viewRecords')}
        </button>
      )}
      {admin && open === h.id && (
        <HistoryDetail monthId={h.id} onChanged={() => setRk((r) => r + 1)} />
      )}
    </div>
  ));
}

// বন্ধ পিরিয়ডের raw রেকর্ড — ভুল ঠিক করার জন্য (শুধু অ্যাডমিন)
function HistoryDetail({ monthId, onChanged }) {
  const { t } = useLang();
  const [rec, setRec] = useState(null);
  const load = () => api.monthRecords(monthId).then(setRec).catch(() => setRec({ expenses: [], advances: [] }));
  useEffect(() => { load(); }, [monthId]);
  if (!rec) return <p className="dim">{t('loading')}</p>;
  const done = () => { load(); onChanged && onChanged(); };
  return (<>
    <h4>{t('expensesTitle')}</h4>
    <ExpenseList items={rec.expenses} admin onDone={done} />
    <h4>{t('advancesTitle')}</h4>
    <AdvanceList items={rec.advances} onDone={done} />
  </>);
}

function ExpenseForm({ members, onDone }) {
  const { t } = useLang();
  const [mode, setMode] = useState('single');
  return (<>
    <div className="tabs sm">
      <button className={mode === 'single' ? 'on' : ''} onClick={() => setMode('single')}>{t('modeSingle')}</button>
      <button className={mode === 'split' ? 'on' : ''} onClick={() => setMode('split')}>{t('modeSplit')}</button>
    </div>
    {mode === 'single'
      ? <SingleExpenseForm onDone={onDone} />
      : <SplitExpenseForm members={members} onDone={onDone} />}
  </>);
}

function SingleExpenseForm({ onDone }) {
  const { t, lang } = useLang();
  const [amount, setAmount] = useState('');
  const [cat, setCat] = useState(api.CATEGORIES[0]);
  const [note, setNote] = useState('');
  const [expDate, setExpDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState('own');
  const [msg, setMsg] = useState('');
  const go = async (e) => {
    e.preventDefault(); setMsg('');
    if (!expDate) { setMsg(t('errPrefix') + t('expDateReq')); return; }
    try {
      await api.submitExpense(Number(amount), cat, note, { source, expenseDate: expDate });
      setAmount(''); setNote('');
      setExpDate(new Date().toISOString().slice(0, 10));
      setSource('own');
      setMsg(t('sent'));
      onDone && onDone();
    } catch (e2) { setMsg(t('errPrefix') + e2.message); }
  };
  return (
    <form className="card" onSubmit={go}>
      <h3>{t('addExpense')}</h3>
      <label>{t('amount')}<input type="number" min="1" step="any" value={amount}
        onChange={(e) => setAmount(e.target.value)} placeholder={t('amountPh')} required /></label>
      <label>{t('expDateLabel')}<input type="date" value={expDate}
        onChange={(e) => setExpDate(e.target.value)} required /></label>
      <label>{t('srcLabel')}
        <div className="tabs sm">
          <button type="button" className={source === 'own' ? 'on' : ''} onClick={() => setSource('own')}
            title={t('srcOwnHint')}>{t('srcOwn')}</button>
          <button type="button" className={source === 'fund' ? 'on' : ''} onClick={() => setSource('fund')}
            title={t('srcFundHint')}>{t('srcFund')}</button>
        </div></label>
      <label>{t('category')}
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          {api.CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c, lang)}</option>)}
        </select></label>
      <label>{t('noteOpt')}<input value={note} onChange={(e) => setNote(e.target.value)}
        placeholder={t('notePh')} /></label>
      <button>{t('send')}</button>
      {msg && <p className="msg">{msg}</p>}
    </form>
  );
}

function SplitExpenseForm({ members, onDone }) {
  const { t, lang } = useLang();
  const actives = (members || []).filter((m) => m.active !== false);
  const [amount, setAmount] = useState('');
  const [cat, setCat] = useState(api.CATEGORIES[0]);
  const [note, setNote] = useState('');
  const [expDate, setExpDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState('own');
  const [sel, setSel] = useState({});
  const [shares, setShares] = useState({});
  const [msg, setMsg] = useState('');
  const toggle = (id) => setSel((s) => ({ ...s, [id]: !s[id] }));
  const ids = actives.filter((m) => sel[m.id]).map((m) => m.id);
  const equalSplit = () => {
    const total = Number(amount);
    if (!ids.length || !(total > 0)) return;
    const base = Math.floor(total / ids.length);
    let rem = Math.round(total - base * ids.length);
    const sh = {};
    ids.forEach((id) => { sh[id] = String(base + (rem-- > 0 ? 1 : 0)); });
    setShares(sh);
  };
  const sumShares = ids.reduce((s, id) => s + Number(shares[id] || 0), 0);
  const go = async (e) => {
    e.preventDefault(); setMsg('');
    if (!expDate) { setMsg(t('expDateReq')); return; }
    if (ids.length < 2) { setMsg(t('splitNeed2')); return; }
    if (Math.abs(sumShares - Number(amount)) > 0.01) { setMsg(t('splitSumMismatch')); return; }
    try {
      await api.submitSplitExpense({
        amount: Number(amount),
        category: cat,
        note,
        source,
        expenseDate: expDate,
        splits: ids.map((id) => ({ memberId: id, amount: Number(shares[id]) })),
      });
      setAmount(''); setNote(''); setSel({}); setShares({});
      setExpDate(new Date().toISOString().slice(0, 10));
      setSource('own');
      setMsg(t('sent'));
      onDone && onDone();
    } catch (e2) { setMsg(t('errPrefix') + e2.message); }
  };
  return (
    <form className="card" onSubmit={go}>
      <h3>{t('addExpense')} — {t('modeSplit')}</h3>
      <label>{t('amount')}<input type="number" min="1" step="any" value={amount}
        onChange={(e) => setAmount(e.target.value)} placeholder={t('amountPh')} required /></label>
      <label>{t('expDateLabel')}<input type="date" value={expDate}
        onChange={(e) => setExpDate(e.target.value)} required /></label>
      <label>{t('srcLabel')}
        <div className="tabs sm">
          <button type="button" className={source === 'own' ? 'on' : ''} onClick={() => setSource('own')}>{t('srcOwn')}</button>
          <button type="button" className={source === 'fund' ? 'on' : ''} onClick={() => setSource('fund')}>{t('srcFund')}</button>
        </div></label>
      <label>{t('category')}
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          {api.CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c, lang)}</option>)}
        </select></label>
      <label>{t('noteOpt')}<input value={note} onChange={(e) => setNote(e.target.value)}
        placeholder={t('notePh')} /></label>
      <p className="dim">{t('splitSelect')}</p>
      <div className="list">
        {actives.map((m) => (
          <div className="row" key={m.id}>
            <label className="checkrow">
              <input type="checkbox" checked={!!sel[m.id]} onChange={() => toggle(m.id)} />
              <b>{m.display_name}</b>
            </label>
            {sel[m.id] && (
              <input type="number" min="1" step="any" className="shareshort"
                value={shares[m.id] || ''} onChange={(e) => setShares({ ...shares, [m.id]: e.target.value })}
                placeholder={t('amount')} />
            )}
          </div>
        ))}
      </div>
      <div className="btnrow">
        <button type="button" className="ghost" onClick={equalSplit}>{t('equalSplit')}</button>
        <span className="dim">{t('amount')}: {sumShares}/{amount || 0}</span>
      </div>
      <button>{t('send')}</button>
      {msg && <p className="msg">{msg}</p>}
    </form>
  );
}

/* ================= Admin ================= */

function ExpenseEditDialog({ expense, onClose, onDone }) {
  const { t, lang } = useLang();
  const [amount, setAmount] = useState(String(expense.amount ?? ''));
  const [cat, setCat] = useState(expense.category || api.CATEGORIES[0]);
  const [note, setNote] = useState(expense.note || '');
  const [expDate, setExpDate] = useState(expense.expenseDate || new Date().toISOString().slice(0, 10));
  const [source, setSource] = useState(expense.source === 'fund' ? 'fund' : 'own');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault(); setMsg(''); setBusy(true);
    try {
      await api.updateExpense(expense.id, { amount: Number(amount), category: cat, note, source, expenseDate: expDate });
      onDone();
    } catch (e2) { setMsg(t('errPrefix') + e2.message); }
    setBusy(false);
  };
  return (
    <Modal onClose={onClose}>
      <form onSubmit={go}>
        <h3>{t('editExpense')}</h3>
        <label>{t('amount')}<input type="number" min="1" step="any" value={amount}
          onChange={(e) => setAmount(e.target.value)} required /></label>
        <label>{t('expDateLabel')}<input type="date" value={expDate}
          onChange={(e) => setExpDate(e.target.value)} required /></label>
        <label>{t('srcLabel')}
          <div className="tabs sm">
            <button type="button" className={source === 'own' ? 'on' : ''} onClick={() => setSource('own')}>{t('srcOwn')}</button>
            <button type="button" className={source === 'fund' ? 'on' : ''} onClick={() => setSource('fund')}>{t('srcFund')}</button>
          </div></label>
        <label>{t('category')}
          <select value={cat} onChange={(e) => setCat(e.target.value)}>
            {api.CATEGORIES.map((c) => <option key={c} value={c}>{catLabel(c, lang)}</option>)}
          </select></label>
        <label>{t('noteOpt')}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {msg && <p className="err">{msg}</p>}
        <div className="btnrow">
          <button disabled={busy}>{busy ? t('saving') : t('save')}</button>
          <button type="button" className="ghost" onClick={onClose}>{t('cancel')}</button>
        </div>
      </form>
    </Modal>
  );
}

function AdvanceEditDialog({ advance, onClose, onDone }) {
  const { t } = useLang();
  const [amount, setAmount] = useState(String(advance.amount ?? ''));
  const [note, setNote] = useState(advance.note || '');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault(); setMsg(''); setBusy(true);
    try {
      await api.updateAdvance(advance.id, { amount: Number(amount), note });
      onDone();
    } catch (e2) { setMsg(t('errPrefix') + e2.message); }
    setBusy(false);
  };
  return (
    <Modal onClose={onClose}>
      <form onSubmit={go}>
        <h3>{t('editAdvance')} ({advance.memberName})</h3>
        <label>{t('amount')}<input type="number" min="1" step="any" value={amount}
          onChange={(e) => setAmount(e.target.value)} required /></label>
        <label>{t('noteOpt')}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {msg && <p className="err">{msg}</p>}
        <div className="btnrow">
          <button disabled={busy}>{busy ? t('saving') : t('save')}</button>
          <button type="button" className="ghost" onClick={onClose}>{t('cancel')}</button>
        </div>
      </form>
    </Modal>
  );
}

function AdminApp({ session, onLogout }) {
  const { t, lang } = useLang();
  const [tab, setTab] = useState('dash');
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setFailed(false);
    api.dashboard().then(setData).catch(() => setFailed(true));
  }, [reload]);
  const refresh = () => { setFailed(false); setReload((r) => r + 1); };
  const periodLabel = data ? api.periodDisplay(data.month, lang) : '';

  return (
    <div className="wrap">
      <Header session={session} onLogout={onLogout} />
      <div className="tabs">
        {[['dash', t('tabDash')], ['add', t('tabAdd')], ['pending', t('tabPending')], ['members', t('tabMembers')],
          ['adv', t('tabAdv')], ['month', t('tabPeriod')]].map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {failed
        ? <div className="card"><h3>{t('dataFail')}</h3>
            <p className="dim">{t('checkNet')}</p>
            <div className="btnrow">
              <button onClick={refresh}>{t('retry')}</button>
              <button className="ghost" onClick={onLogout}>{t('goLogin')}</button>
            </div></div>
        : !data ? <p className="center">{t('loading')}</p> : <>
        {tab === 'dash' && <>
          <h2>{periodLabel}</h2>
          <BalanceTable members={data.members} payments={data.payments || []} />
          <SettlementSection members={data.members} payments={data.payments || []} expenses={data.approvedExpenses || []}
            monthId={data.month.id} monthLabel={periodLabel} admin onDone={refresh} />
          <CategoryBreakdown items={data.byCategory} />
        </>}
        {tab === 'add' && <>
          <ExpenseForm members={data.members} onDone={refresh} />
          <h3>{t('recentExpense')}</h3>
          <ExpenseList items={data.recent} admin onDone={refresh} />
        </>}
        {tab === 'pending' && <PendingList items={data.pending} onDone={refresh} />}
        {tab === 'members' && <MemberManager session={session} onDone={refresh} />}
        {tab === 'adv' && <>
          <AdvanceForm members={data.members} onDone={refresh} />
          <h3>{t('thisPeriodAdvance')}</h3>
          <AdvanceList items={data.advances} onDone={refresh} />
        </>}
        {tab === 'month' && <MonthManager month={data.month} onDone={refresh} reloadKey={reload} />}
      </>}
    </div>
  );
}

function ExpenseList({ items, admin, onDone }) {
  const { t, lang, fmt } = useLang();
  const [editing, setEditing] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [err, setErr] = useState('');
  if (!items || !items.length) return <p className="dim">{t('nothing')}</p>;
  const del = async () => {
    const e = confirmDel; setConfirmDel(null); setErr('');
    try { await api.deleteExpense(e.id); onDone && onDone(); }
    catch (e2) { setErr(e2.message); }
  };
  const stLabel = (s) => s === 'approved' ? t('stApproved') : s === 'rejected' ? t('stRejected') : t('stPending');
  return (
    <div className="list">
      {err && <p className="err">{err}</p>}
      {items.map((e) => (
        <div className="row" key={e.id}>
          <div><b>{fmt(e.amount)}</b> · {catLabel(e.category, lang)}
            {e.source === 'fund' && <span className="badge fundsrc" title={t('srcFundHint')}>{t('srcFund')}</span>}<br />
            <small>{e.by}{e.expenseDate ? ` · 📅 ${fmtDate(e.expenseDate, lang)}` : ''}{e.note ? ` — ${e.note}` : ''}</small></div>
          <div className="btnrow">
            <span className={`badge ${e.status}`}>{stLabel(e.status)}</span>
            {admin && <>
              <button className="ghost sm" onClick={() => setEditing(e)}>✏️</button>
              <button className="ghost sm danger" onClick={() => setConfirmDel(e)}>🗑️</button>
            </>}
          </div>
        </div>
      ))}
      {editing && <ExpenseEditDialog expense={editing}
        onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); onDone && onDone(); }} />}
      {confirmDel && (
        <ConfirmDialog message={t('deleteQ', { item: `${fmt(confirmDel.amount)} · ${catLabel(confirmDel.category, lang)}` })}
          okLabel={t('delete')} onOk={del} onCancel={() => setConfirmDel(null)} />
      )}
    </div>
  );
}

function AdvanceList({ items, onDone }) {
  const { t, fmt } = useLang();
  const [editing, setEditing] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [err, setErr] = useState('');
  if (!items || !items.length) return <p className="dim">{t('noAdvance')}</p>;
  const del = async () => {
    const a = confirmDel; setConfirmDel(null); setErr('');
    try { await api.deleteAdvance(a.id); onDone && onDone(); }
    catch (e2) { setErr(e2.message); }
  };
  return (
    <div className="list">
      {err && <p className="err">{err}</p>}
      {items.map((a) => (
        <div className="row" key={a.id}>
          <div><b>{fmt(a.amount)}</b> · {a.memberName}<br />
            <small>{a.note || t('noNote')}</small></div>
          <div className="btnrow">
            <button className="ghost sm" onClick={() => setEditing(a)}>✏️</button>
            <button className="ghost sm danger" onClick={() => setConfirmDel(a)}>🗑️</button>
          </div>
        </div>
      ))}
      {editing && <AdvanceEditDialog advance={editing}
        onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); onDone && onDone(); }} />}
      {confirmDel && (
        <ConfirmDialog message={t('qDeleteAdvance', { name: confirmDel.memberName, amount: fmt(confirmDel.amount) })}
          okLabel={t('delete')} onOk={del} onCancel={() => setConfirmDel(null)} />
      )}
    </div>
  );
}

function PendingList({ items, onDone }) {
  const { t, lang, fmt } = useLang();
  const [note, setNote] = useState({});
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  if (!items || !items.length) return <p className="center dim">{t('noPending')}</p>;
  const act = async (id, ok) => {
    setErr('');
    try { await api.reviewExpense(id, ok, note[id] || ''); onDone(); }
    catch (e) { setErr(e.message); }
  };
  const del = async () => {
    const e = confirmDel; setConfirmDel(null); setErr('');
    try { await api.deleteExpense(e.id); onDone(); }
    catch (e2) { setErr(e2.message); }
  };
  return (
    <div className="list">
      {err && <p className="err">{err}</p>}
      {items.map((e) => (
        <div className="card" key={e.id}>
          <p><b>{fmt(e.amount)}</b> · {catLabel(e.category, lang)} — {e.by}
            {e.source === 'fund' && <span className="badge fundsrc">{t('srcFund')}</span>}<br />
            <small>{e.expenseDate ? `📅 ${fmtDate(e.expenseDate, lang)} · ` : ''}{e.note || t('noNote')}</small></p>
          <input placeholder={t('noteOpt')} value={note[e.id] || ''}
            onChange={(ev) => setNote({ ...note, [e.id]: ev.target.value })} />
          <div className="btnrow">
            <button className="ok" onClick={() => act(e.id, true)}>{t('approve')}</button>
            <button className="no" onClick={() => act(e.id, false)}>{t('cancel')}</button>
            <button className="ghost sm" onClick={() => setEditing(e)}>{t('editFix')}</button>
            <button className="ghost sm danger" onClick={() => setConfirmDel(e)}>🗑️</button>
          </div>
        </div>
      ))}
      {editing && <ExpenseEditDialog expense={editing}
        onClose={() => setEditing(null)}
        onDone={() => { setEditing(null); onDone(); }} />}
      {confirmDel && (
        <ConfirmDialog message={t('deleteQ', { item: `${fmt(confirmDel.amount)} · ${catLabel(confirmDel.category, lang)}` })}
          okLabel={t('delete')} onOk={del} onCancel={() => setConfirmDel(null)} />
      )}
    </div>
  );
}

function MemberManager({ session, onDone }) {
  const { t } = useLang();
  const [list, setList] = useState([]);
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [n, setN] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [confirmActive, setConfirmActive] = useState(null);
  const [confirmRole, setConfirmRole] = useState(null);
  const [promptPw, setPromptPw] = useState(null);
  const load = () => api.members().then(setList).catch(() => {});
  useEffect(() => { load(); }, []);
  const add = async (e) => {
    e.preventDefault(); setMsg(''); setErr('');
    try { await api.addMember(u, p, n); setU(''); setP(''); setN(''); load(); onDone(); setMsg(t('memberAdded')); }
    catch (e2) { setMsg(t('errPrefix') + e2.message); }
  };
  const toggleActive = async () => {
    const m = confirmActive; setConfirmActive(null); setErr('');
    try { await api.setMemberActive(m.id, !m.active); load(); onDone(); }
    catch (e2) { setErr(e2.message); }
  };
  const doRole = async () => {
    const { m, role } = confirmRole; setConfirmRole(null); setErr('');
    try {
      const r = await api.setMemberRole(m.id, role);
      if (r.selfDemoted) {
        const s = JSON.parse(localStorage.getItem('mh_session'));
        s.user.role = 'member';
        localStorage.setItem('mh_session', JSON.stringify(s));
        window.location.reload();
        return;
      }
      load(); onDone();
      setMsg(t(role === 'admin' ? 'nowAdmin' : 'nowMember', { name: m.display_name }));
    } catch (e2) { setErr(e2.message); }
  };
  const reset = async (np) => {
    const m = promptPw; setPromptPw(null); setErr('');
    try { await api.resetMemberPassword(m.id, np); setMsg(t('pwChanged')); }
    catch (e2) { setErr(e2.message); }
  };
  const isSelf = (m) => m.id === session.user.id;
  return (<>
    <form className="card" onSubmit={add}>
      <h3>{t('newMember')}</h3>
      <label>{t('thName')}<input value={n} onChange={(e) => setN(e.target.value)} required placeholder={t('memberNamePh')} /></label>
      <label>{t('username')}<input value={u} onChange={(e) => setU(e.target.value)} required placeholder={t('forLoginPh')} /></label>
      <label>{t('password')}<input value={p} onChange={(e) => setP(e.target.value)} required placeholder={t('tellMemberPh')} /></label>
      <button>{t('add')}</button>
      {msg && <p className="msg">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </form>
    <div className="list">
      {list.map((m) => (
        <div className="row" key={m.id}>
          <div><b>{m.display_name}</b>
            {m.role === 'admin' && ' 👑'}
            {m.active === false && <span className="badge">{t('inactiveBadge')}</span>}
            {isSelf(m) && <small>{t('youSuffix')}</small>}<br />
            <small>{m.username} · {m.role === 'admin' ? t('admin') : t('member')}</small></div>
          <div className="btnrow">
            {!isSelf(m) && m.role === 'member' && m.active !== false && (
              <button className="ghost sm" onClick={() => setConfirmRole({ m, role: 'admin' })}>{t('makeAdmin')}</button>
            )}
            {!isSelf(m) && m.role === 'admin' && (
              <button className="ghost sm" onClick={() => setConfirmRole({ m, role: 'member' })}>{t('makeMember')}</button>
            )}
            {isSelf(m) && m.role === 'admin' && (
              <button className="ghost sm" onClick={() => setConfirmRole({ m, role: 'member' })}>{t('leaveRole')}</button>
            )}
            {!isSelf(m) && (
              <>
                <button className="ghost sm" onClick={() => setPromptPw(m)}>{t('pwBtn')}</button>
                {m.active === false
                  ? <button className="ghost sm" onClick={() => setConfirmActive(m)}>{t('activate')}</button>
                  : <button className="ghost sm danger" onClick={() => setConfirmActive(m)}>{t('deactivate')}</button>}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
    {confirmActive && (
      <ConfirmDialog message={t(confirmActive.active === false ? 'qActivate' : 'qDeactivate', { name: confirmActive.display_name })}
        okLabel={confirmActive.active === false ? t('activate') : t('deactivate')}
        onOk={toggleActive} onCancel={() => setConfirmActive(null)} />
    )}
    {confirmRole && (
      <ConfirmDialog message={confirmRole.role === 'admin'
        ? t('qMakeAdmin', { name: confirmRole.m.display_name })
        : isSelf(confirmRole.m)
          ? t('qLeaveRole')
          : t('qDemote', { name: confirmRole.m.display_name })}
        okLabel={confirmRole.role === 'admin' ? t('makeAdmin') : t('makeMember')}
        onOk={doRole} onCancel={() => setConfirmRole(null)} />
    )}
    {promptPw && (
      <PromptDialog message={t('newPwFor', { name: promptPw.display_name })}
        placeholder={t('newPwPh')} okLabel={t('changeTo')}
        onOk={reset} onCancel={() => setPromptPw(null)} />
    )}
  </>);
}

function AdvanceForm({ members, onDone }) {
  const { t } = useLang();
  const actives = (members || []).filter((m) => m.active !== false);
  const [mid, setMid] = useState(actives[0]?.id || '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const go = async (e) => {
    e.preventDefault(); setMsg('');
    try {
      await api.recordAdvance(mid, Number(amount), note);
      setAmount(''); setNote(''); onDone(); setMsg(t('advanceRecorded'));
    } catch (e2) { setMsg(t('errPrefix') + e2.message); }
  };
  return (
    <form className="card" onSubmit={go}>
      <h3>{t('takeAdvance')}</h3>
      <label>{t('memberLabel')}
        <select value={mid} onChange={(e) => setMid(e.target.value)}>
          {actives.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
        </select></label>
      <label>{t('amount')}<input type="number" min="1" step="any" value={amount}
        onChange={(e) => setAmount(e.target.value)} required placeholder={t('amountPh')} /></label>
      <label>{t('noteOpt')}<input value={note} onChange={(e) => setNote(e.target.value)}
        placeholder={t('notePh')} /></label>
      <button>{t('record')}</button>
      {msg && <p className="msg">{msg}</p>}
    </form>
  );
}

function MonthManager({ month, onDone, reloadKey }) {
  const { t, lang } = useLang();
  const [msg, setMsg] = useState('');
  const [rcode, setRcode] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmCode, setConfirmCode] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteVal, setNoteVal] = useState(month.note || '');
  const rangeNow = api.periodRangeLabel(api.periodStartMs(month), Date.now(), lang);
  const close = async () => {
    setConfirmClose(false);
    try {
      const r = await api.closePeriod();
      setMsg(t('closedMsg', { range: api.periodRangeLabel(r.startMs, r.endMs, lang) }));
      onDone();
    } catch (e) { setMsg(t('errPrefix') + e.message); }
  };
  const newCode = async () => {
    setConfirmCode(false);
    try { setRcode(await api.getRecoveryCode()); }
    catch (e) { setMsg(t('errPrefix') + e.message); }
  };
  const saveNote = async () => {
    try {
      await api.setPeriodNote(month.id, noteVal);
      setNoteOpen(false);
      onDone();
      setMsg(t('noteSaved'));
    } catch (e) { setMsg(t('errPrefix') + e.message); }
  };
  return (<>
    <div className="card">
      <h3>{api.periodDisplay(month, lang)}</h3>
      <p className="dim">{t('onlyAdminClose')}</p>
      <div className="btnrow">
        <button className="danger-btn" onClick={() => setConfirmClose(true)}>{t('closePeriod')}</button>
        <button className="ghost sm" onClick={() => { setNoteVal(month.note || ''); setNoteOpen(true); }}>
          {t('noteNameBtn')}
        </button>
      </div>
      {msg && <p className="msg">{msg}</p>}
    </div>
    {noteOpen && (
      <Modal onClose={() => setNoteOpen(false)}>
        <p className="dlgmsg">{t('periodNoteLabel')}</p>
        <input value={noteVal} onChange={(e) => setNoteVal(e.target.value)}
          placeholder={t('notePh')} autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') saveNote(); }} />
        <div className="btnrow">
          <button onClick={saveNote}>{t('save')}</button>
          <button className="ghost" onClick={() => setNoteOpen(false)}>{t('cancel')}</button>
        </div>
      </Modal>
    )}
    <div className="card">
      <h3>{t('recoveryCode')}</h3>
      <p className="dim">{t('onlyAdminRecovery')}</p>
      <button className="ghost" onClick={() => setConfirmCode(true)}>{t('newRecoveryCode')}</button>
      {rcode && <p className="bigcode">{rcode}</p>}
    </div>
    <h3>{t('oldPeriods')}</h3>
    <History reloadKey={reloadKey} admin />
    {confirmClose && (
      <ConfirmDialog message={t('qClosePeriod', { range: rangeNow })}
        okLabel={t('closePeriod')} onOk={close} onCancel={() => setConfirmClose(false)} />
    )}
    {confirmCode && (
      <ConfirmDialog message={t('qNewRecovery')}
        onOk={newCode} onCancel={() => setConfirmCode(false)} />
    )}
  </>);
}

/* ================= Member ================= */

function MemberApp({ session, onLogout }) {
  const { t, lang, fmt } = useLang();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [tab, setTab] = useState('dash');
  useEffect(() => {
    setFailed(false);
    api.dashboard().then(setData).catch(() => setFailed(true));
  }, [reload]);
  const refresh = () => { setFailed(false); setReload((r) => r + 1); };
  const me = data?.members.find((m) => m.id === session.user.id);
  const periodLabel = data ? api.periodDisplay(data.month, lang) : '';

  return (
    <div className="wrap">
      <Header session={session} onLogout={onLogout} />
      <div className="tabs">
        {[['dash', t('tabDash')], ['add', t('tabAdd')], ['month', t('tabPeriod')]].map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {failed
        ? <div className="card"><h3>{t('dataFail')}</h3>
            <p className="dim">{t('checkNet')}</p>
            <div className="btnrow">
              <button onClick={refresh}>{t('retry')}</button>
              <button className="ghost" onClick={onLogout}>{t('goLogin')}</button>
            </div></div>
        : !data ? <p className="center">{t('loading')}</p> : <>
        <h2>{periodLabel}</h2>
        {tab === 'dash' && <>
          {me && (
            <div className="stats">
              <div className="stat"><span>{t('youPaid')}</span><b>{fmt(me.paid)}</b></div>
              <div className="stat"><span>{t('yourAdvance')}</span><b>{fmt(me.advance)}</b></div>
            </div>
          )}
          <BalanceTable members={data.members} payments={data.payments || []} />
          <SettlementSection members={data.members} payments={data.payments || []} expenses={data.approvedExpenses || []}
            monthId={data.month.id} monthLabel={periodLabel} onDone={refresh} />
          <CategoryBreakdown items={data.byCategory} />
        </>}
        {tab === 'add' && <>
          <ExpenseForm members={data.members} onDone={refresh} />
          <h3>{t('yourExpenses')}</h3>
          <ExpenseList items={[...(data.pending || []), ...(data.recent || [])]} />
        </>}
        {tab === 'month' && <>
          <h3>{t('oldPeriods')}</h3>
          <History reloadKey={reload} />
        </>}
      </>}
    </div>
  );
}
