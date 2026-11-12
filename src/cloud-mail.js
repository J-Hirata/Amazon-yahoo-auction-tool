import nodemailer from "nodemailer";
import {randomUUID} from "node:crypto";
import {queueRegistration} from "./monitor-notifications.js";
import {NOTIFICATION_ADDRESS} from "./notification-settings.js";

export function cloudMailConfig(env = process.env) {
  const password = String(env.ASIN_GMAIL_APP_PASSWORD || "").replace(/\s/g, "");
  if (env.ASIN_GMAIL_USER !== NOTIFICATION_ADDRESS || !/^[A-Za-z]{16}$/.test(password)) throw new Error("専用のGmail送信設定を確認してください");
  return {user: NOTIFICATION_ADDRESS, password};
}
export function createCloudMailTransport(config, {createTransport = nodemailer.createTransport} = {}) {
  const make = () => createTransport({host: "smtp.gmail.com", port: 465, secure: true, auth: {user: config.user, pass: config.password},
    tls: {rejectUnauthorized: true, minVersion: "TLSv1.2"}, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false, pool: false});
  return {
    async verify() {const transport = make(); try {await transport.verify(); return true;} finally {transport.close();}},
    async send(message) {
      const transport = make();
      try {
        const result = await transport.sendMail({from: NOTIFICATION_ADDRESS, to: NOTIFICATION_ADDRESS, subject: message.subject, text: message.text,...(typeof message.html==='string'?{html:message.html}:{}),
          messageId: `<${message.attemptId}@amazon-yahoo-inventory.vercel.app>`, disableFileAccess: true, disableUrlAccess: true});
        return {status: result.accepted?.length === 1 && result.accepted[0] === NOTIFICATION_ADDRESS && !result.rejected?.length ? "smtp_accepted" : "uncertain"};
      } catch (error) {
        return {status: ["EAUTH", "EENVELOPE"].includes(error.code) || Number(error.responseCode) >= 400 ? "failed" : "uncertain"};
      } finally {transport.close();}
    }
  };
}
const testKey = "cloud-registration-test:v1";
export function createCloudMail({store, transport, now = () => new Date().toISOString()}) {
  function view(state) {
    return {...state, mailOutbox: (state.mailOutbox || []).map((record) => record.status === "sending" && Date.parse(record.lastAttemptAt) + 60000 <= Date.parse(now())
      ? {...record, status: "uncertain", error: "送信結果が不明です。受信箱を確認してください。自動再送はしません"} : record)};
  }
  async function verify({expectedRevision}) {
    await store.update((state) => {state.cloudMail = {status: "checking", checkedAt: now()};}, {expectedRevision});
    let status = "verified";
    try {await transport.verify();} catch {status = "failed";}
    await store.update((state) => {
      state.cloudMail = {status, checkedAt: now()};
      state.logs.push({at: now(), kind: "cloud_mail_verify", message: status === "verified" ? "Gmailの認証・接続を確認しました。メールは送信していません" : "Gmailの認証・接続に失敗しました。メールは送信していません"});
    });
  }
  async function test({expectedRevision, linkId, confirmed}) {
    if (confirmed !== true) throw Object.assign(new Error("宛先と1通の送信を確認してください"), {status: 400});
    const record = await store.update((state) => {
      if (state.mailOutbox?.some((entry) => entry.key === testKey)) return null;
      if (state.cloudMail?.status !== "verified") throw Object.assign(new Error("先にGmailの接続を確認してください"), {status: 409});
      if (!state.links.some((link) => link.id === linkId)) throw Object.assign(new Error("登録済みの商品を選んでください"), {status: 400});
      const planned = structuredClone(state);
      planned.notificationSettings = {...planned.notificationSettings, mailEnabled: true}; planned.mailOutbox = [];
      queueRegistration(planned, [linkId], now(), {testOnly: true});
      const result = {...planned.mailOutbox[0], key: testKey, status: "sending", attempts: 1, maxAttempts: 1, manualOnly: true, attemptId: randomUUID(), lastAttemptAt: now()};
      (state.mailOutbox ||= []).push(result);
      return structuredClone(result);
    }, {expectedRevision});
    if (!record) return {duplicate: true};
    let result;
    try {result = await transport.send(record);} catch {result = {status: "uncertain"};}
    await store.update((state) => {
      const current = state.mailOutbox.find((entry) => entry.id === record.id && entry.attemptId === record.attemptId);
      if (!current || current.status !== "sending") throw new Error("送信結果の保存を確認してください");
      current.status = ["smtp_accepted", "failed"].includes(result.status) ? result.status : "uncertain";
      current.finishedAt = now();
      current.error = current.status === "smtp_accepted" ? null : current.status === "failed" ? "Gmailが送信を受け付けませんでした。自動再送はしません" : "送信結果が不明です。受信箱を確認してください。自動再送はしません";
      state.logs.push({at: now(), kind: `cloud_mail_${current.status}`, message: current.status === "smtp_accepted" ? "Gmailがテスト1通を受け付けました。受信箱への到着は未確認です" : current.error});
    });
    return {duplicate: false};
  }
  return {verify, test, view};
}
