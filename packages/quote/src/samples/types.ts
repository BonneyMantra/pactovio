export interface SampleFile {
  id: string;
  workspace_id: string;
  kind: string;
  title: string;
  issuer: string | null;
  scope: string | null;
  valid_to: string | null;
  filename: string;
  mime: string;
  bytes: Uint8Array;
  /** Text per page (null for a pure image such as the scanned certificate). */
  pages: string[][] | null;
  meta: Record<string, unknown>;
}

export const SAMPLE_LABEL = 'Sample company (fictional)';
export const pdfMime = 'application/pdf';
export const r2KeyFor = (workspaceId: string, filename: string) => `samples/${workspaceId}/${filename}`;
