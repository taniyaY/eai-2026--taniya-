import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express, { type Request, type Response } from "express";
import axios, { AxiosError } from "axios";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { CanonicalOrder } from "./canonical-order";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

const config = {
  port: Number(process.env.ORCHESTRATOR_PORT || 3000),
  paymentUrl: process.env.PAYMENT_URL || "http://payment:4001",
  inventoryUrl: process.env.INVENTORY_URL || "http://inventory:4002",
  shippingUrl: process.env.SHIPPING_URL || "http://shipping:4003",
  notificationUrl: process.env.NOTIFICATION_URL || "http://notification:4004",
  timeout: Number(process.env.REQUEST_TIMEOUT_MS || 2500),
};
const DATA = "/data";
const IDEM = path.join(DATA, "idempotency-store.json");
const SAGA = path.join(DATA, "saga-store.json");
type TraceItem = { step: string; status: "success" | "failed" | "timeout"; startedAt: string; finishedAt: string; durationMs: number };
type State = "completed" | "failed" | "compensated";
type IdemRecord = { requestHash: string; state: "in_progress" | State; httpStatus: number; response: any; updatedAt: string };
type IdemStore = { records: Record<string, IdemRecord> };
type SagaStore = { sagas: Record<string, { idempotencyKey: string; state: State; steps: TraceItem[]; updatedAt: string }> };
function ensure(file: string, initial: unknown) { fs.mkdirSync(path.dirname(file), { recursive: true }); if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(initial, null, 2)); }
function read<T>(file: string, initial: T): T { ensure(file, initial); try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return initial; } }
function write(file: string, value: unknown) { const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); }
function now() { return new Date().toISOString(); }
function hash(value: unknown) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
const schemaPath = "/canonical/order.schema.json";
if (!fs.existsSync(schemaPath)) throw new Error(schemaPath + " missing; copy canonical/ from the repository root.");
const ajv = new Ajv({ allErrors: true }); addFormats(ajv);
const validate = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, "utf8")));
function errorMessage(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function downstreamCode(e: unknown, fallback: string): string {
  if (axios.isAxiosError(e)) return (e.response?.data as any)?.code || fallback;
  return fallback;
}
function isTimeout(e: unknown): boolean { return axios.isAxiosError(e) && (e.code === "ECONNABORTED" || e.code === "ETIMEDOUT"); }
async function callStep(trace: TraceItem[], step: string, url: string, body: unknown, orderId: string): Promise<void> {
  const start = Date.now(); const startedAt = now();
  try {
    const response = await axios.post(url, body, { timeout: config.timeout, headers: { "x-order-id": orderId, "x-correlation-id": crypto.randomUUID() } });
    const finishedAt = now(); trace.push({ step, status: "success", startedAt, finishedAt, durationMs: Date.now() - start });
    if (response.status < 200 || response.status >= 300) throw new Error("Unexpected downstream response");
  } catch (e) {
    const finishedAt = now(); trace.push({ step, status: isTimeout(e) ? "timeout" : "failed", startedAt, finishedAt, durationMs: Date.now() - start });
    throw e;
  }
}
function persistSaga(orderId: string, key: string, state: State, trace: TraceItem[]) {
  const store = read<SagaStore>(SAGA, { sagas: {} }); store.sagas[orderId] = { idempotencyKey: key, state, steps: trace, updatedAt: now() }; write(SAGA, store);
}
function persistIdem(key: string, record: IdemRecord) {
  const store = read<IdemStore>(IDEM, { records: {} }); store.records[key] = record; write(IDEM, store);
}
app.get("/health", (_req: Request, res: Response) => res.status(200).json({ status: "ok" }));
app.get("/debug/trace/:orderId", (req: Request, res: Response) => {
  const saga = read<SagaStore>(SAGA, { sagas: {} }).sagas[req.params.orderId];
  if (!saga) return res.status(404).json({ code: "not_found", message: "No saga found for this orderId" });
  return res.json(saga);
});
app.post("/checkout", async (req: Request, res: Response) => {
  const key = req.header("Idempotency-Key");
  if (!key) return res.status(400).json({ code: "validation_error", message: "Idempotency-Key header is required" });
  if (!validate(req.body)) return res.status(400).json({ code: "validation_error", message: ajv.errorsText(validate.errors) });
  const order = req.body as CanonicalOrder;
  if (order.items.length > 50) return res.status(400).json({ code: "validation_error", message: "A maximum of 50 order items is allowed" });
  const requestHash = hash(order);
  const idem = read<IdemStore>(IDEM, { records: {} });
  const existing = idem.records[key];
  if (existing) {
    if (existing.requestHash !== requestHash) return res.status(409).json({ code: "idempotency_payload_mismatch", message: "This key was already used with a different payload" });
    if (existing.state === "in_progress") return res.status(409).json({ code: "idempotency_conflict", message: "A checkout with this key is still in progress" });
    return res.status(existing.httpStatus).json(existing.response);
  }
  const inProgress: IdemRecord = { requestHash, state: "in_progress", httpStatus: 202, response: { orderId: order.orderId, status: "in_progress" }, updatedAt: now() };
  persistIdem(key, inProgress);
  const trace: TraceItem[] = [];
  const completed: Array<{ step: string; url: string; body: unknown }> = [];
  let status: State = "completed"; let httpStatus = 200; let code: string | undefined;
  const cents = order.items.reduce((sum, item) => {
    const match = /^(-?)(\d+)\.(\d{2})$/.exec(item.unitPrice);
    if (!match) throw new Error("Invalid canonical unit price");
    const amount = Number(match[2]) * 100 + Number(match[3]);
    return sum + (match[1] ? -amount : amount) * item.quantity;
  }, 0);
  const amount = (cents / 100).toFixed(2);
  const steps = [
    { step: "payment", url: config.paymentUrl + "/payment/authorize", body: { orderId: order.orderId, amount } },
    { step: "inventory", url: config.inventoryUrl + "/inventory/reserve", body: { orderId: order.orderId, items: order.items } },
    { step: "shipping", url: config.shippingUrl + "/shipping/create", body: { orderId: order.orderId } },
    { step: "notification", url: config.notificationUrl + "/notification/send", body: { orderId: order.orderId, recipient: order.customer.email } },
  ];
  try {
    for (const step of steps) {
      await callStep(trace, step.step, step.url, step.body, order.orderId);
      completed.push(step);
    }
  } catch (failure) {
    const timeout = isTimeout(failure); code = timeout ? "timeout" : downstreamCode(failure, "downstream_failure"); httpStatus = timeout ? 504 : 422;
    let compensationFailed = false;
    for (const done of completed.slice().reverse()) {
      if (done.step === "inventory") {
        try { await callStep(trace, "inventory_release", config.inventoryUrl + "/inventory/release", { orderId: order.orderId }, order.orderId); }
        catch { compensationFailed = true; }
      } else if (done.step === "payment") {
        try { await callStep(trace, "payment_refund", config.paymentUrl + "/payment/refund", { orderId: order.orderId }, order.orderId); }
        catch { compensationFailed = true; }
      }
    }
    if (compensationFailed) { status = "failed"; httpStatus = 422; code = "compensation_failed"; }
    else status = completed.length > 0 ? "compensated" : "failed";
  }
  const response: any = { orderId: order.orderId, status, trace };
  if (code) response.code = code;
  persistSaga(order.orderId, key, status, trace);
  persistIdem(key, { requestHash, state: status, httpStatus, response, updatedAt: now() });
  return res.status(httpStatus).json(response);
});
ensure(IDEM, { records: {} }); ensure(SAGA, { sagas: {} });
app.listen(config.port, () => console.log("[orchestrator] listening on " + config.port));
