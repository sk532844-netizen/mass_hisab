// ============================================================
// মেস হিসাব — Firebase/Firestore data layer
// পুরনো Supabase RPC (supabase-legacy/schema.sql) এর সব লজিক
// এখানে client-side এ replicate করা হয়েছে।
//
// Firestore data model:
//   messes/{messId}                       { name, joinCode, createdAt }
//   joinCodes/{JOINCODE}                  { messId }            (login lookup)
//   messes/{messId}/users/{userId}        { username, passwordHash (SHA-256 hex),
//                                           displayName, role, recoveryCodeHash?, createdAt }
//   messes/{messId}/months/{YYYY-M}       { year, month, label, status, closedAt, createdAt }
//   messes/{messId}/expenses/{id}         { monthId, submittedBy, submittedByName,
//                                           amount, category, note, status,
//                                           reviewedBy?, reviewNote?, tok?, createdAt }
//   messes/{messId}/advances/{id}         { monthId, memberId, amount, collectedBy,
//                                           note, tok?, createdAt }
//   sessions/{token}                      { messId, userId, createdAt, expiresAt }
//
// SECURITY NOTE (সৎ স্বীকারোক্তি):
// - পাসওয়ার্ড SHA-256 দিয়ে hash করে রাখা হয় (Web Crypto, client-side)।
//   Firestore-only client app-এ hash গুলো পড়া যায় by design — পুরনো
//   Supabase সেটআপেও anon key দিয়ে RPC গুলো একইভাবে open ছিল। বন্ধু-বান্ধব/
//   পরিবারের মেস app-এর জন্য এটা গ্রহণযোগ্য; banking-grade নয়।
// - আসল per-user authorization-এর জন্য Firebase Auth দরকার হতো, যা এই
//   app-এ নেই (custom join-code auth)। firestore.rules-এ best-effort
//   structural + session-token check আছে — সীমাবদ্ধতা rules ফাইলে লেখা।
// ============================================================

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  runTransaction,
  writeBatch,
  Timestamp,
} from 'firebase/firestore';
import { getDb, isConfigured } from './firebase.js';

export { isConfigured };

const SESSION_DAYS = 30;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // বিভ্রান্তিকর অক্ষর বাদ
const HEX_CHARS = '0123456789ABCDEF';

const BN_MONTHS = [
  'জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর',
];
const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

// ---------- small helpers ----------

async function sha256Hex(text) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randFrom(charset, len) {
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return [...arr].map((n) => charset[n % charset.length]).join('');
}

const newId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : randFrom(HEX_CHARS, 32);

function bnMonthLabel(year, month) {
  const yBn = String(year)
    .split('')
    .map((d) => BN_DIGITS[Number(d)] ?? d)
    .join('');
  return `${BN_MONTHS[month - 1]} ${yBn}`;
}

// ---------- flexible periods ----------
// পিরিয়ড ক্যালেন্ডার মাসে বাঁধা নয় — অ্যাডমিন যেদিন ক্লোজ করে সেদিন শেষ,
// নতুন পিরিয়ড সেদিন থেকেই শুরু। পুরনো calendar-month ডকুমেন্টের সাথে
// backward compatible (year/month থেকে start ধরা হয়)।

export function periodStartMs(m) {
  const s = m.startDate;
  if (s && s.toMillis) return s.toMillis();
  if (typeof s === 'string') {
    const t = Date.parse(s);
    if (!isNaN(t)) return t;
  }
  if (m.year && m.month) return new Date(m.year, m.month - 1, 1).getTime();
  const c = m.createdAt;
  if (c && c.toMillis) return c.toMillis();
  if (typeof c === 'string') {
    const t = Date.parse(c);
    if (!isNaN(t)) return t;
  }
  return 0;
}

function periodEndMs(m) {
  const e = m.endDate;
  if (e && e.toMillis) return e.toMillis();
  if (typeof e === 'string') {
    const t = Date.parse(e);
    if (!isNaN(t)) return t;
  }
  const c = m.closedAt;
  if (c && c.toMillis) return c.toMillis();
  if (typeof c === 'string') {
    const t = Date.parse(c);
    if (!isNaN(t)) return t;
  }
  return null;
}

const bnD = (n) =>
  String(n)
    .split('')
    .map((d) => BN_DIGITS[Number(d)] ?? d)
    .join('');

function dayMonth(ms, lang) {
  const d = new Date(ms);
  const day = d.getDate();
  if (lang === 'en') return `${day} ${EN_MONTHS[d.getMonth()]}`;
  return `${bnD(day)} ${BN_MONTHS[d.getMonth()]}`;
}

