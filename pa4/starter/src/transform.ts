import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { XMLParser } from "fast-xml-parser";

export interface Address {
  street: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface CanonicalCustomer {
  name: string;
  email: string;
  address: Address;
}

export interface CanonicalItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: string;
  currency: string;
  taxRate: number;
}

export type OrderStatus = "new" | "processing" | "shipped" | "delivered";

export interface CanonicalOrder {
  orderId: string;
  orderType: "standard" | "express" | "b2b";
  source: "web" | "mobile" | "b2b";
  receivedAt: string;
  orderDate: string;
  customer: CanonicalCustomer;
  items: CanonicalItem[];
  currency: string;
  status: OrderStatus;
}

export type TransformWarningCode = "UNKNOWN_PRODUCT" | "PRICING_API_ERROR";

export interface TransformWarning {
  code: TransformWarningCode;
  productId: string;
  message: string;
}

export interface TransformResult {
  order: CanonicalOrder | null;
  warnings: TransformWarning[];
}

export interface TranslateOptions {
  pricingBaseUrl: string;
  apiKey?: string;
  now?: () => Date;
}

export interface WebOrderInput {
  orderId: string;
  orderType: string;
  customer: {
    name: string;
    email: string;
    address: Address;
    payment?: unknown;
  };
  items: Array<{ productId: string; productName: string; quantity: number }>;
  orderDate: string;
  status: string;
  currency: string;
}

export interface MobileOrderInput {
  oid: string;
  ot: string;
  cust_name: string;
  cust_email: string;
  addr: string;
  items: Array<{ pid: string; pname: string; qty: number }>;
  ts: number;
  st: number;
  cur: number;
  pm?: string;
  pan?: string;
  pexp?: string;
}

export interface ParsedB2BOrder {
  PurchaseOrder: {
    "@_orderId": string;
    "@_orderType": string;
    "@_orderDate": string;
    BuyerParty: {
      Name: string;
      ContactEmail: string;
      ShipToAddress: {
        "@_country": string;
        Street: string;
        City: string;
        PostalCode: string;
      };
      [key: string]: unknown;
    };
    LineItems: {
      "@_currency": string;
      LineItem: unknown;
    };
    Status: string;
    [key: string]: unknown;
  };
}

export type EnrichResult =
  | { status: "ok"; unitPrice: string; currency: string; taxRate: number; productName: string }
  | { status: "unknown_product" }
  | { status: "error"; httpStatus: number };

export const DEFAULT_PRICING_API_KEY = "pa4-pricing-key-2026";

const PA4_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const DEFAULT_WEB_ORDER_PATH = path.join(PA4_ROOT, "data", "web-order.json");
export const DEFAULT_MOBILE_ORDER_PATH = path.join(PA4_ROOT, "data", "mobile-order.json");
export const DEFAULT_B2B_ORDER_PATH = path.join(PA4_ROOT, "data", "b2b-order.xml");
export const DEFAULT_PRICING_BASE_URL = "http://localhost:4100";

const OUT_DIR = path.join(PA4_ROOT, "out");
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

export function normalizeProductId(
  source: "web" | "mobile" | "b2b",
  rawId: string,
): string {
  if (source === "web") return rawId;
  if (source === "mobile") return `PROD-${rawId}`;
  return rawId.startsWith("SKU-") ? rawId.slice(4) : rawId;
}

export function toDecimalAmount(price: number): string {
  return price.toFixed(2);
}

export async function enrichFromPricing(
  productId: string,
  options: TranslateOptions,
): Promise<EnrichResult> {
  const baseUrl = options.pricingBaseUrl.replace(/\/$/, "");
  const apiKey = options.apiKey ?? DEFAULT_PRICING_API_KEY;

  try {
    const response = await fetch(
      `${baseUrl}/pricing/${encodeURIComponent(productId)}`,
      { headers: { "X-API-Key": apiKey } },
    );

    if (response.status === 404) {
      return { status: "unknown_product" };
    }

    if (!response.ok) {
      return { status: "error", httpStatus: response.status };
    }

    const body = (await response.json()) as {
      unitPrice: number;
      currency: string;
      taxRate: number;
      productName: string;
    };

    return {
      status: "ok",
      unitPrice: toDecimalAmount(body.unitPrice),
      currency: body.currency,
      taxRate: body.taxRate,
      productName: body.productName,
    };
  } catch {
    return { status: "error", httpStatus: 0 };
  }
}

