export const NOTICE_INTERVAL_DAYS = 3;
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
export const noticeDay = value => validTime(value) ? new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 10) : null;
export function addNoticeDays(day, days = NOTICE_INTERVAL_DAYS) {
  return new Date(Date.parse(day + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
export function activateNoticePolicy(watch, at, baselineQuantities = {}) {
  if (!validTime(at)) throw new Error('再案内の開始日時を確認してください');
  watch.noticePolicy ||= {version: 1, intervalDays: NOTICE_INTERVAL_DAYS, enabledAt: at,...(Object.keys(baselineQuantities).length?{baselineQuantities}:{} )};
  return watch.noticePolicy;
}
export function validateNoticePolicy(watch) {
  const fail = () => { throw Object.assign(new Error('再案内の保存形式を確認してください'), {status: 400}); };
  const policy = watch.noticePolicy;
  if (policy && (policy.version !== 1 || policy.intervalDays !== NOTICE_INTERVAL_DAYS || !validTime(policy.enabledAt))) fail();
  if(policy?.baselineQuantities!==undefined&&(!policy.baselineQuantities||Array.isArray(policy.baselineQuantities)||Object.keys(policy.baselineQuantities).length>5000||Object.entries(policy.baselineQuantities).some(([id,n])=>!uuid(id)||!Number.isSafeInteger(n)||n<0||n>1000000)))fail();
  if (watch.noticeControls !== undefined) {
    if (!watch.noticeControls || Array.isArray(watch.noticeControls) || typeof watch.noticeControls !== 'object' || Object.keys(watch.noticeControls).length > 5000) fail();
    for (const [id, control] of Object.entries(watch.noticeControls)) if (!uuid(id) || !control || typeof control.stopped !== 'boolean' || !validTime(control.at) || control.quantityWhenStopped!==undefined&&(!Number.isSafeInteger(control.quantityWhenStopped)||control.quantityWhenStopped<0)) fail();
  }
  if (watch.noticeReceipts !== undefined && (!Array.isArray(watch.noticeReceipts) || watch.noticeReceipts.length > 10000 || watch.noticeReceipts.some(r => !uuid(r.id) || !/^[a-f0-9]{64}$/.test(r.digest || '') || !validTime(r.at)))) fail();
  return watch;
}
export function recurringNotice(alert) {
  return /^(low-stock:|fba-zero:|replenish:|yahoo-ended:|action-|review-)/.test(alert.key || '');
}
export function noticeSchedule(alert, monitor, watch, at) {
  const records = (monitor.mailOutbox || []).filter(m => m.kind === 'product_alerts' && m.alertIds?.includes(alert.id));
  const seen = new Set();
  const accepted = records.filter((m, i) => {
    const id = m.id || String(i);
    if (m.status !== 'smtp_accepted' || seen.has(id)) return false;
    seen.add(id); return true;
  });
  const dates = accepted.map(m => m.finishedAt).filter(validTime).sort();
  const lastSentAt = dates.at(-1) || null;
  const deliveredCount = accepted.length;
  const stopped = watch.noticeControls?.[alert.id]?.stopped === true;
  const blocked = records.some(m => m.status === 'uncertain' || m.status === 'sending' || ['failed','cancelled'].includes(m.status) && m.attempts >= 3 && (m.noticeNumbers?.[alert.id]||1)===deliveredCount+1) || deliveredCount > 0 && (!lastSentAt || Date.parse(lastSentAt) > Date.parse(at) + 60000);
  const enabledOn = noticeDay(watch.noticePolicy?.enabledAt), today = noticeDay(at);
  // Old incidents start their new reminder window at activation, rather than
  // becoming an immediate catch-up mailing. Receipts are never rewritten.
  const baseline = lastSentAt && enabledOn ? [noticeDay(lastSentAt), enabledOn].sort().at(-1) : null;
  const nextOn = deliveredCount && baseline ? addNoticeDays(baseline) : null;
  const isReminder = deliveredCount > 0;
  return {deliveredCount, notificationNumber: deliveredCount + 1, isReminder, lastSentAt, nextOn, stopped, blocked,
    eligible: !stopped && !blocked && (isReminder ? recurringNotice(alert) && Boolean(enabledOn && nextOn && today >= nextOn) : !alert.queuedAt)};
}
export function dueProductNotices(watch, monitor, at, states) {
  return (watch.pendingAlerts || []).filter(alert => !alert.dismissedAt && states[alert.id] === true).map(alert => ({...alert, ...noticeSchedule(alert, monitor, watch, at)})).filter(alert => alert.eligible);
}
