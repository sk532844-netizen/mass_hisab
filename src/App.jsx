import { useState, useEffect } from 'react';
import * as api from './lib/api';

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

  if (checking) return <div className="wrap"><p className="center">লোড হচ্ছে…</p></div>;
  if (!session) return <AuthScreen onDone={done} />;
  return session.user.role === 'admin'
    ? <AdminApp session={session} onLogout={out} />
    : <MemberApp session={session} onLogout={out} />;
}

/* ================= Auth ================= */

function AuthScreen({ onDone }) {
  const [tab, setTab] = useState('login');
  return (
    <div className="wrap">
      <div className="hero">
        <div className="coin">৳</div>
        <h1 className="logo">মেস হিসাব</h1>
        <p className="sub">মাসের খরচের সহজ হিসাব — অ্যাডমিন ও মেম্বারদের জন্য</p>
      </div>
      <div className="tabs">
        <button className={tab === 'login' ? 'on' : ''} onClick={() => setTab('login')}>লগইন</button>
        <button className={tab === 'signup' ? 'on' : ''} onClick={() => setTab('signup')}>নতুন মেস খুলুন</button>
      </div>
      {tab === 'login' ? <LoginForm onDone={onDone} /> : <SignupForm onDone={onDone} />}
      <p className="foot">তোমার সব হিসাব নিরাপদে অনলাইনে সংরক্ষিত থাকে</p>
    </div>
  );
}

function LoginForm({ onDone }) {
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
      <label>মেস কোড<input value={code} onChange={(e) => setCode(e.target.value)}
        placeholder="যেমন: A7K2P9" autoCapitalize="characters" /></label>
      <label>ইউজারনেম<input value={user} onChange={(e) => setUser(e.target.value)}
        placeholder="তোমার ইউজারনেম" /></label>
      <label>পাসওয়ার্ড<input type="password" value={pass}
        onChange={(e) => setPass(e.target.value)} placeholder="••••••" /></label>
      {err && <p className="err">{err}</p>}
      <button disabled={busy}>{busy ? 'ঢুকছি…' : 'লগইন'}</button>
      <p className="hint">মেস কোড অ্যাডমিনের কাছ থেকে নাও।</p>
      <p className="hint"><a href="#" onClick={(e) => { e.preventDefault(); setForgot(true); }}>
        পাসওয়ার্ড ভুলে গেছো?</a> (মেম্বার হলে অ্যাডমিনকে বলো)</p>
    </form>
  );
}

function ForgotForm({ onBack }) {
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
      setMsg('পাসওয়ার্ড বদলে গেছে! এখন নতুন পাসওয়ার্ড দিয়ে লগইন করো।');
    } catch (e2) { setMsg('ত্রুটি: ' + e2.message); }
    setBusy(false);
  };
  return (
    <form className="card" onSubmit={go}>
      <h3>পাসওয়ার্ড রিসেট</h3>
      <p className="hint">শুধু অ্যাডমিন রিকভারি কোড দিয়ে রিসেট করতে পারবে।</p>
      <label>মেস কোড<input value={code} onChange={(e) => setCode(e.target.value)}
        autoCapitalize="characters" required /></label>
      <label>ইউজারনেম<input value={user} onChange={(e) => setUser(e.target.value)} required /></label>
      <label>রিকভারি কোড<input value={rc} onChange={(e) => setRc(e.target.value)}
        placeholder="যেমন: X7K9-P2M4" autoCapitalize="characters" required /></label>
      <label>নতুন পাসওয়ার্ড<input type="password" value={np}
        onChange={(e) => setNp(e.target.value)} required /></label>
      <button disabled={busy}>{busy ? 'বদলাচ্ছি…' : 'পাসওয়ার্ড বদলাও'}</button>
      {msg && <p className="msg">{msg}</p>}
      <p className="hint"><a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>← লগইনে ফিরে যাও</a></p>
    </form>
  );
}

