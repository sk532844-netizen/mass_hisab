import { supabase } from './supabase';

const getToken = () => localStorage.getItem('mh_token');

async function call(fn, args = {}) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

// ---- public (no session) ----
export const signupAdmin = ({ messName, username, password, displayName }) =>
  call('app_signup_admin', {
    p_mess_name: messName, p_username: username,
    p_password: password, p_display_name: displayName,
  });

export const login = (joinCode, username, password) =>
  call('app_login', {
    p_join_code: joinCode, p_username: username, p_password: password,
  });

// ---- authed ----
const authed = (fn, args = {}) => call(fn, { p_token: getToken(), ...args });

export const logout = () => authed('app_logout').catch(() => {});
export const dashboard = () => authed('app_dashboard');
export const monthHistory = () => authed('app_month_history');
export const members = () => authed('app_members');
export const addMember = (username, password, displayName) =>
  authed('app_add_member', {
    p_username: username, p_password: password, p_display_name: displayName,
  });
export const removeMember = (userId) =>
  authed('app_remove_member', { p_user_id: userId });
export const resetMemberPassword = (userId, newPassword) =>
  authed('app_reset_member_password', { p_user_id: userId, p_new_password: newPassword });
export const submitExpense = (amount, category, note) =>
  authed('app_submit_expense', {
    p_amount: amount, p_category: category, p_note: note,
  });
export const reviewExpense = (expenseId, approve, note) =>
  authed('app_review_expense', {
    p_expense_id: expenseId, p_approve: approve, p_note: note,
  });
export const recordAdvance = (memberId, amount, note) =>
  authed('app_record_advance', {
    p_member_id: memberId, p_amount: amount, p_note: note,
  });
export const closeMonth = () => authed('app_close_month');
export const getRecoveryCode = () => authed('app_get_recovery_code');
export const resetPasswordSelf = (joinCode, username, recoveryCode, newPassword) =>
  call('app_reset_password_self', {
    p_join_code: joinCode, p_username: username,
    p_recovery_code: recoveryCode, p_new_password: newPassword,
  });

export const CATEGORIES = ['বাজার', 'ভাড়া', 'ইউটিলিটি', 'যাতায়াত', 'অন্যান্য'];

// ---- হিসাব helpers ----
export const fmt = (n) =>
  '৳' + Number(n || 0).toLocaleString('bn-BD', { maximumFractionDigits: 0 });

export function settle(members) {
  const total = members.reduce((s, m) => s + Number(m.paid), 0);
  const share = members.length ? total / members.length : 0;
  const rows = members.map((m) => {
    const contributed = Number(m.paid) + Number(m.advance);
    return { ...m, contributed, share, balance: contributed - share };
  });
  const debtors = rows.filter((r) => r.balance < -0.5)
    .map((r) => ({ ...r, owe: -r.balance })).sort((a, b) => b.owe - a.owe);
  const creditors = rows.filter((r) => r.balance > 0.5)
    .map((r) => ({ ...r, get: r.balance })).sort((a, b) => b.get - a.get);
  const plan = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i], c = creditors[j];
    const amt = Math.min(d.owe, c.get);
    plan.push({ from: d.display_name, to: c.display_name, amount: Math.round(amt) });
    d.owe -= amt; c.get -= amt;
    if (d.owe < 0.5) i++;
    if (c.get < 0.5) j++;
  }
  return { rows, total, share, plan };
}
