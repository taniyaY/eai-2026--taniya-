export interface CanonicalAddress { street: string; city: string; postalCode: string; country: string; }
export interface CanonicalCustomer { name: string; email: string; address: CanonicalAddress; }
export interface CanonicalItem { productId: string; productName: string; quantity: number; unitPrice: string; currency: string; taxRate: number; }
export type CanonicalOrderType = "standard" | "express" | "b2b";
export type CanonicalSource = "web" | "mobile" | "b2b";
export type CanonicalStatus = "new" | "processing" | "shipped" | "delivered";
export interface CanonicalOrder { orderId: string; orderType: CanonicalOrderType; source: CanonicalSource; receivedAt: string; orderDate: string; customer: CanonicalCustomer; items: CanonicalItem[]; currency: string; status: CanonicalStatus; }