export async function enrichItems(
  lines: Array<{ productId: string; productName: string; quantity: number }>,
  options: TranslateOptions,
): Promise<{ items: CanonicalItem[]; warnings: TransformWarning[] }> {
  const items: CanonicalItem[] = [];
  const warnings: TransformWarning[] = [];

  for (const line of lines) {
    const pricing = await enrichFromPricing(line.productId, options);

    if (pricing.status === "ok") {
      items.push({
        productId: line.productId,
        productName: line.productName,
        quantity: line.quantity,
        unitPrice: pricing.unitPrice,
        currency: pricing.currency,
        taxRate: pricing.taxRate,
      });
      continue;
    }

    if (pricing.status === "unknown_product") {
      warnings.push({
        code: "UNKNOWN_PRODUCT",
        productId: line.productId,
        message: `No price was found for ${line.productId}; the item was omitted.`,
      });
      continue;
    }

    warnings.push({
      code: "PRICING_API_ERROR",
      productId: line.productId,
      message: `Pricing lookup for ${line.productId} failed with HTTP status ${pricing.httpStatus}; the item was omitted.`,
    });
  }

  return { items, warnings };
}

export function epochSecondsToIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

export function mapCurrencyCode(numericCode: number): string {
  const currencies: Record<number, string> = {
    978: "EUR",
    840: "USD",
    826: "GBP",
  };

  const value = currencies[numericCode];
  if (!value) {
    throw new Error(`Unsupported currency code: ${numericCode}`);
  }
  return value;
}

export function mapMobileStatus(code: number): OrderStatus {
  const statuses: Record<number, OrderStatus> = {
    1: "new",
    2: "processing",
    3: "shipped",
    4: "delivered",
  };

  const value = statuses[code];
  if (!value) {
    throw new Error(`Unsupported mobile status: ${code}`);
  }
  return value;
}

export function mapB2BStatus(raw: string): OrderStatus {
  const value = raw.toLowerCase();
  if (
    value !== "new" &&
    value !== "processing" &&
    value !== "shipped" &&
    value !== "delivered"
  ) {
    throw new Error(`Unsupported B2B status: ${raw}`);
  }
  return value;
}

export function parseMobileAddress(addr: string): Address {
  const parts = addr.split(",").map((part) => part.trim());

  if (parts.length !== 4) {
    throw new Error("Mobile address must contain street, city, postal code, and country");
  }

  const [street, city, postalCode, country] = parts;
  return { street, city, postalCode, country };
}

export function decodeB2BXmlBytes(bytes: Buffer): string {
  return new TextDecoder("windows-1257").decode(bytes);
}

