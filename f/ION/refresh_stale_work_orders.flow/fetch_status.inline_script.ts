// No browser here on purpose: the shared session cache owns the ONE login
// (f/ION/_lib/session), and every ION endpoint below is a plain cookie-authed
// GET. This step used to launch its own chromium purely to log in.
import { getOrRefreshSession, ionFetch, type IonResource } from "/f/ION/_lib/session_cache";

interface PrevResult { wo_numbers: string[]; }

function parseWoStatus(html: string): { invoice_number: string | null; schedule_status: string | null } {
  let invoice_number: string | null = null;
  let schedule_status: string | null = null;

  // Try the STATUS legend first: "STATUS: WO# 4972018 - &nbsp;INVOICE #7816722"
  const legendMatch = html.match(/STATUS:\s+WO#\s+\d+\s+-\s+(?:&nbsp;)?INVOICE\s+#(\d+)/i);
  if (legendMatch) invoice_number = legendMatch[1];

  // Fallback: "Sync Status: Synced to QuickBooks 7816722"
  if (!invoice_number) {
    const syncMatch = html.match(/Synced to QuickBooks\s+(\d+)/i);
    if (syncMatch) invoice_number = syncMatch[1];
  }

  // Schedule status from the "Status" label-value cell.
  const statusCellMatch = html.match(
    /<td[^>]*>\s*Status\s*<\/td>\s*<td[^>]*>([\s\S]{0,500}?)<\/td>/i,
  );
  if (statusCellMatch) {
    const cellText = statusCellMatch[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Longest first so "Closed - Not Invoiced" matches before "Closed".
    const known = [
      'Closed - Not Invoiced',
      'Not Scheduled',
      'Closed',
      'Scheduled',
      'Cancelled',
    ];
    for (const k of known) {
      const escaped = k.replace(/[-]/g, '\\-');
      const re = new RegExp(`(?:^|\\s)${escaped}(?:\\s|$|,)`, 'i');
      if (re.test(cellText)) { schedule_status = k; break; }
    }
  }

  return { invoice_number, schedule_status };
}

export async function main(previous_result: PrevResult, ion: IonResource) {
  const wos = previous_result.wo_numbers || [];
  if (wos.length === 0) {
    return { results: [], stats: { fetched: 0, errors: 0 } };
  }

  const session = await getOrRefreshSession(ion);
  const results: any[] = [];
  let errors = 0;

  for (const wo of wos) {
    const params = new URLSearchParams({
      id: wo,
      _cf_containerId: 'woInfo',
      _cf_nodebug: 'true',
      _cf_nocache: 'true',
    });
    if (session.cfClientId) params.set('_cf_clientid', session.cfClientId);
    const url = `${session.ionOrigin}/workorders/WOStatus.cfm?${params.toString()}`;
    try {
      const resp = await ionFetch(session, url, {
        headers: { 'Referer': `${session.ionOrigin}/main.cfm`, 'Accept': '*/*' },
      });
      const parsed = parseWoStatus(await resp.text());
      results.push({ wo_number: wo, http_status: resp.status, ...parsed });
    } catch (e: any) {
      errors++;
      results.push({ wo_number: wo, http_status: 0, invoice_number: null, schedule_status: null, error: e.message });
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return { results, stats: { fetched: results.length, errors } };
}