function SignupForm({ onDone }) {
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
        <h3>রিকভারি কোড সংরক্ষণ করো!</h3>
        <p className="dim">পাসওয়ার্ড ভুলে গেলে এই কোড দিয়ে রিসেট করতে পারবে।
          এটা নিরাপদ জায়গায় লিখে রাখো — আর কখনো দেখানো হবে না।</p>
        <p className="bigcode">{pending.code}</p>
        <button onClick={() => onDone(pending.res)}>সংরক্ষণ করেছি, ভেতরে ঢুকো</button>
      </div>
    );
  }
  return (
    <form className="card" onSubmit={go}>
      <label>মেসের নাম<input value={mess} onChange={(e) => setMess(e.target.value)}
        placeholder="যেমন: শান্তিনিকেতন মেস" /></label>
      <label>তোমার নাম<input value={name} onChange={(e) => setName(e.target.value)}
        placeholder="অ্যাডমিনের নাম" /></label>
      <label>ইউজারনেম<input value={user} onChange={(e) => setUser(e.target.value)}
        placeholder="কমপক্ষে ৩ অক্ষর" /></label>
      <label>পাসওয়ার্ড<input type="password" value={pass}
        onChange={(e) => setPass(e.target.value)} placeholder="কমপক্ষে ৪ অক্ষর" /></label>
      {err && <p className="err">{err}</p>}
      <button disabled={busy}>{busy ? 'খুলছি…' : 'মেস তৈরি করো'}</button>
      <p className="hint">তুমি হবে এই মেসের অ্যাডমিন। পরে মেম্বার যোগ করতে পারবে।</p>
    </form>
  );
}

/* ================= Shared bits ================= */

function Header({ session, onLogout }) {
  return (
    <header className="topbar">
      <div>
        <div className="mtitle">{session.mess.name}</div>
        <div className="mcode">মেস কোড: <b>{session.mess.join_code}</b> · {session.user.display_name}</div>
      </div>
      <button className="ghost" onClick={onLogout}>বের হও</button>
    </header>
  );
}