// "১–১৩ অক্টোবর ২০২৬" / "1–13 October 2026"
export function periodRangeLabel(startMs, endMs, lang) {
  const s = new Date(startMs);
  const e = new Date(endMs);
  const en = lang === 'en';
  const dd = (n) => (en ? String(n) : bnD(n));
  const mm = (i) => (en ? EN_MONTHS[i] : BN_MONTHS[i]);
  const yy = (y) => (en ? String(y) : bnD(y));
  if (s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth())
    return `${dd(s.getDate())}–${dd(e.getDate())} ${mm(s.getMonth())} ${yy(s.getFullYear())}`;
  if (s.getFullYear() === e.getFullYear())
    return `${dd(s.getDate())} ${mm(s.getMonth())} – ${dd(e.getDate())} ${mm(e.getMonth())} ${yy(s.getFullYear())}`;
  return `${dd(s.getDate())} ${mm(s.getMonth())} ${yy(s.getFullYear())} – ${dd(e.getDate())} ${mm(e.getMonth())} ${yy(e.getFullYear())}`;
}

// পিরিয়ডের display লেবেল (lang-aware) — raw month ডকুমেন্ট নেয়
export function periodDisplay(m, lang) {
  const en = lang === 'en';
  const startMs = periodStartMs(m);
  if (m.status === 'closed') {
    const endMs = periodEndMs(m) || startMs;
    const r = periodRangeLabel(startMs, endMs, lang);
    return m.note ? `${m.note} (${r})` : r;
  }
  const s = dayMonth(startMs, lang);
  if (m.note) return en ? `${m.note} (${s} – ongoing)` : `${m.note} (${s} থেকে চলমান)`;
  return en ? `Ongoing since ${s}` : `${s} থেকে চলমান`;
}

const iso = (ts) => (ts && ts.toDate ? ts.toDate().toISOString() : null);
const num = (v) => Number(v || 0);

// ---------- session ----------

// localStorage-এর mh_token দিয়ে session + user + mess resolve করে।
// মেয়াদোত্তীর্ণ/ভুল token হলে Error — App.jsx এটা ধরে logout করে।
async function sessionCtx() {
  const db = getDb();
  const token = localStorage.getItem('mh_token');
  if (!token) throw new Error('সেশন শেষ — আবার লগইন করো');

  const sSnap = await getDoc(doc(db, 'sessions', token));
  if (!sSnap.exists()) throw new Error('সেশন শেষ — আবার লগইন করো');
  const s = sSnap.data();
  if (!s.expiresAt || s.expiresAt.toMillis() < Date.now()) {
    await deleteDoc(doc(db, 'sessions', token)).catch(() => {});
    throw new Error('সেশন শেষ — আবার লগইন করো');
  }

  const uSnap = await getDoc(doc(db, 'messes', s.messId, 'users', s.userId));
  if (!uSnap.exists()) throw new Error('সেশন শেষ — আবার লগইন করো');
  const mSnap = await getDoc(doc(db, 'messes', s.messId));
  if (!mSnap.exists()) throw new Error('সেশন শেষ — আবার লগইন করো');

  const u = uSnap.data();
  const m = mSnap.data();
  if (u.active === false) throw new Error('এই অ্যাকাউন্ট নিষ্ক্রিয় করা হয়েছে');
  // পাসওয়ার্ড রিসেটের পর পুরনো সেশন বাতিল: user-এর sessionValidAfter-এর
  // আগের তৈরি সেশন reject হয় (sessions collection query ছাড়াই —
  // rules-এ sessions list নিষেধ)।
  if (
    u.sessionValidAfter &&
    s.createdAt.toMillis() < u.sessionValidAfter.toMillis()
  ) {
    await deleteDoc(doc(db, 'sessions', token)).catch(() => {});
    throw new Error('সেশন শেষ — আবার লগইন করো');
  }
  return {
    db,
    token,
    me: { id: uSnap.id, ...u },
    mess: { id: mSnap.id, ...m },
  };
}

function requireAdmin(me) {
  if (me.role !== 'admin') throw new Error('FORBIDDEN');
}

function usersCol(db, messId) {
  return collection(db, 'messes', messId, 'users');
}
function monthsCol(db, messId) {
  return collection(db, 'messes', messId, 'months');
}
function expensesCol(db, messId) {
  return collection(db, 'messes', messId, 'expenses');
}
function advancesCol(db, messId) {
  return collection(db, 'messes', messId, 'advances');
}
function paymentsCol(db, messId) {
  return collection(db, 'messes', messId, 'payments');
}

// খোলা পিরিয়ড — না থাকলে এখন থেকে শুরু করে বানায়।
async function ensureOpenPeriod(db, messId, tok) {
  const snap = await getDocs(
    query(monthsCol(db, messId), where('status', '==', 'open')),
  );
  if (!snap.empty) {
    const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    docs.sort((a, b) => periodStartMs(b) - periodStartMs(a));
    return docs[0];
  }
  const now = Timestamp.now();
  const data = {
    startDate: now,
    endDate: null,
    note: null,
    status: 'open',
    closedAt: null,
    createdAt: now,
    ...(tok ? { tok } : {}),
  };
  const ref = await addDoc(monthsCol(db, messId), data);
  return { id: ref.id, ...data };
}

// পুরনো নামে wrapper (ভেতরে period ব্যবহার করে)
async function ensureOpenMonth(db, messId, tok) {
  return ensureOpenPeriod(db, messId, tok);
}

