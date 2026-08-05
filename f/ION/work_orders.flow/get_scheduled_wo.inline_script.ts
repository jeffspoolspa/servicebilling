// No browser here on purpose: the shared session cache owns the ONE login
// (f/ION/_lib/session), and both report fetches below are plain cookie-authed
// GETs. This step used to launch its own chromium purely to log in.
import { getOrRefreshSession, ionFetch, type IonResource } from "/f/ION/_lib/session_cache";
import { parse } from "node-html-parser";
import { mkdir } from "fs/promises";

function toIsoDate(dateStr: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  const parts = dateStr.split('/');
  if (parts.length === 3) return `${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}`;
  return new Date(dateStr).toISOString().split('T')[0];
}

export async function main(
  ion: IonResource,
  wo_status_1: string,
  wo_status_2: string,
  start_date?: string
) {
  const isoStartDate = start_date ? toIsoDate(start_date) : '';

  console.log('========================================');
  console.log('WORK ORDERS - TWO-STEP FETCH');
  console.log(`ScheduleStart: ${isoStartDate}`);
  console.log('========================================');

  try {
    console.log('\nSTEP 1: SESSION');
    const session = await getOrRefreshSession(ion);
    const { ionOrigin, cfClientId } = session;
    console.log(`  ION: ${ionOrigin}`);
    console.log(`  _cf_clientid: ${cfClientId || 'NONE'}`);

    await mkdir('./shared', { recursive: true });

    console.log('\nSTEP 2: FETCH REPORT PICKER');
    const pickerParams = new URLSearchParams({
      Office: '',
      Technician: '',
      ScheduleStart: isoStartDate,
      ScheduleEnd: '',
      WOType: '',
      WOTemplate: '',
      WOStatus: '',
      ScheduleStatus: '',
      ApprovalStatus: '',
      CreatedStart: '',
      CreatedEnd: '',
      CompletedStart: '',
      CompletedEnd: '',
      _cf_containerId: 'rptDetail',
      _cf_nodebug: 'true',
      _cf_nocache: 'true',
      _cf_rc: '1',
    });
    if (cfClientId) pickerParams.set('_cf_clientid', cfClientId);

    const pickerUrl = `${ionOrigin}/reports/woReports.cfm?${pickerParams.toString()}`;
    console.log(`  picker URL: ${pickerUrl.substring(0, 120)}...`);

    const pickerRes = await ionFetch(session, pickerUrl);
    const pickerResult = { ok: pickerRes.ok, status: pickerRes.status, body: await pickerRes.text() };

    console.log(`  picker status: ${pickerResult.status}`);
    if (!pickerResult.ok) throw new Error(`Picker returned HTTP ${pickerResult.status}`);

    const pickerRoot = parse(pickerResult.body);
    const allLinks = pickerRoot.querySelectorAll('a');
    console.log(`  total links on picker: ${allLinks.length}`);
    
    let downloadHref: string | null = null;
    for (const link of allLinks) {
      const href = link.getAttribute('href') || '';
      const text = link.text.trim();
      console.log(`  link: text="${text}" href="${href.substring(0, 100)}"`);
      if (href.includes('WorkOrderDetail') && !downloadHref) {
        downloadHref = href;
      }
    }

    if (!downloadHref) {
      console.log('  NO WorkOrderDetail link found. Saving picker HTML...');
      await Bun.write('./shared/picker_page.html', pickerResult.body);
      throw new Error('No WorkOrderDetail.cfm link found on picker page');
    }

    console.log(`  download link found: ${downloadHref.substring(0, 120)}...`);

    const reportDataUrl = downloadHref.startsWith('http') ? downloadHref : `${ionOrigin}${downloadHref.startsWith('/') ? '' : '/reports/'}${downloadHref}`;
    console.log(`  full report URL: ${reportDataUrl.substring(0, 140)}...`);

    console.log('\nSTEP 3: FETCH REPORT DATA');

    const reportResult = await (async () => {
      try {
        const res = await ionFetch(session, reportDataUrl);
        const body = await res.text();
        return { ok: res.ok, status: res.status, contentType: res.headers.get('content-type'), bodyLength: body.length, body, error: undefined as string | undefined };
      } catch (err: any) {
        return { ok: false, status: 0, contentType: null, bodyLength: 0, body: '', error: err.message };
      }
    })();

    console.log(`  status: ${reportResult.status}`);
    console.log(`  content-type: ${reportResult.contentType}`);
    console.log(`  body length: ${reportResult.bodyLength}`);
    if (reportResult.error) console.log(`  ERROR: ${reportResult.error}`);

    if (!reportResult.ok) {
      console.log(`  body preview: ${reportResult.body.substring(0, 500)}`);
      throw new Error(`Report data returned HTTP ${reportResult.status}`);
    }

    await Bun.write('./shared/raw_report.html', reportResult.body);
    console.log('  saved raw_report.html');

    console.log('\nSTEP 4: PARSE');
    const root = parse(reportResult.body);

    const allTables = root.querySelectorAll('table');
    console.log(`  tables found: ${allTables.length}`);

    let dataTable = null;
    for (const t of allTables) {
      if (t.toString().includes('WO #') || t.toString().includes('WO#')) {
        dataTable = t;
        console.log('  found data table via WO # header');
        break;
      }
    }
    if (!dataTable && allTables.length > 0) {
      let maxRows = 0;
      for (const t of allTables) {
        const c = t.querySelectorAll('tr').length;
        if (c > maxRows) { maxRows = c; dataTable = t; }
      }
      console.log(`  using largest table (${maxRows} rows)`);
    }

    if (!dataTable) {
      console.log(`  response preview: ${reportResult.body.substring(0, 2000)}`);
      throw new Error('No data table found in report');
    }

    const rows = dataTable.querySelectorAll('tr');
    const rawData = rows.map((row: any) => {
      const cells = row.querySelectorAll('td, th');
      return cells.map((cell: any) => cell.text.trim());
    });

    console.log(`  total rows: ${rawData.length}`);
    for (let i = 0; i < Math.min(rawData.length, 6); i++) {
      console.log(`  row[${i}] (${rawData[i].length} cells): ${JSON.stringify(rawData[i].slice(0, 5))}...`);
    }

    const report1Path = './shared/report_1.json';
    await Bun.write(report1Path, JSON.stringify({ status: wo_status_1, raw_table: rawData }, null, 2));

    const dataRowCount = Math.max(0, rawData.length - 4);
    console.log(`\nSUCCESS - ${dataRowCount} data rows`);

    return {
      success: true,
      method: 'direct_http_fetch_two_step',
      report_1: { status: wo_status_1, filepath: report1Path, row_count: rawData.length },
      data_row_count: dataRowCount,
      report_data_url: reportDataUrl,
    };

  } catch (error: any) {
    console.log(`\nFATAL: ${error.message}`);
    console.log(error.stack);
    throw error;
  }
}