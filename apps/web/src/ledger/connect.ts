import type Transport from "@ledgerhq/hw-transport";
import AppEth from "@ledgerhq/hw-app-eth";
import { getBluetoothServiceUuids } from "@ledgerhq/devices";

export type LedgerTransportKind = "hid" | "ble";
export type LedgerPathScheme = "ledger-live" | "legacy";

export function derivationPath(accountIndex: number, scheme: LedgerPathScheme = "ledger-live"): string {
  if (scheme === "ledger-live") {
    return `44'/60'/${accountIndex}'/0/0`;
  }
  return `44'/60'/0'/0/${accountIndex}`;
}

export async function createLedgerTransport(kind: LedgerTransportKind): Promise<Transport> {
  if (kind === "hid") {
    const { default: WebHID } = await import("@ledgerhq/hw-transport-webhid");
    return WebHID.create();
  }
  const { default: BLE } = await import("@ledgerhq/hw-transport-web-ble");
  const { bluetooth } = navigator;
  if (!bluetooth) {
    throw new Error("Web Bluetooth is not available in this browser.");
  }
  const filters = getBluetoothServiceUuids().map(uuid => ({ services: [uuid] }));
  const device = await bluetooth.requestDevice({ filters });
  return BLE.open(device);
}

/**
 * Scan derivation paths on an already-open AppEth to find the path
 * that produces `targetAddress`. Tries both Ledger Live and Legacy
 * schemes across account indices 0-4. Silent (no on-device display).
 */
export async function findAddressPath(
  app: AppEth,
  targetAddress: string,
): Promise<{ path: string; scheme: LedgerPathScheme; accountIndex: number } | null> {
  const target = targetAddress.toLowerCase();
  const schemes: LedgerPathScheme[] = ["ledger-live", "legacy"];
  for (const scheme of schemes) {
    for (let i = 0; i < 5; i++) {
      const p = derivationPath(i, scheme);
      const { address } = await app.getAddress(p, false, false);
      if (address.toLowerCase() === target) {
        return { path: p, scheme, accountIndex: i };
      }
    }
  }
  return null;
}

export async function getLedgerEthApp(
  transport: Transport,
  accountIndex = 0,
  scheme: LedgerPathScheme = "ledger-live",
): Promise<{
  app: AppEth;
  address: `0x${string}`;
  path: string;
}> {
  const app = new AppEth(transport);
  const path = derivationPath(accountIndex, scheme);
  const r = await app.getAddress(path, true, false);
  return { app, address: r.address as `0x${string}`, path };
}