// খালি join code দাবি করা — transaction দিয়ে atomic claim।
async function claimJoinCode(db, messId) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randFrom(CODE_CHARS, 6);
    const ref = doc(db, 'joinCodes', code);
    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists()) throw new Error('TAKEN');
        tx.set(ref, { messId });
      });
      return code;
    } catch (e) {
      if (e.message !== 'TAKEN') throw e;
    }
  }
  throw new Error('মেস কোড বানানো যাচ্ছে না, আবার চেষ্টা করো');
}

async function findUserByName(db, messId, username) {
  const q = query(
    usersCol(db, messId),
    where('username', '==', username.trim()),
    limit(1),
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

function publicUser(u) {
  return {
    id: u.id,
    display_name: u.displayName,
    username: u.username,
    role: u.role,
    active: u.active !== false,
  };
}

async function createSession(db, messId, userId) {
  const token = newId();
  await setDoc(doc(db, 'sessions', token), {
    messId,
    userId,
    createdAt: Timestamp.now(),
    expiresAt: Timestamp.fromMillis(Date.now() + SESSION_DAYS * 24 * 3600 * 1000),
  });
  return token;
}

// ---------- auth ----------

export async function signupAdmin({ messName, username, password, displayName }) {
  const db = getDb();
  if (!messName || messName.trim().length < 2) throw new Error('মেসের নাম দাও');
  if (!username || username.trim().length < 3)
    throw new Error('ইউজারনেম কমপক্ষে ৩ অক্ষরের হতে হবে');
  if (!password || password.length < 4)
    throw new Error('পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে');

  const messId = newId();
  const userId = newId();
  const code = await claimJoinCode(db, messId);

  const batch = writeBatch(db);
  batch.set(doc(db, 'messes', messId), {
    name: messName.trim(),
    joinCode: code,
    createdAt: Timestamp.now(),
  });
  batch.set(doc(db, 'messes', messId, 'users', userId), {
    username: username.trim(),
    passwordHash: await sha256Hex(password),
    displayName: (displayName || '').trim(),
    role: 'admin',
    recoveryCodeHash: null,
    createdAt: Timestamp.now(),
  });
  const nowTs = Timestamp.now();
  batch.set(doc(collection(db, 'messes', messId, 'months')), {
    startDate: nowTs,
    endDate: null,
    note: null,
    status: 'open',
    closedAt: null,
    createdAt: nowTs,
  });
  await batch.commit();

  const token = await createSession(db, messId, userId);
  return {
    token,
    user: {
      id: userId,
      display_name: (displayName || '').trim(),
      username: username.trim(),
      role: 'admin',
    },
    mess: { id: messId, name: messName.trim(), join_code: code },
  };
}

export async function login(joinCode, username, password) {
  const db = getDb();
  const code = (joinCode || '').trim().toUpperCase();
  const cSnap = await getDoc(doc(db, 'joinCodes', code));
  if (!cSnap.exists()) throw new Error('ভুল মেস কোড');
  const messId = cSnap.data().messId;

  const u = await findUserByName(db, messId, username || '');
  if (!u || u.passwordHash !== (await sha256Hex(password || '')))
    throw new Error('ভুল ইউজারনেম বা পাসওয়ার্ড');
  if (u.active === false)
    throw new Error('এই অ্যাকাউন্ট নিষ্ক্রিয় করা হয়েছে — অ্যাডমিনের সাথে যোগাযোগ করো');

  const token = await createSession(db, messId, u.id);
  const mSnap = await getDoc(doc(db, 'messes', messId));
  if (!mSnap.exists()) throw new Error('ভুল মেস কোড');
  const m = mSnap.data();
  return {
    token,
    user: publicUser(u),
    mess: { id: messId, name: m.name, join_code: m.joinCode },
  };
}

export async function logout() {
  try {
    const db = getDb();
    const token = localStorage.getItem('mh_token');
    if (token) await deleteDoc(doc(db, 'sessions', token));
  } catch {
    // logout কখনো error দেখাবে না
  }
}

// ---------- members ----------

export async function members() {
  const { db, mess } = await sessionCtx();
  const snap = await getDocs(query(usersCol(db, mess.id), orderBy('createdAt')));
  return snap.docs.map((d) => publicUser({ id: d.id, ...d.data() }));
}

export async function addMember(username, password, displayName) {
  const { db, token, me, mess } = await sessionCtx();
  requireAdmin(me);
  if (!username || username.trim().length < 3)
    throw new Error('ইউজারনেম কমপক্ষে ৩ অক্ষরের হতে হবে');
  if (!password || password.length < 4)
    throw new Error('পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে');
  if (await findUserByName(db, mess.id, username))
    throw new Error('এই ইউজারনেমটি ইতিমধ্যে আছে');

  const ref = await addDoc(usersCol(db, mess.id), {
    username: username.trim(),
    passwordHash: await sha256Hex(password),
    displayName: (displayName || '').trim(),
    role: 'member',
    recoveryCodeHash: null,
    createdAt: Timestamp.now(),
    tok: token,
  });
  return {
    id: ref.id,
    display_name: (displayName || '').trim(),
    username: username.trim(),
    role: 'member',
  };
}

// ---------- roles & active ----------

// সক্রিয় অ্যাডমিন সংখ্যা (active ফিল্ড না থাকলে সক্রিয় ধরা হয়)
async function adminCount(db, messId) {
  const snap = await getDocs(
    query(usersCol(db, messId), where('role', '==', 'admin')),
  );
  return snap.docs.filter((d) => d.data().active !== false).length;
}

// মেম্বারকে অ্যাডমিন বানানো / অ্যাডমিনকে মেম্বার করা (শুধু অ্যাডমিন)।
// নিজের পদ নিজে ছাড়লে { selfDemoted: true } — UI রিলোড করবে।
export async function setMemberRole(userId, role) {
  const { db, token, me, mess } = await sessionCtx();
  requireAdmin(me);
  if (role !== 'admin' && role !== 'member') throw new Error('FORBIDDEN');
  const ref = doc(db, 'messes', mess.id, 'users', userId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('NOT_FOUND');
  const t = snap.data();
  if (t.active === false && role === 'admin')
    throw new Error('নিষ্ক্রিয় মেম্বারকে অ্যাডমিন করা যাবে না');
  if (t.role === role) return { selfDemoted: false };
  if (role === 'member' && t.role === 'admin') {
    if ((await adminCount(db, mess.id)) <= 1)
      throw new Error('শেষ অ্যাডমিনের পদ বদলানো যাবে না — আগে অন্য কাউকে অ্যাডমিন করো');
  }
  await updateDoc(ref, { role, tok: token });
  return { selfDemoted: userId === me.id && role === 'member' };
}

// মেম্বার নিষ্ক্রিয়/সক্রিয় করা (শুধু অ্যাডমিন)।
// ডিলিটের বদলে নিষ্ক্রিয় — পুরনো খরচ/অ্যাডভান্সের রেকর্ড অটুট থাকে,
// লগইন বন্ধ হয় সাথে সাথে (sessionCtx active চেক করে)।
export async function setMemberActive(userId, active) {
  const { db, token, me, mess } = await sessionCtx();
  requireAdmin(me);
  if (userId === me.id) throw new Error('নিজেকে নিষ্ক্রিয় করা যাবে না');
  const ref = doc(db, 'messes', mess.id, 'users', userId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('NOT_FOUND');
  const t = snap.data();
  if (!active && t.role === 'admin' && t.active !== false) {
    if ((await adminCount(db, mess.id)) <= 1)
      throw new Error('শেষ অ্যাডমিনকে নিষ্ক্রিয় করা যাবে না');
  }
  await updateDoc(ref, { active: !!active, tok: token });
}

export async function resetMemberPassword(userId, newPassword) {
  const { db, token, me, mess } = await sessionCtx();
  requireAdmin(me);
  if (!newPassword || newPassword.length < 4)
    throw new Error('পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে');
  const tSnap = await getDoc(doc(db, 'messes', mess.id, 'users', userId));
  if (!tSnap.exists()) throw new Error('NOT_FOUND');
  await updateDoc(doc(db, 'messes', mess.id, 'users', userId), {
    passwordHash: await sha256Hex(newPassword),
    tok: token,
  });
}

// ---------- expenses & advances ----------

export async function submitExpense(amount, category, note) {
  const { db, token, me, mess } = await sessionCtx();
  if (amount == null || Number(amount) <= 0)
    throw new Error('সঠিক টাকার পরিমাণ দাও');
  const month = await ensureOpenMonth(db, mess.id, token);
  const ref = await addDoc(expensesCol(db, mess.id), {
    monthId: month.id,
    submittedBy: me.id,
    submittedByName: me.displayName,
    amount: Number(amount),
    category: (category || '').trim() || 'অন্যান্য',
    note: (note || '').trim() || null,
    status: 'pending',
    reviewedBy: null,
    reviewNote: null,
    createdAt: Timestamp.now(),
    tok: token,
  });
  return { id: ref.id, status: 'pending' };
}

export async function reviewExpense(expenseId, approve, note) {
  const { db, token, me, mess } = await sessionCtx();
  requireAdmin(me);
  const ref = doc(db, 'messes', mess.id, 'expenses', expenseId);
  const snap = await getDoc(ref);
  if (!snap.exists() || snap.data().status !== 'pending') return;
  await updateDoc(ref, {
    status: approve ? 'approved' : 'rejected',
    reviewedBy: me.id,
    reviewNote: (note || '').trim() || null,
    tok: token,
  });
}

export async function recordAdvance(memberId, amount, note) {
  const { db, token, me, mess } = await sessionCtx();
  requireAdmin(me);
  if (amount == null || Number(amount) <= 0)
    throw new Error('সঠিক টাকার পরিমাণ দাও');
  const tSnap = await getDoc(doc(db, 'messes', mess.id, 'users', memberId));
  if (!tSnap.exists()) throw new Error('NOT_FOUND');
  const month = await ensureOpenMonth(db, mess.id, token);
  const ref = await addDoc(advancesCol(db, mess.id), {
    monthId: month.id,
    memberId,
    amount: Number(amount),
    collectedBy: me.id,
    note: (note || '').trim() || null,
    createdAt: Timestamp.now(),
    tok: token,
  });
  return { id: ref.id };
}

// ---------- edit / delete (শুধু অ্যাডমিন) ----------
// ভুল খরচ/অ্যাডভান্স ঠিক করা — চলতি মাস বা বন্ধ মাস, দুটোতেই কাজ করে
// (ইতিহাস raw রেকর্ড থেকে live হিসাব হয়, তাই auto ঠিক হয়ে যায়)।

export async function updateExpense(expenseId, { amount, category, note }) {
  const { db, token, me, mess } = await sessionCtx();
  requireAdmin(me);
  if (amount == null || Number(amount) <= 0)
    throw new Error('সঠিক টাকার পরিমাণ দাও');
  if (!category || !String(category).trim())
    throw new Error('ক্যাটাগরি দাও');
  const ref = doc(db, 'messes', mess.id, 'expenses', expenseId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('NOT_FOUND');
  await updateDoc(ref, {
    amount: Number(amount),
    category: String(category).trim(),
    note: (note || '').trim() || null,
    tok: token,
  });
}

export async function deleteExpense(expenseId) {
  const { db, me, mess } = await sessionCtx();
  requireAdmin(me);
  const ref = doc(db, 'messes', mess.id, 'expenses', expenseId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('NOT_FOUND');
  await deleteDoc(ref);
}

export async function updateAdvance(advanceId, { amount, note }) {
  const { db, token, me, mess } = await sessionCtx();
  requireAdmin(me);
  if (amount == null || Number(amount) <= 0)
    throw new Error('সঠিক টাকার পরিমাণ দাও');
  const ref = doc(db, 'messes', mess.id, 'advances', advanceId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('NOT_FOUND');
  await updateDoc(ref, {
    amount: Number(amount),
    note: (note || '').trim() || null,
    tok: token,
  });
}

export async function deleteAdvance(advanceId) {
  const { db, me, mess } = await sessionCtx();
  requireAdmin(me);
  const ref = doc(db, 'messes', mess.id, 'advances', advanceId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('NOT_FOUND');
  await deleteDoc(ref);
}

// বন্ধ মাসের raw রেকর্ড (শুধু অ্যাডমিন) — ভুল ঠিক করার জন্য
export async function monthRecords(monthId) {
  const { db, me, mess } = await sessionCtx();
  requireAdmin(me);
  const [eSnap, aSnap, uSnap] = await Promise.all([
    getDocs(query(expensesCol(db, mess.id), where('monthId', '==', monthId))),
    getDocs(query(advancesCol(db, mess.id), where('monthId', '==', monthId))),
    getDocs(query(usersCol(db, mess.id), orderBy('createdAt'))),
  ]);
  const users = uSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const uname = (id) => (users.find((x) => x.id === id) || {}).displayName || '?';
  const byTime = (a, b) => b.createdAt.toMillis() - a.createdAt.toMillis();
  return {
    expenses: eSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort(byTime)
      .map((e) => ({
        id: e.id,
        amount: num(e.amount),
        category: e.category,
        note: e.note,
        by: e.submittedByName || uname(e.submittedBy),
        status: e.status,
        at: iso(e.createdAt),
      })),
    advances: aSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort(byTime)
      .map((a) => ({
        id: a.id,
        amount: num(a.amount),
        note: a.note,
        memberId: a.memberId,
        memberName: uname(a.memberId),
        at: iso(a.createdAt),
      })),
  };
}

// ---------- payments (ফান্ডে জমা / ফান্ড থেকে পরিশোধ) ----------
// kind 'in': মেম্বার → ফান্ডে জমা দিলো; 'out': ফান্ড → মেম্বারকে দিলো।

export async function recordPayment(monthId, memberId, kind, amount, note) {
  const { db, token, me, mess } = await sessionCtx();
  requireAdmin(me);
  if (kind !== 'in' && kind !== 'out') throw new Error('FORBIDDEN');
  if (amount == null || Number(amount) <= 0)
    throw new Error('সঠিক টাকার পরিমাণ দাও');
  const uSnap = await getDoc(doc(db, 'messes', mess.id, 'users', memberId));
  if (!uSnap.exists()) throw new Error('NOT_FOUND');
  const mSnap = await getDoc(doc(db, 'messes', mess.id, 'months', monthId));
  if (!mSnap.exists()) throw new Error('NOT_FOUND');
  await addDoc(paymentsCol(db, mess.id), {
    monthId,
    memberId,
    kind,
    amount: Number(amount),
    note: (note || '').trim() || null,
    recordedBy: me.id,
    createdAt: Timestamp.now(),
    tok: token,
  });
}

export async function deletePayment(paymentId) {
  const { db, me, mess } = await sessionCtx();
  requireAdmin(me);
  const ref = doc(db, 'messes', mess.id, 'payments', paymentId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('NOT_FOUND');
  await deleteDoc(ref);
}

// ---------- fund settlement ----------
// ফান্ড = মোট অ্যাডভান্স (অ্যাডমিনের কাছে জমা)।
// যারা দেবে → ফান্ডে জমা দেবে; যারা পাবে → ফান্ড থেকে পাবে।
export function fundSettlement(members, payments) {
  const total = members.reduce((s, m) => s + Number(m.paid), 0);
  const share = members.length ? total / members.length : 0;
  const fundTotal = members.reduce((s, m) => s + Number(m.advance), 0);
  const rows = members.map((m) => {
    const contributed = Number(m.paid) + Number(m.advance);
    return { ...m, contributed, share, balance: contributed - share };
  });
  const paidIn = {};
  const paidOut = {};
  for (const p of payments || []) {
    const amt = Number(p.amount) || 0;
    if (p.kind === 'in') paidIn[p.memberId] = (paidIn[p.memberId] || 0) + amt;
    else paidOut[p.memberId] = (paidOut[p.memberId] || 0) + amt;
  }
  const debtors = [];
  const creditors = [];
  for (const r of rows) {
    if (r.balance < -0.5) {
      const owe = -r.balance;
      const done = paidIn[r.id] || 0;
      debtors.push({ ...r, owe, paid: done, remaining: Math.max(0, owe - done) });
    } else if (r.balance > 0.5) {
      const get = r.balance;
      const done = paidOut[r.id] || 0;
      creditors.push({ ...r, get, paid: done, remaining: Math.max(0, get - done) });
    }
  }
  debtors.sort((a, b) => b.remaining - a.remaining);
  creditors.sort((a, b) => b.remaining - a.remaining);
  return {
    rows,
    total,
    share,
    fundTotal,
    debtors,
    creditors,
    dueIn: debtors.reduce((s, d) => s + d.remaining, 0),
    dueOut: creditors.reduce((s, c) => s + c.remaining, 0),
  };
}

// ---------- split expense ----------
// একটা খরচ একাধিক মেম্বারের মধ্যে ভাগ — প্রত্যেকের নামে আলাদা রেকর্ড
// (একই splitGroup), সব pending হয়ে অ্যাডমিনের অনুমোদনের জন্য যাবে।

export async function submitSplitExpense({ amount, category, note, splits }) {
  const { db, token, me, mess } = await sessionCtx();
  if (!splits || splits.length < 2)
    throw new Error('কমপক্ষে ২ জন সিলেক্ট করো');
  for (const s of splits) {
    if (!s.memberId || !(Number(s.amount) > 0))
      throw new Error('সবার ভাগে সঠিক টাকা দাও');
  }
  const splitTotal = splits.reduce((x, s) => x + Number(s.amount), 0);
  if (amount != null && Math.abs(Number(amount) - splitTotal) > 0.01)
    throw new Error('ভাগের যোগফল মোট টাকার সমান হতে হবে');
  const month = await ensureOpenPeriod(db, mess.id, token);
  const uSnap = await getDocs(query(usersCol(db, mess.id), orderBy('createdAt')));
  const users = uSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const groupId = newId();
  const batch = writeBatch(db);
  splits.forEach((s, i) => {
    const u = users.find((x) => x.id === s.memberId);
    if (!u || u.active === false) throw new Error('NOT_FOUND');
    const ref = doc(collection(db, 'messes', mess.id, 'expenses'));
    batch.set(ref, {
      monthId: month.id,
      submittedBy: s.memberId,
      submittedByName: u.displayName,
      amount: Number(s.amount),
      category: (category || '').trim() || 'অন্যান্য',
      note: (note || '').trim() || null,
      status: 'pending',
      splitGroup: groupId,
      splitIndex: i,
      splitCount: splits.length,
      reviewedBy: null,
      reviewNote: null,
      createdAt: Timestamp.now(),
      tok: token,
    });
  });
  await batch.commit();
  return { groupId, count: splits.length };
}

export async function closePeriod() {
  const { db, token, me, mess } = await sessionCtx();
  requireAdmin(me);
  const snap = await getDocs(
    query(monthsCol(db, mess.id), where('status', '==', 'open')),
  );
  if (snap.empty) throw new Error('কোনো খোলা পিরিয়ড নেই');
  const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // সবচেয়ে পুরনো খোলা পিরিয়ড আগে বন্ধ হবে
  docs.sort((a, b) => periodStartMs(a) - periodStartMs(b));
  const cur = docs[0];

  const now = Timestamp.now();
  const startMs = periodStartMs(cur);
  const batch = writeBatch(db);
  batch.update(doc(db, 'messes', mess.id, 'months', cur.id), {
    status: 'closed',
    endDate: now,
    closedAt: now,
    tok: token,
  });
  batch.set(doc(collection(db, 'messes', mess.id, 'months')), {
    startDate: now,
    endDate: null,
    note: null,
    status: 'open',
    closedAt: null,
    createdAt: now,
    tok: token,
  });
  await batch.commit();
  return { closedId: cur.id, startMs, endMs: now.toMillis() };
}

// পুরনো নামে wrapper
export async function closeMonth() {
  const r = await closePeriod();
  return { closed: periodRangeLabel(r.startMs, r.endMs, 'bn'), new_month: '' };
}

export async function setPeriodNote(monthId, note) {
  const { db, token, me, mess } = await sessionCtx();
  requireAdmin(me);
  const ref = doc(db, 'messes', mess.id, 'months', monthId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('NOT_FOUND');
  await updateDoc(ref, { note: (note || '').trim() || null, tok: token });
}

// ---------- dashboard & history ----------

export async function dashboard() {
  const { db, token, me, mess } = await sessionCtx();

  const mSnap = await getDocs(
    query(monthsCol(db, mess.id), where('status', '==', 'open')),
  );
  let month;
  if (mSnap.empty) {
    month = await ensureOpenPeriod(db, mess.id, token);
  } else {
    const docs = mSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    docs.sort((a, b) => periodStartMs(b) - periodStartMs(a));
    month = docs[0];
  }

  const [uSnap, eSnap, aSnap, pSnap] = await Promise.all([
    getDocs(query(usersCol(db, mess.id), orderBy('createdAt'))),
    getDocs(query(expensesCol(db, mess.id), where('monthId', '==', month.id))),
    getDocs(query(advancesCol(db, mess.id), where('monthId', '==', month.id))),
    getDocs(query(paymentsCol(db, mess.id), where('monthId', '==', month.id))),
  ]);
  const users = uSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const expenses = eSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
  const advances = aSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const payments = pSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());

  const isAdmin = me.role === 'admin';
  const visible = (e) => isAdmin || e.submittedBy === me.id;

  const members = users.map((u) => ({
    id: u.id,
    display_name: u.displayName,
    role: u.role,
    active: u.active !== false,
    paid: expenses
      .filter((e) => e.submittedBy === u.id && e.status === 'approved')
      .reduce((s, e) => s + num(e.amount), 0),
    advance: advances
      .filter((a) => a.memberId === u.id)
      .reduce((s, a) => s + num(a.amount), 0),
  }));

  const expJson = (e) => ({
    id: e.id,
    amount: num(e.amount),
    category: e.category,
    note: e.note,
    by: e.submittedByName,
    at: iso(e.createdAt),
  });

  const payJson = (p) => ({
    id: p.id,
    memberId: p.memberId,
    kind: p.kind,
    amount: num(p.amount),
    note: p.note,
    at: iso(p.createdAt),
  });

  const byCatMap = {};
  expenses
    .filter((e) => e.status === 'approved')
    .forEach((e) => {
      const c = e.category || 'অন্যান্য';
      byCatMap[c] = (byCatMap[c] || 0) + num(e.amount);
    });
  const byCategory = Object.entries(byCatMap)
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);

  return {
    month: {
      id: month.id,
      status: month.status,
      startDate: iso(month.startDate) || null,
      endDate: iso(month.endDate) || null,
      closedAt: iso(month.closedAt),
      note: month.note || null,
    },
    role: me.role,
    members,
    pending: expenses
      .filter((e) => e.status === 'pending' && visible(e))
      .map(expJson),
    recent: expenses
      .filter((e) => e.status !== 'pending' && visible(e))
      .slice(0, 30)
      .map((e) => ({ ...expJson(e), status: e.status })),
    advances: isAdmin
      ? advances
          .slice()
          .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
          .map((a) => {
            const um = users.find((x) => x.id === a.memberId);
            return {
              id: a.id,
              amount: num(a.amount),
              note: a.note,
              memberId: a.memberId,
              memberName: um ? um.displayName : '?',
              at: iso(a.createdAt),
            };
          })
      : [],
    payments: payments.map(payJson),
    byCategory,
    totals: {
      approved: expenses
        .filter((e) => e.status === 'approved')
        .reduce((s, e) => s + num(e.amount), 0),
      pending: expenses
        .filter((e) => e.status === 'pending')
        .reduce((s, e) => s + num(e.amount), 0),
      advances: advances.reduce((s, a) => s + num(a.amount), 0),
    },
  };
}

export async function monthHistory() {
  const { db, mess } = await sessionCtx();
  const [mSnap, uSnap] = await Promise.all([
    getDocs(query(monthsCol(db, mess.id), where('status', '==', 'closed'))),
    getDocs(query(usersCol(db, mess.id), orderBy('createdAt'))),
  ]);
  const months = mSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => periodStartMs(b) - periodStartMs(a));
  const users = uSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const out = [];
  for (const m of months) {
    const [eSnap, aSnap, pSnap] = await Promise.all([
      getDocs(query(expensesCol(db, mess.id), where('monthId', '==', m.id))),
      getDocs(query(advancesCol(db, mess.id), where('monthId', '==', m.id))),
      getDocs(query(paymentsCol(db, mess.id), where('monthId', '==', m.id))),
    ]);
    const expenses = eSnap.docs.map((d) => d.data());
    const advances = aSnap.docs.map((d) => d.data());
    const payments = pSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const byCatMap = {};
    expenses
      .filter((e) => e.status === 'approved')
      .forEach((e) => {
        const c = e.category || 'অন্যান্য';
        byCatMap[c] = (byCatMap[c] || 0) + num(e.amount);
      });
    out.push({
      id: m.id,
      status: m.status,
      startDate: iso(m.startDate) || null,
      endDate: iso(m.endDate) || null,
      note: m.note || null,
      closed_at: iso(m.closedAt),
      total_expense: expenses
        .filter((e) => e.status === 'approved')
        .reduce((s, e) => s + num(e.amount), 0),
      total_advance: advances.reduce((s, a) => s + num(a.amount), 0),
      byCategory: Object.entries(byCatMap)
        .map(([category, total]) => ({ category, total }))
        .sort((a, b) => b.total - a.total),
      payments: payments.map((p) => ({
        id: p.id,
        memberId: p.memberId,
        kind: p.kind,
        amount: num(p.amount),
        note: p.note,
        at: iso(p.createdAt),
      })),
      members: users.map((u) => ({
        display_name: u.displayName,
        paid: expenses
          .filter((e) => e.submittedBy === u.id && e.status === 'approved')
          .reduce((s, e) => s + num(e.amount), 0),
        advance: advances
          .filter((a) => a.memberId === u.id)
          .reduce((s, a) => s + num(a.amount), 0),
      })),
    });
  }
  return out;
}

// ---------- recovery codes ----------

export async function getRecoveryCode() {
  const { db, token, me, mess } = await sessionCtx();
  requireAdmin(me);
  const code = `${randFrom(HEX_CHARS, 4)}-${randFrom(HEX_CHARS, 4)}`;
  await updateDoc(doc(db, 'messes', mess.id, 'users', me.id), {
    recoveryCodeHash: await sha256Hex(code.toUpperCase()),
    tok: token,
  });
  return code;
}

export async function resetPasswordSelf(joinCode, username, recoveryCode, newPassword) {
  const db = getDb();
  const code = (joinCode || '').trim().toUpperCase();
  const cSnap = await getDoc(doc(db, 'joinCodes', code));
  if (!cSnap.exists()) throw new Error('ভুল মেস কোড');
  const messId = cSnap.data().messId;

  const u = await findUserByName(db, messId, username || '');
  if (!u) throw new Error('ব্যবহারকারী পাওয়া যায়নি');
  if (u.role !== 'admin')
    throw new Error('মেম্বারদের পাসওয়ার্ড অ্যাডমিন রিসেট করে দেবে');

  const rc = (recoveryCode || '').trim().toUpperCase();
  if (!u.recoveryCodeHash || u.recoveryCodeHash !== (await sha256Hex(rc)))
    throw new Error('ভুল রিকভারি কোড');
  if (!newPassword || newPassword.length < 4)
    throw new Error('পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে');

  // পুরনো সেশন বাতিল: sessionValidAfter বসিয়ে দিলে sessionCtx()
  // পুরনো token গুলো reject করে — sessions collection query করা লাগে না
  // (rules-এ sessions list নিষেধ, তাই query পদ্ধতি কাজ করে না)।
  await updateDoc(doc(db, 'messes', messId, 'users', u.id), {
    passwordHash: await sha256Hex(newPassword),
    sessionValidAfter: Timestamp.now(),
  });
}

// ---------- pure helpers (UI) ----------

export const CATEGORIES = ['বাজার', 'ভাড়া', 'ইউটিলিটি', 'যাতায়াত', 'অন্যান্য'];

export const fmt = (n) =>
  '৳' + Number(n || 0).toLocaleString('bn-BD', { maximumFractionDigits: 0 });

export function settle(members) {
  const total = members.reduce((s, m) => s + Number(m.paid), 0);
  const share = members.length ? total / members.length : 0;
  const rows = members.map((m) => {
    const contributed = Number(m.paid) + Number(m.advance);
    return { ...m, contributed, share, balance: contributed - share };
  });
  const debtors = rows
    .filter((r) => r.balance < -0.5)
    .map((r) => ({ ...r, owe: -r.balance }))
    .sort((a, b) => b.owe - a.owe);
  const creditors = rows
    .filter((r) => r.balance > 0.5)
    .map((r) => ({ ...r, get: r.balance }))
    .sort((a, b) => b.get - a.get);
  const plan = [];
  let i = 0,
    j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i],
      c = creditors[j];
    const amt = Math.min(d.owe, c.get);
    plan.push({ from: d.display_name, to: c.display_name, amount: Math.round(amt) });
    d.owe -= amt;
    c.get -= amt;
    if (d.owe < 0.5) i++;
    if (c.get < 0.5) j++;
  }
  return { rows, total, share, plan };
}
