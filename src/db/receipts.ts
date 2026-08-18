/**
 * receipts.ts — sequential, offline-safe receipt numbering.
 *
 * Numbers are generated locally (device prefix + monotonic counter, e.g.
 * "A-1043") inside a Dexie read-write transaction, so two terminals on the
 * same network can never collide and a receipt number can never be issued
 * twice even if the tab crashes mid-sale.
 */

import { db, type DeviceConfigRecord } from "./schema.js";

export class ReceiptNumberError extends Error {
  override readonly name = "ReceiptNumberError";
}

export async function nextReceiptNumber(): Promise<string> {
  return db.transaction("rw", db.device_config, async () => {
    const device: DeviceConfigRecord | undefined = await db.device_config.get("device");
    if (!device) throw new ReceiptNumberError("Device config missing — run seedIfEmpty() first");

    const seq = device.nextReceiptSeq;
    await db.device_config.put({ ...device, nextReceiptSeq: seq + 1 });
    return `${device.receiptPrefix}-${seq}`;
  });
}
