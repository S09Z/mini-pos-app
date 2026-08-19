/**
 * download.ts — hand the operator a file.
 *
 * A UTF-8 BOM is prepended because Excel on Windows otherwise reads a UTF-8
 * CSV as the local codepage, and every Thai menu name arrives as mojibake.
 * The accountant would ask a follow-up question about that, which is exactly
 * the bar Phase 3 is measured against.
 */

export function downloadText(filename: string, text: string, mime = "text/csv;charset=utf-8"): void {
  const blob = new Blob(["﻿", text], { type: mime });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Revoked on the next tick; revoking synchronously can cancel the download
  // in some browsers before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
