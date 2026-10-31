/**
 * Minimal local Registrar contract used by `kailashe domain add`.
 *
 * NOTE(upstream): `@kailashe/deploy` exposes no `main`/`exports` in its
 * package.json (and kailashe-cloud does not declare it as a dependency), so
 * `@kailashe/deploy/registrar.js` cannot be resolved here. This mirrors the
 * structural contract in packages/deploy/src/registrar.ts (S6) so the CLI
 * builds standalone; wire the real package once its exports are fixed.
 */
export interface DomainPrice {
  currency: string;
  amount: number;
  periodYears: number;
}
export interface DomainSearchResult {
  domain: string;
  available: boolean;
  price?: DomainPrice;
  message?: string;
}
export interface RegisterDomainOptions {
  domain: string;
  periodYears?: number;
  autoRenew?: boolean;
  priceConfirmation: string;
}
export interface RegisterDomainResult {
  domain: string;
  price: DomainPrice;
  status: "registered" | "pending";
}
export interface Registrar {
  readonly provider: string;
  searchDomain(domain: string): Promise<DomainSearchResult>;
  getPrice(domain: string): Promise<DomainPrice>;
  registerDomain(opts: RegisterDomainOptions): Promise<RegisterDomainResult>;
}

let registrarEnabled = false;
export function enableRegistrar(): void { registrarEnabled = true; }
export function disableRegistrar(): void { registrarEnabled = false; }
export function isRegistrarEnabled(): boolean { return registrarEnabled; }

export function formatPriceConfirmation(price: DomainPrice): string {
  return `${price.currency} ${price.amount.toFixed(2)}`;
}
export function assertPriceConfirmation(price: DomainPrice, typed: string): void {
  const expected = formatPriceConfirmation(price);
  if (typed !== expected) {
    throw new Error(
      `Price confirmation mismatch: expected "${expected}", got "${typed}". Type the exact price to confirm the purchase.`,
    );
  }
}