function BalanceTable({ members }) {
  const s = api.settle(members);
  return (
    <>
      <div className="stats">
        <div className="stat"><span>মোট খরচ</span><b>{api.fmt(s.total)}</b></div>
        <div className="stat"><span>জনপ্রতি ভাগ</span><b>{api.fmt(s.share)}</b></div>
      </div>
      <table className="tbl">
        <thead><tr><th>নাম</th><th>খরচ দিয়েছে</th><th>অ্যাডভান্স</th><th>ব্যালেন্স</th></tr></thead>
        <tbody>
          {s.rows.map((r) => (
            <tr key={r.id}>
              <td>{r.display_name}{r.role === 'admin' ? ' 👑' : ''}</td>
              <td>{api.fmt(r.paid)}</td>
              <td>{api.fmt(r.advance)}</td>
              <td className={r.balance >= 0 ? 'pos' : 'neg'}>
                {r.balance >= 0 ? `পাবে ${api.fmt(r.balance)}` : `দেবে ${api.fmt(-r.balance)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.plan.length > 0 && (
        <div className="card">
          <h3>মিটমাটের হিসাব</h3>
          {s.plan.map((p, i) => (
            <p key={i} className="settle">{p.from} → {p.to}: <b>{api.fmt(p.amount)}</b></p>
          ))}
        </div>
      )}
    </>
  );
}

function History({ reloadKey }) {
  const [hist, setHist] = useState(null);
  useEffect(() => {
    api.monthHistory().then(setHist).catch(() => setHist([]));
  }, [reloadKey]);
  if (hist === null) return <p className="center">লোড হচ্ছে…</p>;
  if (!hist.length) return <p className="center dim">এখনো কোনো মাস ক্লোজ হয়নি।</p>;
  return hist.map((h, i) => (
    <div className="card" key={i}>
      <h3>{h.label}</h3>
      <p>মোট খরচ: <b>{api.fmt(h.total_expense)}</b> · মোট অ্যাডভান্স: <b>{api.fmt(h.total_advance)}</b></p>
      <table className="tbl">
        <thead><tr><th>নাম</th><th>খরচ</th><th>অ্যাডভান্স</th></tr></thead>
        <tbody>
          {(h.members || []).map((m, j) => (
            <tr key={j}><td>{m.display_name}</td><td>{api.fmt(m.paid)}</td><td>{api.fmt(m.advance)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  ));
}

function ExpenseForm({ onDone }) {
  const [amount, setAmount] = useState('');
  const [cat, setCat] = useState(api.CATEGORIES[0]);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const go = async (e) => {
    e.preventDefault(); setMsg('');
    try {
      await api.submitExpense(Number(amount), cat, note);
      setAmount(''); setNote('');
      setMsg('পাঠানো হয়েছে! অ্যাডমিন অনুমোদন দিলে হিসাবে যোগ হবে।');
      onDone && onDone();
    } catch (e2) { setMsg('ত্রুটি: ' + e2.message); }
  };
  return (
    <form className="card" onSubmit={go}>
      <h3>খরচ যোগ করো</h3>
      <label>টাকার পরিমাণ<input type="number" min="1" step="any" value={amount}
        onChange={(e) => setAmount(e.target.value)} placeholder="যেমন: ৫০০" required /></label>
      <label>ক্যাটাগরি
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          {api.CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select></label>
      <label>নোট (ঐচ্ছিক)<input value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="যেমন: সকালের বাজার" /></label>
      <button>পাঠাও</button>
      {msg && <p className="msg">{msg}</p>}
    </form>
  );
}

/* ================= Admin ================= */

function AdminApp({ session, onLogout }) {
  const [tab, setTab] = useState('dash');
  const [data, setData] = useState(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    api.dashboard().then(setData).catch(() => {});
  }, [reload]);
  const refresh = () => setReload((r) => r + 1);

  return (
    <div className="wrap">
      <Header session={session} onLogout={onLogout} />
      <div className="tabs">
        {[['dash', 'হিসাব'], ['pending', 'অনুমোদন'], ['members', 'মেম্বার'],
          ['adv', 'অ্যাডভান্স'], ['month', 'মাস']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {!data ? <p className="center">লোড হচ্ছে…</p> : <>
        {tab === 'dash' && <>
          <h2>{data.month.label}</h2>
          <BalanceTable members={data.members} />
          <h3>সাম্প্রতিক খরচ</h3>
          <ExpenseList items={data.recent} />
        </>}
        {tab === 'pending' && <PendingList items={data.pending} onDone={refresh} />}
        {tab === 'members' && <MemberManager onDone={refresh} />}
        {tab === 'adv' && <AdvanceForm members={data.members} onDone={refresh} />}
        {tab === 'month' && <MonthManager month={data.month} onDone={refresh} reloadKey={reload} />}
      </>}
    </div>
  );
}

function ExpenseList({ items }) {
  if (!items || !items.length) return <p className="dim">কিছু নেই।</p>;
  return (
    <div className="list">
      {items.map((e) => (
        <div className="row" key={e.id}>
          <div><b>{api.fmt(e.amount)}</b> · {e.category}<br />
            <small>{e.by}{e.note ? ` — ${e.note}` : ''}</small></div>
          <span className={`badge ${e.status}`}>{
            e.status === 'approved' ? 'অনুমোদিত' : e.status === 'rejected' ? 'বাতিল' : 'অপেক্ষমাণ'}</span>
        </div>
      ))}
    </div>
  );
}

function PendingList({ items, onDone }) {
  const [note, setNote] = useState({});
  if (!items || !items.length) return <p className="center dim">অনুমোদনের অপেক্ষায় কিছু নেই।</p>;
  const act = async (id, ok) => {
    try { await api.reviewExpense(id, ok, note[id] || ''); onDone(); }
    catch (e) { alert(e.message); }
  };
  return (
    <div className="list">
      {items.map((e) => (
        <div className="card" key={e.id}>
          <p><b>{api.fmt(e.amount)}</b> · {e.category} — {e.by}<br />
            <small>{e.note || 'নোট নেই'}</small></p>
          <input placeholder="নোট (ঐচ্ছিক)" value={note[e.id] || ''}
            onChange={(ev) => setNote({ ...note, [e.id]: ev.target.value })} />
          <div className="btnrow">
            <button className="ok" onClick={() => act(e.id, true)}>অনুমোদন</button>
            <button className="no" onClick={() => act(e.id, false)}>বাতিল</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function MemberManager({ onDone }) {
  const [list, setList] = useState([]);
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [n, setN] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api.members().then(setList).catch(() => {});
  useEffect(load, []);
  const add = async (e) => {
    e.preventDefault(); setMsg('');
    try { await api.addMember(u, p, n); setU(''); setP(''); setN(''); load(); onDone(); setMsg('মেম্বার যোগ হয়েছে!'); }
    catch (e2) { setMsg('ত্রুটি: ' + e2.message); }
  };
  const rm = async (id, name) => {
    if (!confirm(`${name}-কে বাদ দেবে?`)) return;
    try { await api.removeMember(id); load(); onDone(); } catch (e2) { alert(e2.message); }
  };
  const reset = async (id, name) => {
    const np = prompt(`${name}-এর নতুন পাসওয়ার্ড দাও:`);
    if (!np) return;
    try { await api.resetMemberPassword(id, np); alert('পাসওয়ার্ড বদলে গেছে!'); }
    catch (e2) { alert(e2.message); }
  };
  return (<>
    <form className="card" onSubmit={add}>
      <h3>নতুন মেম্বার</h3>
      <label>নাম<input value={n} onChange={(e) => setN(e.target.value)} required placeholder="মেম্বারের নাম" /></label>
      <label>ইউজারনেম<input value={u} onChange={(e) => setU(e.target.value)} required placeholder="লগইনের জন্য" /></label>
      <label>পাসওয়ার্ড<input value={p} onChange={(e) => setP(e.target.value)} required placeholder="মেম্বারকে জানিয়ে দাও" /></label>
      <button>যোগ করো</button>
      {msg && <p className="msg">{msg}</p>}
    </form>
    <div className="list">
      {list.map((m) => (
        <div className="row" key={m.id}>
          <div><b>{m.display_name}</b><br /><small>{m.username} · {m.role === 'admin' ? 'অ্যাডমিন' : 'মেম্বার'}</small></div>
          <div className="btnrow">
            <button className="ghost sm" onClick={() => reset(m.id, m.display_name)}>পাসওয়ার্ড</button>
            <button className="ghost sm danger" onClick={() => rm(m.id, m.display_name)}>বাদ</button>
          </div>
        </div>
      ))}
    </div>
  </>);
}

function AdvanceForm({ members, onDone }) {
  const [mid, setMid] = useState(members[0]?.id || '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const go = async (e) => {
    e.preventDefault(); setMsg('');
    try {
      await api.recordAdvance(mid, Number(amount), note);
      setAmount(''); setNote(''); onDone(); setMsg('অ্যাডভান্স রেকর্ড হয়েছে!');
    } catch (e2) { setMsg('ত্রুটি: ' + e2.message); }
  };
  return (
    <form className="card" onSubmit={go}>
      <h3>অ্যাডভান্স নাও</h3>
      <label>মেম্বার
        <select value={mid} onChange={(e) => setMid(e.target.value)}>
          {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
        </select></label>
      <label>টাকার পরিমাণ<input type="number" min="1" step="any" value={amount}
        onChange={(e) => setAmount(e.target.value)} required placeholder="যেমন: ২০০০" /></label>
      <label>নোট (ঐচ্ছিক)<input value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="যেমন: অক্টোবরের অ্যাডভান্স" /></label>
      <button>রেকর্ড করো</button>
      {msg && <p className="msg">{msg}</p>}
    </form>
  );
}

function MonthManager({ month, onDone, reloadKey }) {
  const [msg, setMsg] = useState('');
  const [rcode, setRcode] = useState('');
  const close = async () => {
    if (!confirm(`${month.label} ক্লোজ করবে? এরপর নতুন মাস শুরু হবে।`)) return;
    try {
      const r = await api.closeMonth();
      setMsg(`${r.closed} ক্লোজ হয়েছে। নতুন মাস: ${r.new_month}`);
      onDone();
    } catch (e) { setMsg('ত্রুটি: ' + e.message); }
  };
  const newCode = async () => {
    if (!confirm('নতুন রিকভারি কোড বানাবে? পুরনো কোড বাতিল হয়ে যাবে।')) return;
    try { setRcode(await api.getRecoveryCode()); }
    catch (e) { setMsg('ত্রুটি: ' + e.message); }
  };
  return (<>
    <div className="card">
      <h3>চলতি মাস: {month.label}</h3>
      <p className="dim">শুধু অ্যাডমিন মাস ক্লোজ করতে পারে। ক্লোজ হলে নতুন মাসের হিসাব শুরু হবে।</p>
      <button className="danger-btn" onClick={close}>মাস ক্লোজ করো</button>
      {msg && <p className="msg">{msg}</p>}
    </div>
    <div className="card">
      <h3>রিকভারি কোড</h3>
      <p className="dim">কোড হারিয়ে গেলে এখান থেকে নতুন বানাতে পারবে।</p>
      <button className="ghost" onClick={newCode}>নতুন রিকভারি কোড বানাও</button>
      {rcode && <p className="bigcode">{rcode}</p>}
    </div>
    <h3>পুরনো মাসের হিসাব</h3>
    <History reloadKey={reloadKey} />
  </>);
}

/* ================= Member ================= */

function MemberApp({ session, onLogout }) {
  const [data, setData] = useState(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    api.dashboard().then(setData).catch(() => {});
  }, [reload]);
  const refresh = () => setReload((r) => r + 1);
  const me = data?.members.find((m) => m.id === session.user.id);

  return (
    <div className="wrap">
      <Header session={session} onLogout={onLogout} />
      {!data ? <p className="center">লোড হচ্ছে…</p> : <>
        <h2>{data.month.label}</h2>
        {me && (
          <div className="stats">
            <div className="stat"><span>তুমি খরচ দিয়েছো</span><b>{api.fmt(me.paid)}</b></div>
            <div className="stat"><span>তোমার অ্যাডভান্স</span><b>{api.fmt(me.advance)}</b></div>
          </div>
        )}
        <BalanceTable members={data.members} />
        <ExpenseForm onDone={refresh} />
        <h3>তোমার খরচ</h3>
        <ExpenseList items={[...(data.pending || []), ...(data.recent || [])]} />
        <h3>পুরনো মাস</h3>
        <History reloadKey={reload} />
      </>}
    </div>
  );
}
