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

// চলতি মাসের open month doc — না থাকলে বানায়, closed থাকলে error।
async function ensureOpenMonth(db, messId, tok) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const ref = doc(db, 'messes', messId, 'months', `${y}-${m}`);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const d = snap.data();
    if (d.status === 'closed') throw new Error('এই মাস ক্লোজ হয়ে গেছে');
    return { id: snap.id, ...d };
  }
  const data = {
    year: y,
    month: m,
    label: bnMonthLabel(y, m),
    status: 'open',
    closedAt: null,
    createdAt: Timestamp.now(),
  };
  // signup-এর সময় tok থাকে না — rules-এ months create token ছাড়াই allowed।
  await setDoc(ref, tok ? { ...data, tok } : data);
  return { id: ref.id, ...data };
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
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  batch.set(doc(db, 'messes', messId, 'months', `${y}-${m}`), {
    year: y,
    month: m,
    label: bnMonthLabel(y, m),
    status: 'open',
    closedAt: null,
    createdAt: Timestamp.now(),
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

export async function removeMember(userId) {
  const { db, me, mess } = await sessionCtx();
  requireAdmin(me);
  const tSnap = await getDoc(doc(db, 'messes', mess.id, 'users', userId));
  if (!tSnap.exists()) throw new Error('NOT_FOUND');
  const t = tSnap.data();
  if (userId === me.id) throw new Error('নিজেকে বাদ দেওয়া যাবে না');
  if (t.role === 'admin') {
    const admins = await getDocs(
      query(usersCol(db, mess.id), where('role', '==', 'admin')),
    );
    if (admins.size <= 1) throw new Error('শেষ অ্যাডমিনকে বাদ দেওয়া যাবে না');
  }

  // Cascade: ওর সেশন, জমা দেওয়া খরচ, আর ওর নামের অ্যাডভান্স মুছে দাও
  // (পুরনো SQL-এ FK cascade একই কাজ করত)।
  const batch = writeBatch(db);
  const sessQ = await getDocs(
    query(collection(db, 'sessions'), where('userId', '==', userId)),
  );
  sessQ.docs.forEach((d) => batch.delete(d.ref));
  const expQ = await getDocs(
    query(expensesCol(db, mess.id), where('submittedBy', '==', userId)),
  );
  expQ.docs.forEach((d) => batch.delete(d.ref));
  const advQ = await getDocs(
    query(advancesCol(db, mess.id), where('memberId', '==', userId)),
  );
  advQ.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(doc(db, 'messes', mess.id, 'users', userId));
  await batch.commit();
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

// ---------- monthly close ----------

export async function closeMonth() {
  const { db, token, me, mess } = await sessionCtx();
  requireAdmin(me);
  const snap = await getDocs(
    query(monthsCol(db, mess.id), where('status', '==', 'open')),
  );
  if (snap.empty) throw new Error('কোনো খোলা মাস নেই');
  const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  docs.sort((a, b) => b.year - a.year || b.month - a.month);
  const cur = docs[0];

  let ny = cur.year;
  let nm = cur.month + 1;
  if (nm > 12) {
    nm = 1;
    ny += 1;
  }
  const batch = writeBatch(db);
  batch.update(doc(db, 'messes', mess.id, 'months', cur.id), {
    status: 'closed',
    closedAt: Timestamp.now(),
    tok: token,
  });
  batch.set(doc(db, 'messes', mess.id, 'months', `${ny}-${nm}`), {
    year: ny,
    month: nm,
    label: bnMonthLabel(ny, nm),
    status: 'open',
    closedAt: null,
    createdAt: Timestamp.now(),
  });
  await batch.commit();
  return { closed: cur.label, new_month: bnMonthLabel(ny, nm) };
}

// ---------- dashboard & history ----------

export async function dashboard() {
  const { db, token, me, mess } = await sessionCtx();

  const mSnap = await getDocs(
    query(monthsCol(db, mess.id), where('status', '==', 'open')),
  );
  let month;
  if (mSnap.empty) {
    month = await ensureOpenMonth(db, mess.id, token);
  } else {
    const docs = mSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    docs.sort((a, b) => b.year - a.year || b.month - a.month);
    month = docs[0];
  }

  const [uSnap, eSnap, aSnap] = await Promise.all([
    getDocs(query(usersCol(db, mess.id), orderBy('createdAt'))),
    getDocs(query(expensesCol(db, mess.id), where('monthId', '==', month.id))),
    getDocs(query(advancesCol(db, mess.id), where('monthId', '==', month.id))),
  ]);
  const users = uSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const expenses = eSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis());
  const advances = aSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const isAdmin = me.role === 'admin';
  const visible = (e) => isAdmin || e.submittedBy === me.id;

  const members = users.map((u) => ({
    id: u.id,
    display_name: u.displayName,
    role: u.role,
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

  return {
    month: { id: month.id, label: month.label, status: month.status },
    role: me.role,
    members,
    pending: expenses
      .filter((e) => e.status === 'pending' && visible(e))
      .map(expJson),
    recent: expenses
      .filter((e) => e.status !== 'pending' && visible(e))
      .slice(0, 30)
      .map((e) => ({ ...expJson(e), status: e.status })),
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
    .sort((a, b) => b.year - a.year || b.month - a.month);
  const users = uSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const out = [];
  for (const m of months) {
    const [eSnap, aSnap] = await Promise.all([
      getDocs(query(expensesCol(db, mess.id), where('monthId', '==', m.id))),
      getDocs(query(advancesCol(db, mess.id), where('monthId', '==', m.id))),
    ]);
    const expenses = eSnap.docs.map((d) => d.data());
    const advances = aSnap.docs.map((d) => d.data());
    out.push({
      label: m.label,
      closed_at: iso(m.closedAt),
      total_expense: expenses
        .filter((e) => e.status === 'approved')
        .reduce((s, e) => s + num(e.amount), 0),
      total_advance: advances.reduce((s, a) => s + num(a.amount), 0),
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

  const batch = writeBatch(db);
  batch.update(doc(db, 'messes', messId, 'users', u.id), {
    passwordHash: await sha256Hex(newPassword),
  });
  // পুরনো সেশন বাতিল
  const sessQ = await getDocs(
    query(collection(db, 'sessions'), where('userId', '==', u.id)),
  );
  sessQ.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
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