function receivedAt(options: TranslateOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

function asOrderType(value: string): CanonicalOrder["orderType"] {
  if (value === "standard" || value === "express" || value === "b2b") {
    return value;
  }
  throw new Error(`Unsupported order type: ${value}`);
}

function asStatus(value: string): OrderStatus {
  if (
    value === "new" ||
    value === "processing" ||
    value === "shipped" ||
    value === "delivered"
  ) {
    return value;
  }
  throw new Error(`Unsupported status: ${value}`);
}

export async function translateWeb(
  webOrderPath: string,
  options: TranslateOptions,
): Promise<TransformResult> {
  const source = JSON.parse(readFileSync(webOrderPath, "utf8")) as WebOrderInput;

  const lines = source.items.map((item) => ({
    productId: normalizeProductId("web", item.productId),
    productName: item.productName,
    quantity: item.quantity,
  }));

  const enriched = await enrichItems(lines, options);
  if (enriched.items.length === 0) {
    return { order: null, warnings: enriched.warnings };
  }

  const order: CanonicalOrder = {
    orderId: source.orderId,
    orderType: asOrderType(source.orderType),
    source: "web",
    receivedAt: receivedAt(options),
    orderDate: new Date(source.orderDate).toISOString(),
    customer: {
      name: source.customer.name,
      email: source.customer.email,
      address: {
        street: source.customer.address.street,
        city: source.customer.address.city,
        postalCode: source.customer.address.postalCode,
        country: source.customer.address.country,
      },
    },
    items: enriched.items,
    currency: source.currency,
    status: asStatus(source.status),
  };

  return { order, warnings: enriched.warnings };
}

export async function translateMobile(
  mobileOrderPath: string,
  options: TranslateOptions,
): Promise<TransformResult> {
  const source = JSON.parse(readFileSync(mobileOrderPath, "utf8")) as MobileOrderInput;

  const lines = source.items.map((item) => ({
    productId: normalizeProductId("mobile", item.pid),
    productName: item.pname,
    quantity: item.qty,
  }));

  const enriched = await enrichItems(lines, options);
  if (enriched.items.length === 0) {
    return { order: null, warnings: enriched.warnings };
  }

  const order: CanonicalOrder = {
    orderId: source.oid,
    orderType: asOrderType(source.ot),
    source: "mobile",
    receivedAt: receivedAt(options),
    orderDate: epochSecondsToIso(source.ts),
    customer: {
      name: source.cust_name,
      email: source.cust_email,
      address: parseMobileAddress(source.addr),
    },
    items: enriched.items,
    currency: mapCurrencyCode(source.cur),
    status: mapMobileStatus(source.st),
  };

  return { order, warnings: enriched.warnings };
}

export async function translateB2B(
  b2bOrderPath: string,
  options: TranslateOptions,
): Promise<TransformResult> {
  const bytes = readFileSync(b2bOrderPath);
  const parsed = xmlParser.parse(decodeB2BXmlBytes(bytes)) as ParsedB2BOrder;
  const source = parsed.PurchaseOrder;
  const buyer = source.BuyerParty;
  const address = buyer.ShipToAddress;

  const rawLineItems = source.LineItems.LineItem;
  const lineItems = Array.isArray(rawLineItems) ? rawLineItems : [rawLineItems];

  const lines = lineItems.map((raw) => {
    const item = raw as Record<string, unknown>;
    return {
      productId: normalizeProductId("b2b", String(item["@_sku"])),
      productName: String(item.Description),
      quantity: Number(item["@_quantity"]),
    };
  });

  const enriched = await enrichItems(lines, options);
  if (enriched.items.length === 0) {
    return { order: null, warnings: enriched.warnings };
  }

  const order: CanonicalOrder = {
    orderId: source["@_orderId"],
    orderType: asOrderType(source["@_orderType"]),
    source: "b2b",
    receivedAt: receivedAt(options),
    orderDate: new Date(source["@_orderDate"]).toISOString(),
    customer: {
      name: buyer.Name,
      email: buyer.ContactEmail,
      address: {
        street: address.Street,
        city: address.City,
        postalCode: address.PostalCode,
        country: address["@_country"],
      },
    },
    items: enriched.items,
    currency: source.LineItems["@_currency"],
    status: mapB2BStatus(source.Status),
  };

  return { order, warnings: enriched.warnings };
}

export async function main(): Promise<void> {
  const options: TranslateOptions = {
    pricingBaseUrl: DEFAULT_PRICING_BASE_URL,
  };

  const results = {
    web: await translateWeb(DEFAULT_WEB_ORDER_PATH, options),
    mobile: await translateMobile(DEFAULT_MOBILE_ORDER_PATH, options),
    b2b: await translateB2B(DEFAULT_B2B_ORDER_PATH, options),
  };

  mkdirSync(OUT_DIR, { recursive: true });

  for (const [name, result] of Object.entries(results)) {
    const outPath = path.join(OUT_DIR, `${name}.json`);
    writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");
    console.log(`wrote ${outPath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
