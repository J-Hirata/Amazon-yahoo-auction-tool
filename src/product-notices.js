import {createHash} from 'node:crypto';
import {productAlertContext} from './product-alert-context.js';
import {recurringNotice, noticeSchedule} from './product-notice-policy.js';
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || '');
const fail = (message, status = 400) => Object.assign(new Error(message), {status});

export function createProductNotices({overview, watchStore, now = () => new Date().toISOString()}) {
  async function view() {
    const input = await overview.inputs(), at = now(), context = productAlertContext(input, at);
    const notices = context.alerts.filter(a => recurringNotice(a) && context.conditions[a.id] !== false).map(a => ({
      id: a.id, title: a.title, asin: a.asin, category: a.category, key: a.key, at: a.at,
      summary: a.mailDetails || null, message: a.message, current: context.conditions[a.id],
      ...noticeSchedule(a, input.monitor, input.watch, at),
    }));
    return {revision: input.revision, checkedAt: at, intervalDays: 3, enabled: Boolean(input.watch.noticePolicy), notices};
  }
  async function commit(command, {expectedRevision, actor}) {
    if (!command || !uuid(command.operationId) || !uuid(command.alertId) || typeof command.stopped !== 'boolean' || Object.keys(command).some(k => !['operationId', 'alertId', 'stopped'].includes(k))) throw fail('再案内の操作内容を確認してください');
    const digest = createHash('sha256').update(JSON.stringify([command.alertId, command.stopped])).digest('hex');
    const saved = await watchStore.readSnapshot(), receipt = saved.state.noticeReceipts?.find(r => r.id === command.operationId);
    if (receipt) {
      if (receipt.actor !== actor || receipt.digest !== digest) throw fail('同じ操作IDの内容が異なります', 409);
      return view();
    }
    const context = productAlertContext(await overview.inputs(), now());
    if (!context.alerts.some(a => a.id === command.alertId && recurringNotice(a)) || context.conditions[command.alertId] === false) throw fail('この案内は解消または変更されています。一覧を更新してください', 409);
    await watchStore.update(state => {
      const existing = state.noticeReceipts?.find(r => r.id === command.operationId);
      if (existing) {if (existing.actor !== actor || existing.digest !== digest) throw fail('同じ操作IDの内容が異なります', 409); return;}
      if (!state.pendingAlerts?.some(a => a.id === command.alertId)) throw fail('案内が更新されています', 409);
      if ((state.noticeReceipts?.length || 0) >= 10000) throw fail('操作履歴の保存上限を確認してください', 409);
      const quantity=context.alerts.find(a=>a.id===command.alertId)?.mailDetails?.quantity?.quantity;
      const priorQuantity=state.noticeControls?.[command.alertId]?.quantityWhenStopped;
      (state.noticeControls ||= {})[command.alertId] = {stopped: command.stopped, at: now(), actor,...(Number.isSafeInteger(quantity)&&quantity>=0?{quantityWhenStopped:quantity}:Number.isSafeInteger(priorQuantity)?{quantityWhenStopped:priorQuantity}:{})};
      (state.noticeReceipts ||= []).push({id: command.operationId, digest, actor, at: now()});
    }, {expectedRevision});
    return view();
  }
  return {view, commit};
}
